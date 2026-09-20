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

// ---- 時計：ストリームの「0 フレーム目の時刻（µs）」。届く遅れは足される方向にしか揺れないので、
//      いちばん早く届いた札（ts − 累計フレーム/レート の最小）が原点にいちばん近い。ずっと更新し続ける ----
function makeClock() { return { off: null, count: 0 }; }
function clockFeed(clk, ts, framesBefore, rate) {
  const cand = ts - framesBefore / rate * 1e6;
  clk.off = clk.off == null ? cand : Math.min(clk.off, cand);
  clk.count++;
}
const mainClock = makeClock();

// ---- 脇の録り ----
const side = {
  reader: null, running: false, rate: 0, frames: 0, clock: makeClock(),
  ring: [],                 // 直近の札 [{start, samples(mono)}]（約 1 秒）
  recording: false, startIdx: 0, stopIdx: Infinity,
  pend: [], pendFrames: 0, buf: null, filled: 0,
  base: null,
  pendingStart: null,       // 時計がまだ無いうちに来た開始時刻（最初の札が届いたら始める）
};
function sideReset() {
  side.frames = 0; side.clock = makeClock(); side.ring = []; side.base = null;
  side.recording = false; side.pend = []; side.pendFrames = 0; side.filled = 0;
  side.pendingStart = null;
}

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
    sideReset();
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
      if (m.side && side.running) sideBegin(mainTime(core.totalFrames + (m.trimFrames | 0), rate));
      else if (side.recording) sideEnd(mainTime(core.totalFrames, rate));
    } else {
      if (side.recording) sideEnd(mainTime(core.totalFrames, rate));
      core.command(m);
    }
    return;
  }
  if (m.cmd === 'debug') {   // 開発時の覗き穴
    const rate = lastRate || 48000;
    post({ type: 'debug', ring: !!(core && core.ring), filled: core ? core.ringFilled : -1, cap: core ? core.prerollCapacity : -1, channels: core ? core.channels : -1, recording: !!(core && core.recording),
      mainOff: mainClock.off, mainFrames: core ? core.totalFrames : -1, mainNow: core ? mainTime(core.totalFrames, rate) : null,
      sideOff: side.clock.off, sideFrames: side.frames, sideRate: side.rate, sideNow: side.clock.off == null ? null : side.clock.off + side.frames / side.rate * 1e6,
      sideRecording: side.recording, sideStart: side.startIdx, sideStop: side.stopIdx, sideRing: side.ring.length, sideRunning: side.running });
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
          if (err < -threshold) { base = { ts: frame.timestamp, frames: 0 }; Object.assign(mainClock, makeClock()); }   // 早く届きすぎ＝時計が飛んだ。測り直す
        }
        base.frames += n;
      }
      if (typeof frame.timestamp === 'number') clockFeed(mainClock, frame.timestamp, core.totalFrames, rate);
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

/** 本線のフレーム番号 → 時刻（µs）。時計がまだ無ければ null。 */
function mainTime(frames, rate) {
  return mainClock.off == null ? null : mainClock.off + frames / rate * 1e6;
}

function sideBegin(tUs) {
  if (tUs == null) { side.recording = false; return; }
  if (side.clock.off == null) { side.pendingStart = tUs; return; }   // 繋いだ直後：最初の札を待って始める
  side.pendingStart = null;
  side.startIdx = Math.round((tUs - side.clock.off) * side.rate / 1e6);
  side.stopIdx = Infinity;
  side.recording = true;
  side.pend = []; side.pendFrames = 0; side.filled = 0;
  if (!side.buf) side.buf = new Float32Array(4096);
  // 届いていた札のうち、開始時刻より後ろのぶんを拾う
  for (const f of side.ring) sideTake(f);
  side.ring = [];
}

function sideEnd(tUs) {
  if (side.pendingStart != null) { side.pendingStart = null; post({ type: 'side-data', end: true, sampleRate: side.rate }); return; }
  if (!side.recording) return;
  side.stopIdx = tUs == null ? side.frames : Math.round((tUs - side.clock.off) * side.rate / 1e6);
  if (side.frames >= side.stopIdx) sideFinish();
}

function sideFinish() {
  side.recording = false;
  sideFlush(true);
}

function sideTake(f) {
  const a = Math.max(f.start, side.startIdx), b = Math.min(f.start + f.samples.length, side.stopIdx);
  if (b <= a) return;
  const seg = f.samples.subarray(a - f.start, b - f.start);
  let p = 0;
  while (p < seg.length) {
    const room = side.buf.length - side.filled;
    const k = Math.min(room, seg.length - p);
    side.buf.set(seg.subarray(p, p + k), side.filled);
    side.filled += k; p += k;
    if (side.filled >= side.buf.length) sideFlush(false);
  }
}

function sideFlush(final) {
  if (side.filled > 0) {
    const out = side.buf.slice(0, side.filled);
    side.filled = 0;
    post({ type: 'side-data', samples: out, frames: out.length, channels: 1, sampleRate: side.rate, end: false }, [out.buffer]);
  }
  if (final) post({ type: 'side-data', end: true, sampleRate: side.rate });
}

async function sideStop() {
  side.running = false;
  try { if (side.reader) await side.reader.cancel(); } catch { }
  side.reader = null;
  if (side.recording) sideFinish();
}

async function sideLoop() {
  let mono = new Float32Array(4096), plane = new Float32Array(4096);
  while (side.running) {
    const { value: frame, done } = await side.reader.read();
    if (done || !side.running) break;
    try {
      const ch = frame.numberOfChannels, n = frame.numberOfFrames, rate = frame.sampleRate;
      if (side.rate !== rate) { side.rate = rate; sideReset(); }
      if (plane.length < n) { plane = new Float32Array(n); mono = new Float32Array(n); }
      // 左右をひとつに（平均）。値は変えない
      const out = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) out[i] += plane[i] / ch;
      }
      // 抜けた札は無音で埋める（時計を保つ）
      if (typeof frame.timestamp === 'number') {
        if (!side.base) side.base = { ts: frame.timestamp, frames: 0 };
        const expected = side.base.ts + side.base.frames / rate * 1e6;
        const err = frame.timestamp - expected;
        const frameUs = n / rate * 1e6;
        if (err > 3 * frameUs) {
          const gap = Math.min(Math.round(err * rate / 1e6), rate * 2);
          const fill = { start: side.frames, samples: new Float32Array(gap) };
          side.frames += gap; side.base.frames += gap;
          if (side.recording) sideTake(fill); else side.ring.push(fill);
        } else if (err < -3 * frameUs) {
          side.base = { ts: frame.timestamp, frames: 0 };
        }
        side.base.frames += n;
        clockFeed(side.clock, frame.timestamp, side.frames, rate);
        if (side.pendingStart != null && side.clock.off != null) sideBegin(side.pendingStart);
      }
      const f = { start: side.frames, samples: out };
      side.frames += n;
      if (side.recording) {
        sideTake(f);
        if (side.frames >= side.stopIdx) sideFinish();
      } else {
        side.ring.push(f);
        while (side.ring.length > 120) side.ring.shift();
      }
    } finally {
      frame.close();
    }
  }
}
