/*
  生フレーム取得。MediaStreamTrackProcessor（WebCodecs）でマイクのトラックから
  AudioData を直接読む。AudioContext を通らないので、
    ・機器（ブラウザが受け取っている）のレートのまま届く（再標本化ゼロ）
    ・チャンネル数もそのまま
    ・音声スレッドの 128 フレーム刻みに縛られない
  Chrome / Edge で使える。無いブラウザでは worklets.js の道に戻る。

  録れた音は CaptureCore がブロックにまとめて外へ渡す。加工はしない。
  さらに、届いたフレーム数と実時間を並べて控え、機器のクロックが実時間に対して
  どれだけ速い／遅いか（ドリフト）を外で計算できるようにする。

  脇の録り（keyboard のアプリ音）もここで受ける。AudioData.timestamp はマイクも脇も同じ時計で
  付くので、マイクの「録音開始のフレーム」と同じ時刻の脇のフレームから切り出せば、
  2 つの経路（Worker と AudioContext）の遅れの違いに左右されず、標本の単位で揃う。
  時計の原点は「最初の 1 秒の中でいちばん早く届いた札」で決める（届く遅れは足される方向にしか揺れない）。
*/

import { CaptureCore } from './capture-core.js';
import { StreamClock, SideCutter } from './side-align.js';

let core = null;
let reader = null;
let running = false;
let planes = [];
let lastRate = 0, lastChannels = 0;
let base = null;         // 累計フレームと timestamp の基準点（ずれが続けば落ちている）
let jitter = 0, over = 0;
let lostFrames = 0, gapCount = 0;
let clockSince = 0;      // 最後に時計を渡した時刻（ドリフト計算用）

const post = (m, transfer) => self.postMessage(m, transfer || []);

const mainClock = new StreamClock();

// ---- 脇の録り（側の札を受け、本線の合図と同じ時刻で切る。中身は side-align.js） ----
const side = { reader: null, running: false, cutter: new SideCutter(post) };

self.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'start') {
    core = new CaptureCore(post, { channels: m.channels || 1, blockFrames: 4096, tapFrames: 1024 });
    reader = m.readable.getReader();
    running = true;
    clockSince = 0;
    base = null; jitter = 0; over = 0; lostFrames = 0; gapCount = 0;
    readLoop().catch(err => post({ type: 'error', message: String(err && err.message || err) }));
    return;
  }
  if (m.cmd === 'stop') {
    running = false;
    try { if (reader) await reader.cancel(); } catch { }
    reader = null;
    return;
  }
  if (m.cmd === 'side') {           // 脇の録りの入口（readable を受け取る）
    await sideStop();
    side.cutter.reset(); side.cutter.rate = 0;
    side.reader = m.readable.getReader();
    side.running = true;
    sideLoop().catch(err => post({ type: 'side-error', message: String(err && err.message || err) }));
    return;
  }
  if (m.cmd === 'side-stop') { await sideStop(); return; }
  if (m.cmd === 'record' && core) {
    // 本線の合図と同じ時刻で脇も切る（trim ぶん先の時刻から）
    const rate = lastRate || 48000;
    if (m.on) {
      core.command(m);
      if (m.side && side.running) side.cutter.begin(mainClock.timeOf(core.totalFrames + (m.trimFrames | 0), rate));
      else side.cutter.end(mainClock.timeOf(core.totalFrames, rate));
    } else {
      side.cutter.end(mainClock.timeOf(core.totalFrames, rate));
      core.command(m);
    }
    return;
  }
  if (m.cmd === 'debug') {   // 開発時の覗き穴
    const rate = lastRate || 48000;
    post({ type: 'debug', ring: !!(core && core.ring), filled: core ? core.ringFilled : -1, cap: core ? core.prerollCapacity : -1, channels: core ? core.channels : -1, recording: !!(core && core.recording),
      mainOff: mainClock.off, mainFrames: core ? core.totalFrames : -1, mainNow: core ? mainClock.timeOf(core.totalFrames, rate) : null,
      sideOff: side.cutter.clock.off, sideFrames: side.cutter.frames, sideRate: side.cutter.rate, sideNow: side.cutter.clock.timeOf(side.cutter.frames, side.cutter.rate || rate),
      sideRecording: side.cutter.recording, sideStart: side.cutter.startIdx, sideStop: side.cutter.stopIdx, sideRing: side.cutter.ring.length, sideRunning: side.running });
    return;
  }
  if (core) core.command(m);
};

async function readLoop() {
  const t0 = performance.now();
  while (running) {
    const { value: frame, done } = await reader.read();
    if (done || !running) break;
    try {
      const ch = frame.numberOfChannels;
      const n = frame.numberOfFrames;
      const rate = frame.sampleRate;

      if (planes.length !== ch || planes[0].length < n) {
        planes = [];
        for (let c = 0; c < ch; c++) planes.push(new Float32Array(Math.max(n, 4096)));
      }
      // f32-planar で受け取る。元が整数形式でも、ここで float に直すだけで値は変えない
      for (let c = 0; c < ch; c++) {
        frame.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' });
      }
      const views = planes.map(p => p.subarray(0, n));

      // 最初の1枚と、レートやチャンネル数が変わったとき（機器の差し替えなど）は外に知らせる
      if (rate !== lastRate || ch !== lastChannels) {
        lastRate = rate; lastChannels = ch;
        base = null; over = 0;
        post({ type: 'format', sampleRate: rate, channels: ch });
      }

      // 落ちたフレーム：届いたフレーム数の累計と timestamp を比べる。
      // 1枚ごとの timestamp は数 ms ゆれる（届いた時刻で付く）ので、1枚の差では判断しない。
      // 「累計のずれ」が、ゆれの幅を超えて 5 枚続いたときだけ本物の穴とみなす。
      if (typeof frame.timestamp === 'number') {
        if (!base) base = { ts: frame.timestamp, frames: 0 };
        const expected = base.ts + base.frames / rate * 1e6;
        const err = frame.timestamp - expected;                     // µs。正なら音が足りない
        const frameUs = n / rate * 1e6;
        jitter = jitter * 0.95 + Math.abs(err) * 0.05;
        const threshold = Math.max(1.5 * frameUs, 4 * jitter);
        if (err > threshold) {
          if (++over >= 5) {
            const gapFrames = Math.round(err * rate / 1e6);
            const fill = Math.min(gapFrames, rate * 2);            // 2 秒を超える穴は、機器が止まっていたとみなして埋めない
            lostFrames += gapFrames; gapCount++; over = 0;
            core.pushSilence(fill);
            base.frames += gapFrames;
            post({ type: 'gap', frames: gapFrames, filled: fill, atFrame: core.totalFrames - fill, recording: core.recording, lostFrames, gapCount });
          }
        } else {
          over = 0;
          if (err < -threshold) { base = { ts: frame.timestamp, frames: 0 }; mainClock.reset(); }   // 早く届きすぎ＝時計が飛んだ。測り直す
        }
        base.frames += n;
      }
      if (typeof frame.timestamp === 'number') mainClock.feed(frame.timestamp, core.totalFrames, rate);
      core.push(views, n, { sampleRate: rate });

      // ドリフト用の時計。1 秒ごとに「実時間・累計フレーム」の対を外へ渡す
      const now = performance.now();
      if (now - clockSince >= 1000) {
        clockSince = now;
        post({ type: 'clock', t: now - t0, frames: core.totalFrames, sampleRate: rate });
      }
    } finally {
      frame.close();
    }
  }
  if (core) core.flush(true);
  post({ type: 'stopped' });
}


/* ================= 脇の録り ================= */

async function sideStop() {
  side.running = false;
  try { if (side.reader) await side.reader.cancel(); } catch { }
  side.reader = null;
  side.cutter.close();
}

async function sideLoop() {
  let plane = new Float32Array(4096);
  while (side.running) {
    const { value: frame, done } = await side.reader.read();
    if (done || !side.running) break;
    try {
      const ch = frame.numberOfChannels, n = frame.numberOfFrames, rate = frame.sampleRate;
      if (plane.length < n) plane = new Float32Array(n);
      // 左右をひとつに（平均）。値は変えない
      const out = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) out[i] += plane[i] / ch;
      }
      side.cutter.feed(out, typeof frame.timestamp === 'number' ? frame.timestamp : null, rate);
    } finally {
      frame.close();
    }
  }
}
