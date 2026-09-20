/*
  自己検証。既知の合成信号を入れて、理論値と合うかを確かめる。
  デスクトップ版の --selftest（変換の無劣化）／--atest（解析の校正）／
  --etest（編集と後処理）にあたる。

  マイクは使わない。OfflineAudioContext で鳴らさずに測る。
*/

import { encodeWav, decodeWav, SaveFormat, quantize, resetDither } from './wav.js';
import * as Quality from './quality.js';
import * as Sweep from './sweep.js';
import * as MicCal from './miccal.js';
import { encodeFlac, decodeFlacWithBrowser } from './flac.js';
import * as Analysis from './analysis.js';
import * as Meter from './meterscale.js';
import * as Edit from './edit.js';
import * as Wave from './waveform.js';
import { truePeakOf, CaptureCore } from './capture-core.js';
import * as Reverb from './reverb.js';
import * as Finish from './finish.js';
import { newFinish } from './model.js';

const RATE = 48000;

/* ---------------- 測るための小物 ---------------- */

/** ゲルツェル法。その周波数にある正弦波の振幅を返す。 */
function goertzel(x, freq, rate, from = 0, len = x.length - from) {
  const k = 2 * Math.PI * freq / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let n = 0; n < len; n++) {
    const s0 = x[from + n] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return 2 * Math.sqrt(Math.max(0, power)) / len;
}

const db = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);

function sine(freq, seconds, amp = 0.5, rate = RATE, channels = 1) {
  const frames = Math.round(seconds * rate);
  const s = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin(2 * Math.PI * freq * i / rate);
    for (let c = 0; c < channels; c++) s[i * channels + c] = v;
  }
  return { samples: s, frames, channels, sampleRate: rate, seconds: frames / rate };
}

function join(parts) {
  const channels = parts[0].channels, rate = parts[0].sampleRate;
  let total = 0;
  for (const p of parts) total += p.samples.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p.samples, o); o += p.samples.length; }
  const frames = out.length / channels;
  return { samples: out, frames, channels, sampleRate: rate, seconds: frames / rate };
}

function rmsOf(x, from = 0, len = x.length - from) {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += x[from + i] * x[from + i];
  return Math.sqrt(sum / len);
}

/* ---------------- 検証の枠 ---------------- */

const results = [];
let currentSection = null;

function section(title) {
  currentSection = { title, rows: [] };
  results.push(currentSection);
}

function check(name, expected, actualText, ok) {
  currentSection.rows.push({ name, expected, actual: actualText, ok });
  return ok;
}

function render() {
  const host = document.querySelector('#results');
  host.innerHTML = '';
  let pass = 0, fail = 0;

  for (const sec of results) {
    const h = document.createElement('h2');
    h.textContent = sec.title;
    host.appendChild(h);

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>調べたこと</th><th>期待</th><th>実測</th><th>判定</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');
    for (const r of sec.rows) {
      if (r.ok) pass++; else fail++;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td class="v"></td><td class="v"></td><td class="r"></td>';
      tr.children[0].textContent = r.name;
      tr.children[1].textContent = r.expected;
      tr.children[2].textContent = r.actual;
      tr.children[3].textContent = r.ok ? 'OK' : 'NG';
      tr.children[3].className = 'r ' + (r.ok ? 'ok' : 'ng');
      body.appendChild(tr);
    }
    host.appendChild(table);
  }

  const sum = document.querySelector('#summary');
  sum.hidden = false;
  sum.classList.toggle('ng', fail > 0);
  sum.textContent = fail === 0
    ? `全 ${pass} 項目に通りました。`
    : `${pass} 項目に通り、${fail} 項目で外れました。`;
}

const step = (t) => { document.querySelector('#progress').textContent = t; };
const wait = () => new Promise(r => setTimeout(r, 0));

/* ================= ① 変換の無劣化 ================= */

async function testConversion() {
  section('① 変換の無劣化（--selftest）');

  // 24bit の全域を一定間隔で並べ、24bit → float32 → 24bit の往復で戻るかを見る
  const n = 200000;
  const src = new Int32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.round(-8388608 + i * (16777215 / (n - 1)));
  const asFloat = new Float32Array(n);
  for (let i = 0; i < n; i++) asFloat[i] = src[i] / 8388608;

  const wav = encodeWav(asFloat, 1, RATE, SaveFormat.Pcm24);
  const back = decodeWav(await wav.arrayBuffer());
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    const restored = Math.round(back.samples[i] * 8388608);
    if (restored !== src[i]) mismatch++;
  }
  check('24bit PCM → float32 → 24bit PCM の往復', '不一致 0 サンプル', `不一致 ${mismatch} サンプル`, mismatch === 0);

  // float32 は 1.0 を超えた値も保つ（0 dBFS を超えても後から下げれば救える）
  const over = new Float32Array([1.7, -2.35, 0.5, 1.0000001]);
  const wav32 = encodeWav(over, 1, RATE, SaveFormat.Float32);
  const back32 = decodeWav(await wav32.arrayBuffer());
  let same = true;
  for (let i = 0; i < over.length; i++) if (back32.samples[i] !== over[i]) same = false;
  check('float32 は 1.0 を超える値も保つ', `${over.join(' / ')}`,
    `${Array.from(back32.samples).join(' / ')}`, same);

  // 24bit では 1.0 超は頭打ちになる（仕様どおり）
  const clamped = quantize(new Float32Array([1.5, -1.5]), SaveFormat.Pcm24);
  check('24bit では 1.0 超が頭打ちになる', '+0.9999999 / -1.0',
    `${clamped[0].toFixed(7)} / ${clamped[1].toFixed(7)}`,
    Math.abs(clamped[0] - 0.9999999) < 1e-6 && clamped[1] === -1);

  // ヘッダが壊れた（長さ 0 の）ファイルからも音を取り戻せる
  const good = encodeWav(sine(1000, 0.5).samples, 1, RATE, SaveFormat.Float32);
  const buf = await good.arrayBuffer();
  new DataView(buf).setUint32(40, 0, true);          // data の長さを 0 に壊す
  const repaired = decodeWav(buf);
  check('壊れた WAV ヘッダから音を取り戻す', '24000 フレーム',
    `${repaired.frames} フレーム`, repaired.frames === 24000);

  await wait();
}

/* ================= ② 解析の数値校正 ================= */

async function testAnalysis() {
  section('② 解析の数値校正（--atest）');

  // 振幅 0.5 の 1kHz。ピークは -6.02 dBFS、RMS は -9.03 dBFS が理論値。
  const tone = sine(1000, 2.0, 0.5);
  const r = Analysis.analyzeChannel(tone.samples, 0, RATE);
  check('ピーク（振幅 0.5 の正弦波）', '-6.0 dBFS', `${r.peakDb.toFixed(2)} dBFS`, Math.abs(r.peakDb + 6.02) < 0.1);
  check('RMS（振幅 0.5 の正弦波）', '-9.0 dBFS', `${r.rmsDb.toFixed(2)} dBFS`, Math.abs(r.rmsDb + 9.03) < 0.1);

  const band1k = r.bands.find(b => b.centerHz === 1000);
  check('1/3オクターブ 1kHz 帯の高さ', '-6.0 dB', `${band1k.db.toFixed(2)} dB`, Math.abs(band1k.db + 6.02) < 0.5);
  const band100 = r.bands.find(b => b.centerHz === 100);
  check('鳴っていない 100Hz 帯', '-80 dB より下', `${band100.db.toFixed(1)} dB`, band100.db < -80);

  // ホワイトノイズ -60 dBFS RMS → 実効ビット深度の理論値
  const noiseFrames = RATE * 2;
  const noise = new Float32Array(noiseFrames);
  let acc = 0;
  for (let i = 0; i < noiseFrames; i++) { const v = (Math.random() * 2 - 1) * 0.0017; noise[i] = v; acc += v * v; }
  const noiseRms = Math.sqrt(acc / noiseFrames);
  const nr = Analysis.analyzeChannel(noise, 0, RATE);
  const expectBits = ((-3.01 - db(noiseRms)) - 1.76) / 6.02;
  check('ノイズフロアの RMS', `${db(noiseRms).toFixed(1)} dBFS`, `${nr.rmsDb.toFixed(1)} dBFS`,
    Math.abs(nr.rmsDb - db(noiseRms)) < 0.2);
  check('実効ビット深度', `${expectBits.toFixed(1)} bit`, `${nr.effectiveBits.toFixed(1)} bit`,
    Math.abs(nr.effectiveBits - expectBits) < 0.1);

  // 直流オフセット
  const dcSig = new Float32Array(RATE);
  for (let i = 0; i < RATE; i++) dcSig[i] = 0.01 + 0.1 * Math.sin(2 * Math.PI * 440 * i / RATE);
  const dr = Analysis.analyzeChannel(dcSig, 0, RATE);
  check('直流オフセットの検出', '0.0100', dr.dcOffset.toFixed(4), Math.abs(dr.dcOffset - 0.01) < 0.0005);

  // クリップの数
  const clipped = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) clipped[i] = i < 7 ? 1.0 : 0.1;
  const cr = Analysis.analyzeChannel(clipped, 0, RATE);
  check('クリップの数', '7 サンプル', `${cr.clipCount} サンプル`, cr.clipCount === 7);

  // 電源ハム：50Hz を暗騒音より 30 dB 高く混ぜる
  const humFrames = RATE * 2;
  const hum = new Float32Array(humFrames);
  for (let i = 0; i < humFrames; i++) {
    hum[i] = 0.02 * Math.sin(2 * Math.PI * 50 * i / RATE) + (Math.random() * 2 - 1) * 0.0006;
  }
  const hr = Analysis.analyzeChannel(hum, 0, RATE);
  check('電源ハムの周波数', '50 Hz', `${hr.humHz.toFixed(0)} Hz`, hr.humHz === 50);
  check('電源ハムの高さ', '-34.0 dB 付近', `${hr.humDb.toFixed(1)} dB`, Math.abs(hr.humDb + 33.98) < 1.0);
  check('ハムが暗騒音より高いこと', '+20 dB 以上', `+${hr.humOverFloorDb.toFixed(0)} dB`, hr.humOverFloorDb > 20);

  // あり得ない静けさの警告
  const tooQuiet = new Float32Array(RATE * 2);
  for (let i = 0; i < tooQuiet.length; i++) tooQuiet[i] = (Math.random() * 2 - 1) * 1e-7;
  const notes = Analysis.advise([Analysis.analyzeChannel(tooQuiet, 0, RATE)], true);
  check('あり得ない静けさを警告する', '⚠ で始まる所見', notes[0] ? notes[0].slice(0, 12) + '…' : '（なし）',
    !!notes[0] && notes[0].startsWith('⚠'));

  await wait();
}

/* ================= ③ メーターの目盛り ================= */

async function testMeter() {
  section('③ メーターの目盛り');
  check('−12 dBFS の位置', '0.620', Meter.ratio(-12).toFixed(3), Math.abs(Meter.ratio(-12) - 0.62) < 1e-9);
  check('−6 dBFS の位置', '0.810', Meter.ratio(-6).toFixed(3), Math.abs(Meter.ratio(-6) - 0.81) < 1e-9);
  check('0 dBFS の位置', '1.000', Meter.ratio(0).toFixed(3), Meter.ratio(0) === 1);
  check('−60 dBFS 以下の位置', '0.000', Meter.ratio(-70).toFixed(3), Meter.ratio(-70) === 0);
  const width = Meter.GoodTo - Meter.GoodFrom;
  const expect = Meter.ratio(Meter.GoodToDb) - Meter.ratio(Meter.GoodFromDb);
  check('「ちょうどいい」帯（−18〜−8）の幅', expect.toFixed(3), width.toFixed(3), Math.abs(width - expect) < 1e-9 && Meter.GoodFromDb === -18 && Meter.GoodToDb === -8);

  // 波形の dB 目盛り：−60 dBFS で中心、0 dBFS で枠いっぱい
  check('波形の目盛り 0 dBFS', '1.000', Wave.toScale(1).toFixed(3), Math.abs(Wave.toScale(1) - 1) < 1e-6);
  check('波形の目盛り −30 dBFS', '0.500', Wave.toScale(Math.pow(10, -30 / 20)).toFixed(3),
    Math.abs(Wave.toScale(Math.pow(10, -30 / 20)) - 0.5) < 1e-3);
  check('波形の目盛り −60 dBFS', '0.000', Wave.toScale(Math.pow(10, -60 / 20)).toFixed(3),
    Math.abs(Wave.toScale(Math.pow(10, -60 / 20))) < 1e-3);
  await wait();
}

/* ================= ④ 編集（切り出し・パンチイン） ================= */

async function testEdit() {
  section('④ 編集（--etest）');

  // 440 / 880 / 220 Hz を1秒ずつ
  const original = join([sine(440, 1), sine(880, 1), sine(220, 1)]);

  // 切り出し：1.0〜2.0 秒を取れば 880Hz だけになる
  const cropped = Edit.crop(original, 1.0, 2.0);
  check('切り出しの長さ', '1.000 秒', cropped.seconds.toFixed(3), Math.abs(cropped.seconds - 1) < 0.001);
  const a880 = goertzel(cropped.samples, 880, RATE, 4800, 24000);
  const a440 = goertzel(cropped.samples, 440, RATE, 4800, 24000);
  check('切り出した中身は 880Hz', '880Hz が 440Hz より 40dB 以上大きい',
    `880: ${db(a880).toFixed(1)} / 440: ${db(a440).toFixed(1)} dB`, db(a880) - db(a440) > 40);

  // パンチイン：1.0 秒の位置に 660Hz を 1 秒ぶん差し替える
  const punched = Edit.punchIn(original, sine(660, 1), 1.0);
  check('差し替え後の長さ', '3.000 秒', punched.seconds.toFixed(3), Math.abs(punched.seconds - 3) < 0.002);

  const at = (t, f) => db(goertzel(punched.samples, f, RATE, Math.round(t * RATE), 12000));
  check('0.5 秒あたり（元のまま）', '440Hz が主', `440: ${at(0.3, 440).toFixed(1)} / 660: ${at(0.3, 660).toFixed(1)} dB`,
    at(0.3, 440) - at(0.3, 660) > 40);
  check('1.5 秒あたり（差し替えた所）', '660Hz が主', `660: ${at(1.3, 660).toFixed(1)} / 880: ${at(1.3, 880).toFixed(1)} dB`,
    at(1.3, 660) - at(1.3, 880) > 40);
  check('2.5 秒あたり（元へ戻る）', '220Hz が主', `220: ${at(2.3, 220).toFixed(1)} / 660: ${at(2.3, 660).toFixed(1)} dB`,
    at(2.3, 220) - at(2.3, 660) > 40);

  // 継ぎ目の不連続。1サンプルあたりの跳ねが、素の波形の最大変化量に収まっていること。
  const maxStepOf = (x, from, len) => {
    let m = 0;
    for (let i = from + 1; i < from + len; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return m;
  };
  const naturalStep = 0.5 * 2 * Math.PI * 880 / RATE;   // いちばん高い 880Hz の最大傾き
  const joinStep = Math.max(
    maxStepOf(punched.samples, Math.round(0.995 * RATE), Math.round(0.02 * RATE)),
    maxStepOf(punched.samples, Math.round(1.995 * RATE), Math.round(0.02 * RATE)));
  check('継ぎ目に段差が無い', `${naturalStep.toFixed(4)} 以下`, joinStep.toFixed(4), joinStep <= naturalStep * 1.05);

  // クロスフェードの長さ
  check('クロスフェード長', '5 ms', `${(Edit.CROSSFADE_SECONDS * 1000).toFixed(0)} ms`,
    Math.abs(Edit.CROSSFADE_SECONDS - 0.005) < 1e-9);

  // 波形データの粒度
  const w = Wave.build(original);
  check('波形データの粒度', `${Wave.FRAMES_PER_BUCKET} フレーム/山谷`,
    `${(original.frames / w.bucketCount).toFixed(1)} フレーム/山谷`,
    Math.abs(original.frames / w.bucketCount - Wave.FRAMES_PER_BUCKET) < 1);

  await wait();
}

/* ================= ⑤ 後処理（ハム除去・ノイズゲート） ================= */

async function renderThrough(audio, build) {
  const ctx = new OfflineAudioContext(1, audio.frames, audio.sampleRate);
  await ctx.audioWorklet.addModule('js/worklets.js');
  const buffer = ctx.createBuffer(1, audio.frames, audio.sampleRate);
  buffer.getChannelData(0).set(audio.samples);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const last = build(ctx, src);
  last.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

async function testProcessing() {
  section('⑤ 後処理（ハム除去・ノイズゲート）');

  // 50Hz のハムと 1kHz の楽音を混ぜ、ハムだけが削れることを見る
  const frames = RATE * 3;
  const mixed = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    mixed[i] = 0.2 * Math.sin(2 * Math.PI * 50 * i / RATE) + 0.3 * Math.sin(2 * Math.PI * 1000 * i / RATE);
  }
  const input = { samples: mixed, frames, channels: 1, sampleRate: RATE, seconds: 3 };

  const out = await renderThrough(input, (ctx, src) => {
    let node = src;
    for (let h = 1; h <= 4; h++) {
      const notch = ctx.createBiquadFilter();
      notch.type = 'notch';
      notch.frequency.value = 50 * h;
      notch.Q.value = 30;
      node.connect(notch);
      node = notch;
    }
    return node;
  });

  // 過渡応答を避けて、後半だけで測る
  const from = RATE, len = RATE;
  const hum0 = goertzel(mixed, 50, RATE, from, len);
  const hum1 = goertzel(out, 50, RATE, from, len);
  const tone0 = goertzel(mixed, 1000, RATE, from, len);
  const tone1 = goertzel(out, 1000, RATE, from, len);

  const humCut = db(hum0) - db(hum1);
  const toneChange = db(tone1) - db(tone0);
  check('ハム除去の減衰量（50Hz）', '20 dB 以上', `${humCut.toFixed(1)} dB 減衰`, humCut > 20);
  check('1kHz の楽音への影響', '±0.5 dB 以内', `${toneChange >= 0 ? '+' : ''}${toneChange.toFixed(2)} dB`,
    Math.abs(toneChange) < 0.5);

  // ノイズゲート：演奏部（1秒）＋無音部（2秒・−80 dBFS の暗騒音）
  const gFrames = RATE * 3;
  const gate = new Float32Array(gFrames);
  for (let i = 0; i < gFrames; i++) {
    const noise = (Math.random() * 2 - 1) * 0.0001;
    gate[i] = i < RATE ? 0.5 * Math.sin(2 * Math.PI * 440 * i / RATE) + noise : noise;
  }
  const gOut = await renderThrough(
    { samples: gate, frames: gFrames, channels: 1, sampleRate: RATE, seconds: 3 },
    (ctx, src) => {
      const node = new AudioWorkletNode(ctx, 'tm-gate', {
        numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
        processorOptions: { thresholdDb: -60 },
      });
      src.connect(node);
      return node;
    });

  const playIn = rmsOf(gate, Math.round(0.2 * RATE), Math.round(0.6 * RATE));
  const playOut = rmsOf(gOut, Math.round(0.2 * RATE), Math.round(0.6 * RATE));
  const quietIn = rmsOf(gate, Math.round(2.0 * RATE), Math.round(0.8 * RATE));
  const quietOut = rmsOf(gOut, Math.round(2.0 * RATE), Math.round(0.8 * RATE));

  const playChange = db(playOut) - db(playIn);
  const quietCut = db(quietIn) - db(quietOut);
  check('ゲート：演奏部の変化', '±0.5 dB 以内', `${playChange >= 0 ? '+' : ''}${playChange.toFixed(2)} dB`,
    Math.abs(playChange) < 0.5);
  check('ゲート：無音部の減衰', '20 dB 以上', `${quietCut.toFixed(1)} dB 減衰`, quietCut > 20);

  await wait();
}

/* ================= ⑥ まとめて書き出す ================= */

async function testMixdown() {
  section('⑥ まとめて書き出す');

  const session = {
    id: 'test', name: 'test', sampleRate: RATE, finish: newFinish(),
    tracks: [
      makeTrack('t1', 440, 1),
      makeTrack('t2', 1000, 1),
    ],
  };
  const audios = new Map([
    ['a1', sine(440, 1, 0.3)],
    ['a2', sine(1000, 1, 0.3)],
  ]);
  const loadTake = async (take) => audios.get(take.audioId);

  const mix = await Edit.mixdown(session, loadTake);
  check('まとめた長さ', '1.000 秒', mix.seconds.toFixed(3), Math.abs(mix.seconds - 1) < 0.002);
  check('ステレオになる', '2ch', `${mix.channels}ch`, mix.channels === 2);

  const left = new Float32Array(mix.frames);
  for (let i = 0; i < mix.frames; i++) left[i] = mix.samples[i * 2];
  const a440 = goertzel(left, 440, RATE, 2400, 24000);
  const a1k = goertzel(left, 1000, RATE, 2400, 24000);
  check('両方のトラックが入っている', '440Hz・1kHz とも -11 dB 付近',
    `440: ${db(a440).toFixed(1)} / 1k: ${db(a1k).toFixed(1)} dB`,
    Math.abs(db(a440) + 10.46) < 1.0 && Math.abs(db(a1k) + 10.46) < 1.0);

  // 消音したトラックは出ない
  session.tracks[1].muted = true;
  const mix2 = await Edit.mixdown(session, loadTake);
  const left2 = new Float32Array(mix2.frames);
  for (let i = 0; i < mix2.frames; i++) left2[i] = mix2.samples[i * 2];
  const b1k = goertzel(left2, 1000, RATE, 2400, 24000);
  check('消音したトラックは出ない', '-80 dB より下', `${db(b1k).toFixed(1)} dB`, db(b1k) < -80);

  // 単独にすると、そのトラックだけになる
  session.tracks[1].muted = false;
  session.tracks[1].soloed = true;
  const mix3 = await Edit.mixdown(session, loadTake);
  const left3 = new Float32Array(mix3.frames);
  for (let i = 0; i < mix3.frames; i++) left3[i] = mix3.samples[i * 2];
  const c440 = goertzel(left3, 440, RATE, 2400, 24000);
  const c1k = goertzel(left3, 1000, RATE, 2400, 24000);
  check('単独にしたトラックだけが鳴る', '1kHz だけ残る',
    `440: ${db(c440).toFixed(1)} / 1k: ${db(c1k).toFixed(1)} dB`, db(c1k) - db(c440) > 60);

  await wait();
}

function makeTrack(id, freq, seconds) {
  void freq; void seconds;
  return {
    id, name: id, volume: 1, muted: false, soloed: false, activeTakeIndex: 0,
    takes: [{ id: id + '_k', name: '1回目の録り', audioId: id === 't1' ? 'a1' : 'a2', seconds: 1, sampleRate: RATE, channels: 1 }],
    processing: { humEnabled: false, humFrequency: 50, humHarmonics: 4, gateEnabled: false, gateThresholdDb: -60, reverbSend: 1 },
  };
}


/* ================= ⑦ 割れの見張りと、届いた値の素性 ================= */

async function testPeaks() {
  section('⑦ True Peak・平らな頭・届いたビット数・L/R の時間差');

  // True Peak：低い音ではサンプル値と一致し、高い音ではサンプルの間が見える
  const s440 = sine(440, 1, 0.5);
  const t1 = truePeakOf(s440.samples, 1);
  check('440Hz の True Peak はサンプル値と一致', '0.500 ± 0.002', t1.truePeak.toFixed(4), Math.abs(t1.truePeak - 0.5) < 0.002);

  // 11.025kHz を 44.1k で標本化すると 4 サンプルで1周。位相をずらすとサンプルは頂点を外す
  const rate = 44100, n = rate;
  const hi = new Float32Array(n);
  for (let i = 0; i < n; i++) hi[i] = 0.9 * Math.sin(2 * Math.PI * 11025 * i / rate + Math.PI / 4);
  const t2 = truePeakOf(hi, 1);
  check('頂点を外して標本化した正弦波', 'サンプル値 0.636 / True Peak 0.9 付近',
    `サンプル ${t2.samplePeak.toFixed(3)} / True ${t2.truePeak.toFixed(3)}`,
    Math.abs(t2.samplePeak - 0.6364) < 0.01 && t2.truePeak > 0.85 && t2.truePeak < 0.95);

  // 平らな頭：0.98 で切り落とした波は 1.0 に届かないが割れている
  const clipped = new Float32Array(48000);
  for (let i = 0; i < clipped.length; i++) {
    const v = 1.3 * Math.sin(2 * Math.PI * 440 * i / RATE);
    clipped[i] = Math.max(-0.98, Math.min(0.98, v));
  }
  const t3 = truePeakOf(clipped, 1);
  check('0.98 で頭が平らになった波を数える', '440 回以上（正負で 880）', String(t3.flats), t3.flats >= 800);
  const t4 = truePeakOf(s440.samples, 1);
  check('素の正弦波を平らと誤認しない', '0', String(t4.flats), t4.flats === 0);

  // 届いたビット数：16bit の刻みに丸めた音は 16 と見抜く
  const q16 = new Float32Array(48000);
  for (let i = 0; i < q16.length; i++) q16[i] = Math.round(0.5 * Math.sin(2 * Math.PI * 440 * i / RATE) * 32768) / 32768;
  const d16 = Analysis.detectBitDepth(q16);
  check('16bit の刻みを見抜く', '16', String(d16.bits), d16.bits === 16 && d16.sure);
  const q24 = new Float32Array(48000);
  for (let i = 0; i < q24.length; i++) q24[i] = Math.round(0.5 * Math.sin(2 * Math.PI * 440 * i / RATE) * 8388608) / 8388608;
  const d24 = Analysis.detectBitDepth(q24);
  check('24bit の刻みを見抜く', '24', String(d24.bits), d24.bits === 24 && d24.sure);
  const dF = Analysis.detectBitDepth(s440.samples);
  check('float のままの音は整数の刻みに乗らない', '32（不確か）', `${dF.bits}`, dF.bits === 32);
  const scaled = new Float32Array(q16.length);
  for (let i = 0; i < q16.length; i++) scaled[i] = q16[i] * 0.8;
  const dS = Analysis.detectBitDepth(scaled);
  check('16bit のあとに音量が掛かると刻みが崩れる', '16 ではない', `${dS.bits}`, dS.bits !== 16);

  // L/R の時間差：R を 2ms 遅らせたステレオ
  const lag = Math.round(RATE * 0.002);
  const st = new Float32Array(RATE * 3 * 2);
  for (let i = 0; i < RATE * 3; i++) {
    const v = (i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / RATE) * (i > RATE ? 1 : 0.3) + 0.2 * Math.sin(2 * Math.PI * 1234 * i / RATE);
    st[i * 2] = v(i);
    st[i * 2 + 1] = i - lag >= 0 ? v(i - lag) : 0;
  }
  const sc = Analysis.stereoCheck(st, RATE * 3, RATE);
  check('R が 2ms 遅れたステレオの時間差', '+2.00 ms', `${sc.lagMs.toFixed(2)} ms`, Math.abs(sc.lagMs - 2) < 0.05);
  check('極性は正しいと判定', '逆相ではない', String(sc.inverted), !sc.inverted);
  for (let i = 0; i < RATE * 3; i++) st[i * 2 + 1] = -st[i * 2];
  const sc2 = Analysis.stereoCheck(st, RATE * 3, RATE);
  check('R を反転させると逆相と判定', '逆相', String(sc2.inverted), sc2.inverted === true);

  await wait();
}

/* ================= ⑧ 素と仕上げ ================= */

async function testPureFinished() {
  section('⑧ 素と仕上げ');

  const session = {
    id: 'pf', name: 'pf', sampleRate: RATE, listen: 'pure',
    finish: newFinish(),
    tracks: [makeTrack('t1', 440, 1)],
  };
  const audios = new Map([['a1', sine(440, 1, 0.3)]]);
  const loadTake = async (take) => audios.get(take.audioId);

  // 仕上げを入れても「素」は1サンプルも変わらない
  session.tracks[0].processing.humEnabled = true;
  session.finish.normalizeEnabled = true;
  const pure = await Edit.mixdown(session, loadTake, { pure: true });
  let diff = 0;
  for (let i = 0; i < pure.frames; i++) if (Math.abs(pure.samples[i * 2] - audios.get('a1').samples[i]) > 1e-7) diff++;
  check('仕上げを入れていても「素」は元の音そのもの', '不一致サンプル 0', String(diff), diff === 0);

  session.finish.normalizeEnabled = false;
  const before = truePeakOf((await Edit.mixdown(session, loadTake, { pure: false })).samples, 2).truePeak;
  session.finish.normalizeEnabled = true;
  const fin = await Edit.mixdown(session, loadTake, { pure: false });
  const tp = truePeakOf(fin.samples, 2).truePeak;
  check('仕上げの「音量をそろえる」で −1 dBTP に', '0.891 ± 0.005', tp.toFixed(4), Math.abs(tp - 0.8913) < 0.005);
  const expectGain = -1 - db(before);
  check('掛けた量が記録される', `${expectGain.toFixed(1)} dB`, `${fin.normalizeGainDb.toFixed(1)} dB`, Math.abs(fin.normalizeGainDb - expectGain) < 0.1);

  // 仕上げが無ければ、仕上げ経路でも素と同じ
  session.tracks[0].processing.humEnabled = false;
  session.finish.normalizeEnabled = false;
  const same = await Edit.mixdown(session, loadTake, { pure: false });
  let diff2 = 0;
  for (let i = 0; i < same.samples.length; i++) if (Math.abs(same.samples[i] - pure.samples[i]) > 1e-7) diff2++;
  check('盛りが無いときは仕上げ経路でも素と一致', '不一致サンプル 0', String(diff2), diff2 === 0);

  await wait();
}


/* ================= ⑨ ホールの響き ================= */

async function testReverb() {
  section('⑨ ホールの響き');

  // 内蔵ホールの実測 T30 と指定値
  for (const [kind, h] of Object.entries(Reverb.HALLS)) {
    const ir = Reverb.buildImpulse(kind, h.seconds, RATE, 0);
    const t30 = Reverb.measureT30(ir);
    const err = Math.abs(t30 - h.seconds) / h.seconds * 100;
    check(`${h.name} の実測 T30`, `${h.seconds.toFixed(1)} 秒 ±10%`, `${t30.toFixed(2)} 秒（ずれ ${err.toFixed(1)}%）`, err < 10);
  }

  // 左右の相関：真ん中で団子にならない
  const ir = Reverb.buildImpulse('hall', 2.0, RATE, 0);
  let ll = 0, rr = 0, lr = 0;
  const from = Math.round(RATE * 0.1);
  for (let i = from; i < ir.left.length; i++) { ll += ir.left[i] ** 2; rr += ir.right[i] ** 2; lr += ir.left[i] * ir.right[i]; }
  const corr = lr / Math.sqrt(ll * rr);
  check('響きの左右の相関', '0.30 未満（1.0 なら真ん中で団子）', corr.toFixed(3), Math.abs(corr) < 0.3);

  // 同じ設定なら同じ響き
  const ir2 = Reverb.buildImpulse('hall', 2.0, RATE, 0);
  let same = true;
  for (let i = 0; i < ir.left.length; i += 97) if (ir.left[i] !== ir2.left[i]) { same = false; break; }
  check('同じ設定から同じ響きができる', '一致', same ? '一致' : '不一致', same);

  // ConvolverNode の答え ↔ 素直な畳み込み
  const session = { id: 'rv', name: 'rv', sampleRate: RATE, listen: 'finished', finish: newFinish(), tracks: [makeTrack('t1', 0, 1)] };
  session.finish.reverb = { enabled: true, hall: 'room', seconds: 0.7, amount: 1, preDelayMs: 0 };
  const impulse = { samples: new Float32Array(RATE), frames: RATE, channels: 1, sampleRate: RATE, seconds: 1 };
  impulse.samples[100] = 1;
  const audios = new Map([['a1', impulse]]);
  const loadTake = async (take) => audios.get(take.audioId);
  const fin = await Edit.mixdown(session, loadTake, { pure: false });
  const irRoom = Reverb.cachedImpulse('room', 0.7, RATE, 0);
  let maxErr = 0, maxAbs = 0;
  for (let i = 0; i < irRoom.left.length; i++) {
    const expect = irRoom.left[i] + (i === 0 ? 1 : 0);   // 直接音（1.0）＋ 響き
    const got = fin.samples[(100 + i) * 2];
    maxErr = Math.max(maxErr, Math.abs(got - expect));
    maxAbs = Math.max(maxAbs, Math.abs(expect));
  }
  check('畳み込みの答えが響きそのものと一致（直接音は無加工で足される）', '最大誤差 1e-4 未満（最大値比）',
    (maxErr / maxAbs).toExponential(2), maxErr / maxAbs < 1e-4);

  // 響きの量 0% は素と1サンプルも違わない
  session.finish.reverb.amount = 0;
  session.finish.reverb.enabled = true;
  const tone = sine(440, 1, 0.3);
  audios.set('a1', tone);
  const pure = await Edit.mixdown(session, loadTake, { pure: true });
  const zero = await Edit.mixdown(session, loadTake, { pure: false });
  let diff = 0;
  for (let i = 0; i < pure.samples.length; i++) if (pure.samples[i] !== zero.samples[i]) diff++;
  check('響きの量 0% のときの出力', '素と不一致サンプル 0', String(diff), diff === 0);

  // 量 100%、響きが届く前（プリディレイ 30ms）は素と一致
  session.finish.reverb.amount = 1;
  session.finish.reverb.preDelayMs = 30;
  const wet = await Edit.mixdown(session, loadTake, { pure: false });
  const before = Math.floor(RATE * 0.03) * 2 - 4;
  let diff2 = 0;
  for (let i = 0; i < before; i++) if (Math.abs(wet.samples[i] - pure.samples[i]) > 1e-7) diff2++;
  check('量 100%、響きが届く前の 30ms は素と一致（直接音は無加工）', '不一致サンプル 0', String(diff2), diff2 === 0);
  check('書き出しは響きの尾のぶん長くなる', `${(1 + Finish.tailSeconds(session)).toFixed(2)} 秒`, wet.seconds.toFixed(2), Math.abs(wet.seconds - (1 + Finish.tailSeconds(session))) < 0.01);

  // 盛り度を測る：素そのものなら「無」、響きを足せば尾が出る
  const mNone = Finish.measureFinish(pure, pure);
  check('素と素を比べると盛り度「無」', '無', mNone.grade, mNone.grade === '無');
  const mWet = Finish.measureFinish(pure, wet);
  check('響きを足した音の盛り度に尾が出る', '尾 0.5 秒以上', `${mWet.grade}／尾 ${mWet.tailSeconds.toFixed(2)} 秒`, mWet.tailSeconds > 0.5);

  // 段階ダイヤル
  Finish.applyDial(session, 0);
  check('ダイヤル 0 は何も盛らない', '盛りなし', String(Finish.summarize(session).length), Finish.summarize(session).length === 0);
  Finish.applyDial(session, 2);
  check('ダイヤル 2 は部屋の響きを薄く', 'room / 25%', `${session.finish.reverb.hall} / ${Math.round(session.finish.reverb.amount * 100)}%`,
    session.finish.reverb.hall === 'room' && session.finish.reverb.amount === 0.25 && session.finish.rumbleCut && session.finish.normalizeEnabled);

  await wait();
}


/* ================= ⑩ 録る力：押す前の音・チャンネル・穴・保険・長時間 ================= */

async function testRecording() {
  section('⑩ 押す前の音・録るチャンネル・落ちた穴・保険・続きのトラック・RF64');

  // 押す前の音：輪っかに入れておいた直近が、録音の先頭に古い順で付く
  const msgs = [];
  const core = new CaptureCore((m) => msgs.push(m), { channels: 2, blockFrames: 100000 });
  core.command({ cmd: 'preroll', frames: 1000 });
  const mk = (v, n = 480) => [new Float32Array(n).fill(v), new Float32Array(n).fill(-v)];
  for (let i = 1; i <= 5; i++) core.push(mk(i / 10), 480);          // 2400 フレーム。輪っかには最後の 1000 だけ残る
  core.command({ cmd: 'record', on: true, trimFrames: 0, preroll: true, prerollFrames: 1000 });
  core.push(mk(0.9), 480);
  core.command({ cmd: 'record', on: false });
  const started = msgs.find(m => m.type === 'started');
  const datas = msgs.filter(m => m.type === 'data' && m.samples);
  const pre = datas[0];
  check('押す前の音が 1000 フレーム付く', '1000', String(started && started.prerolledFrames), !!started && started.prerolledFrames === 1000 && pre.preroll === true);
  // 輪っかの中身は 3 枚目の後半（0.3）→ 4 枚目（0.4）→ 5 枚目（0.5）の順
  check('付いた音が古い順に並ぶ', '先頭 0.3 → 末尾 0.5',
    `${pre.samples[0].toFixed(1)} → ${pre.samples[pre.samples.length - 2].toFixed(1)}`,
    Math.abs(pre.samples[0] - 0.3) < 1e-6 && Math.abs(pre.samples[pre.samples.length - 2] - 0.5) < 1e-6);
  check('押す前の音は左右を保つ', 'L=+0.5 / R=-0.5', `${pre.samples[pre.samples.length - 2].toFixed(1)} / ${pre.samples[pre.samples.length - 1].toFixed(1)}`,
    Math.abs(pre.samples[pre.samples.length - 1] + 0.5) < 1e-6);

  // ズレ合わせで頭を捨てる録りには付けない
  msgs.length = 0;
  for (let i = 0; i < 3; i++) core.push(mk(0.2), 480);
  core.command({ cmd: 'record', on: true, trimFrames: 10, preroll: true, prerollFrames: 1000 });
  core.push(mk(0.9), 480);
  core.command({ cmd: 'record', on: false });
  const st2 = msgs.find(m => m.type === 'started');
  check('頭を捨てる録り（重ね録り）には付けない', '0', String(st2.prerolledFrames), st2.prerolledFrames === 0);

  // 録るチャンネル：4ch の入力から 3-4 だけ
  msgs.length = 0;
  const core4 = new CaptureCore((m) => msgs.push(m), { channels: 4, blockFrames: 100000 });
  core4.command({ cmd: 'channels-map', map: [2, 3] });
  core4.command({ cmd: 'record', on: true, trimFrames: 0 });
  core4.push([0.1, 0.2, 0.3, 0.4].map(v => new Float32Array(480).fill(v)), 480);
  core4.command({ cmd: 'record', on: false });
  const d4 = msgs.find(m => m.type === 'data' && m.samples);
  check('4ch から 3-4 だけを録る', '2ch / 0.3, 0.4', `${d4.channels}ch / ${d4.samples[0].toFixed(1)}, ${d4.samples[1].toFixed(1)}`,
    d4.channels === 2 && Math.abs(d4.samples[0] - 0.3) < 1e-6 && Math.abs(d4.samples[1] - 0.4) < 1e-6);

  // 落ちた穴：無音で埋めて長さを保つ
  msgs.length = 0;
  const coreG = new CaptureCore((m) => msgs.push(m), { channels: 1, blockFrames: 100000 });
  coreG.command({ cmd: 'record', on: true, trimFrames: 0 });
  coreG.push([new Float32Array(480).fill(0.5)], 480);
  coreG.pushSilence(240);
  coreG.push([new Float32Array(480).fill(0.5)], 480);
  coreG.command({ cmd: 'record', on: false });
  const dg = msgs.find(m => m.type === 'data' && m.samples);
  check('落ちた 240 フレームを無音で埋めて長さを保つ', '1200 フレーム、真ん中が 0', `${dg.frames} / ${dg.samples[600].toFixed(1)}`,
    dg.frames === 1200 && dg.samples[600] === 0 && dg.samples[100] === 0.5);

  // 保険トラック：本線が割れたところだけ保険で差し替わる
  const n = RATE * 2;
  const st = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = t > 0.8 && t < 1.2 ? 1.6 : 0.5;              // 真ん中だけ大きすぎる
    const v = env * Math.sin(2 * Math.PI * 440 * t);
    st[i * 2] = Math.max(-1, Math.min(1, v));                  // 本線：割れる
    st[i * 2 + 1] = v * 0.25;                                  // 保険：-12 dB。割れない
  }
  const fix = Edit.repairWithSafety({ samples: st, frames: n, channels: 2, sampleRate: RATE, seconds: 2 }, 0, 1);
  check('割れた区間を見つける', '1 か所（0.8〜1.2 秒あたり）', fix ? `${fix.regions.length} か所 ${fix.regions[0].from.toFixed(2)}〜${fix.regions[0].to.toFixed(2)}` : 'なし',
    !!fix && fix.regions.length === 1 && fix.regions[0].from < 0.82 && fix.regions[0].to > 1.18);
  check('保険との差を実測で出す', '+12.0 dB', fix ? `${fix.gainDb.toFixed(1)} dB` : '-', !!fix && Math.abs(fix.gainDb - 12.04) < 0.1);
  if (fix) {
    const y = fix.audio.samples;
    let maxMid = 0, diffEdge = 0;
    for (let i = Math.round(RATE * 0.9); i < Math.round(RATE * 1.1); i++) maxMid = Math.max(maxMid, Math.abs(y[i]));
    for (let i = 0; i < Math.round(RATE * 0.5); i++) diffEdge = Math.max(diffEdge, Math.abs(y[i] - st[i * 2]));
    check('直したあとの真ん中は割れていない（1.6 の波が戻る）', '最大値 1.6 付近', maxMid.toFixed(2), maxMid > 1.5 && maxMid < 1.7);
    check('割れていないところは本線そのまま', '不一致 0', diffEdge.toExponential(1), diffEdge === 0);
  }
  const clean = Edit.repairWithSafety({ samples: sine(440, 1, 0.3, RATE, 2).samples, frames: RATE, channels: 2, sampleRate: RATE, seconds: 1 }, 0, 1);
  check('割れていなければ何もしない', 'null', String(clean), clean === null);

  // 続きのトラック：startSeconds の位置から鳴る
  const session = { id: 'ct', name: 'ct', sampleRate: RATE, finish: newFinish(), tracks: [makeTrack('t1', 440, 1), makeTrack('t2', 1000, 1)] };
  session.tracks[1].startSeconds = 1.0;
  const audios = new Map([['a1', sine(440, 1, 0.3)], ['a2', sine(1000, 1, 0.3)]]);
  const mix = await Edit.mixdown(session, async (take) => audios.get(take.audioId), { pure: true });
  const left = new Float32Array(mix.frames);
  for (let i = 0; i < mix.frames; i++) left[i] = mix.samples[i * 2];
  const early1k = goertzel(left, 1000, RATE, 2400, 24000), late1k = goertzel(left, 1000, RATE, RATE + 2400, 24000);
  check('続きのトラックは全体の長さに足される', '2.000 秒', mix.seconds.toFixed(3), Math.abs(mix.seconds - 2) < 0.002);
  check('続きのトラックは開始位置から鳴る（前半には無い）', '前半 -80 dB 以下 / 後半 -10.5 dB', `${db(early1k).toFixed(1)} / ${db(late1k).toFixed(1)}`, db(early1k) < -80 && Math.abs(db(late1k) + 10.46) < 1);

  // RF64：4GB 超の書き方でも読み戻せる（自己検証では強制して小さなファイルで）
  const small = sine(440, 0.1, 0.5);
  const blob = encodeWav(small.samples, 1, RATE, SaveFormat.Float32, { forceRf64: true });
  const buf = await blob.arrayBuffer();
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  const back = decodeWav(buf);
  let diffR = 0;
  for (let i = 0; i < small.samples.length; i++) if (back.samples[i] !== small.samples[i]) diffR++;
  check('RF64 のヘッダで書ける', 'RF64', magic, magic === 'RF64');
  check('RF64 を読み戻して不一致 0', '0', String(diffR), diffR === 0 && back.frames === small.frames);

  // 大きな音も1つの ArrayBuffer にせず刻んで Blob にする（64MB 超）
  const big = new Float32Array(20 * 1024 * 1024);   // 80MB
  for (let i = 0; i < big.length; i += 4096) big[i] = 0.25;
  const bigBlob = encodeWav(big, 1, RATE, SaveFormat.Float32);
  check('80MB の音を刻んで WAV にできる', `${44 + big.length * 4} バイト`, String(bigBlob.size), bigBlob.size === 44 + big.length * 4);

  await wait();
}


/* ================= ⑪ 質：ディザ・超音波・試し弾き ================= */

async function testQuality() {
  section('⑪ 24bit のディザ・超音波の雑音・試し弾きの助言');

  // 24bit の刻みに乗った値は触らない（無劣化のまま）
  const grid = new Float32Array(48000);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.round(0.5 * Math.sin(2 * Math.PI * 440 * i / RATE) * 8388608) / 8388608;
  resetDither();
  const q1 = quantize(grid, SaveFormat.Pcm24);
  let same = 0;
  for (let i = 0; i < grid.length; i++) if (q1[i] === grid[i]) same++;
  check('24bit の刻みに乗った値にはディザを足さない', '一致 48000', String(same), same === grid.length);

  // 乗っていない値（float）には TPDF ディザ：誤差の実効値は約 0.5 LSB（丸め 1/12 ＋ 三角 2/12）
  const flt = sine(440, 1, 0.5).samples;
  resetDither();
  const q2 = quantize(flt, SaveFormat.Pcm24);
  let e2 = 0;
  for (let i = 0; i < flt.length; i++) { const d = (q2[i] - flt[i]) * 8388608; e2 += d * d; }
  const rmsLsb = Math.sqrt(e2 / flt.length);
  check('float の値には TPDF ディザ（誤差 ≒ 0.5 LSB）', '0.40〜0.60 LSB（float32 の粗さで少し下がる）', `${rmsLsb.toFixed(3)} LSB`, rmsLsb > 0.40 && rmsLsb < 0.60);
  // ディザで信号への相関（歪み）が消える：誤差と信号の相関がほぼ 0
  let corr = 0, es = 0;
  for (let i = 0; i < flt.length; i++) { const d = q2[i] - flt[i]; corr += d * flt[i]; es += flt[i] * flt[i]; }
  const rho = Math.abs(corr / Math.sqrt(es * e2 / 8388608 / 8388608));
  check('丸めの誤差が信号と相関しない', '|相関| 0.02 未満（48000 点の雑音の範囲）', rho.toExponential(2), rho < 0.02);

  // 超音波：22 kHz の雑音を混ぜると見つかり、無ければ見つからない
  const n = RATE * 2;
  const clean = new Float32Array(n), dirty = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const tone = 0.3 * Math.sin(2 * Math.PI * 440 * i / RATE) + 0.0005 * rnd();
    clean[i] = tone;
    dirty[i] = tone + 0.01 * Math.sin(2 * Math.PI * 22000 * i / RATE);
  }
  const rc = Analysis.analyzeChannel(clean, 0, RATE), rd = Analysis.analyzeChannel(dirty, 0, RATE);
  check('22 kHz の雑音を見つける', '床より +12 dB 以上', `${rd.ultrasonicOverFloorDb.toFixed(0)} dB`, rd.ultrasonicAvailable && rd.ultrasonicOverFloorDb > 12);
  check('無ければ騒がない', '+12 dB 未満', `${rc.ultrasonicOverFloorDb.toFixed(0)} dB`, rc.ultrasonicOverFloorDb < 12);

  // 試し弾きの助言
  const adv = (tp, flats = 0) => Quality.adviseGain({ truePeak: Math.pow(10, tp / 20), samplePeak: Math.pow(10, tp / 20), flats });
  check('−12 dBTP なら「いまの位置でいい」', 'good', adv(-12).verdict, adv(-12).verdict === 'good');
  check('−4 dBTP なら「下げる」', 'hot / −8 dB', `${adv(-4).verdict} / ${adv(-4).deltaDb.toFixed(0)} dB`, adv(-4).verdict === 'hot' && Math.abs(adv(-4).deltaDb + 8) < 0.01);
  check('−30 dBTP なら「上げられる」', 'low / +18 dB', `${adv(-30).verdict} / ${adv(-30).deltaDb.toFixed(0)} dB`, adv(-30).verdict === 'low' && Math.abs(adv(-30).deltaDb - 18) < 0.01);
  check('頭が平らなら音量に関係なく「歪んでいる」', 'distorted', adv(-15, 3).verdict, adv(-15, 3).verdict === 'distorted');

  // 帯は −18〜−8
  check('「ちょうどいい」帯は −18〜−8 dBTP', '-18 / -8', `${Meter.GoodFromDb} / ${Meter.GoodToDb}`, Meter.GoodFromDb === -18 && Meter.GoodToDb === -8);

  await wait();
}


/* ================= ⑫ 証明・測定・部屋 ================= */

async function testKarajan() {
  section('⑫ BWF の札・スイープ測定・THD+N・クリック・ステレオ幾何・マイク補正');

  // BWF bext：書いて読み戻す。TimeReference に開始位置
  const tone = sine(440, 0.2, 0.3);
  const blob = encodeWav(tone.samples, 1, RATE, SaveFormat.Float32, {
    bext: { description: 'テスト 素', originator: 'Tonmeister', originatorReference: 'sess01', timeReference: 5.46 * RATE, codingHistory: 'A=PCM,F=48000,W=32,M=mono,T=Tonmeister web;path=raw\r\n' },
  });
  const back = decodeWav(await blob.arrayBuffer());
  check('bext を書いて読み戻す', 'description / originator が戻る', `${back.bext && back.bext.description} / ${back.bext && back.bext.originator}`,
    !!back.bext && back.bext.description === 'テスト 素' && back.bext.originator === 'Tonmeister');
  check('TimeReference（開始位置のサンプル数）', String(Math.round(5.46 * RATE)), String(back.bext && back.bext.timeReference), !!back.bext && back.bext.timeReference === Math.round(5.46 * RATE));
  check('CodingHistory に経路の証拠', 'path=raw を含む', back.bext ? back.bext.codingHistory.trim() : '', !!back.bext && back.bext.codingHistory.includes('path=raw'));
  let same = 0;
  for (let i = 0; i < tone.samples.length; i++) if (back.samples[i] === tone.samples[i]) same++;
  check('bext が付いても音は無劣化', `一致 ${tone.samples.length}`, String(same), same === tone.samples.length && back.frames === tone.frames);

  // スイープ → 仮の部屋（直接音＋3 ms・−10 dB の反射＋0.6 秒の尾）→ 逆畳み込み
  const sw = Sweep.makeSweep(RATE, 2, 20, 20000, 0.5);
  const irLen = Math.round(RATE * 0.8);
  const room = new Float32Array(irLen);
  room[0] = 1;
  room[Math.round(RATE * 0.003)] = Math.pow(10, -10 / 20);
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const k = Math.pow(10, -3 / (0.6 * RATE));   // RT60 0.6 秒
  let env = 0.05;
  for (let i = Math.round(RATE * 0.01); i < irLen; i++) { room[i] += rnd() * env; env *= k; }
  const recorded = Sweep.convolveFFT(sw.sweep, room);
  const dec = Sweep.deconvolve(recorded, sw, { tailSeconds: 0.8 });
  const p0 = dec.peakIndex;
  check('逆畳み込みで直接音が 1 点に戻る', 'ピーク 1.0 ± 0.05', dec.ir[p0].toFixed(3), Math.abs(dec.ir[p0] - 1) < 0.05);
  const r3 = dec.ir[p0 + Math.round(RATE * 0.003)];
  check('3 ms 後の反射が −10 dB で戻る', '0.316 ± 0.03', r3.toFixed(3), Math.abs(r3 - 0.316) < 0.03);
  const analyzed = Sweep.analyzeRoom(dec.ir, RATE, p0);
  const refl = analyzed.reflections.find(r => Math.abs(r.ms - 3) < 0.3);
  check('初期反射を見つけて距離にする', '3.0 ms → 約 51 cm', refl ? `${refl.ms.toFixed(2)} ms → ${(refl.distanceM * 100).toFixed(0)} cm / ${refl.db.toFixed(1)} dB` : 'なし',
    !!refl && Math.abs(refl.distanceM * 100 - 51.5) < 6 && Math.abs(refl.db + 10) < 1.5);
  const rt = analyzed.rt60.find(b => b.hz === 1000);
  check('RT60（1 kHz）が仮の部屋の 0.6 秒に近い', '0.6 秒 ±20%', rt ? `${rt.seconds.toFixed(2)} 秒` : '-', !!rt && Math.abs(rt.seconds - 0.6) / 0.6 < 0.2);
  // 平らな IR（直接音だけ）の周波数特性は平ら
  const flat = new Float32Array(RATE); flat[0] = 1;
  const decFlat = Sweep.deconvolve(Sweep.convolveFFT(sw.sweep, flat), sw, { tailSeconds: 0.2 });
  const resp = Sweep.normalizeResponse(Sweep.frequencyResponse(decFlat.ir, RATE, { windowMs: 100 }), Sweep.referenceResponse(sw, { windowMs: 100 }));
  const spread = Sweep.responseSpread(resp, 40, 16000);
  check('素通しの往復特性は平ら（40 Hz〜16 kHz）', '±0.2 dB 以内', `${spread.minDb.toFixed(2)}〜+${spread.maxDb.toFixed(2)} dB`, spread.minDb > -0.2 && spread.maxDb < 0.2);
  // 山のある仮の機材（2 kHz に +3 dB）は、その山が出る
  const bump = new Float32Array(RATE); bump[0] = 1;
  {
    // 2 kHz の共振を IR に足す（減衰する正弦波）
    // 幅の広い山（帯域 ≒ 150 Hz）にして、1/6 オクターブの平均でも見えるようにする
    for (let i = 0; i < 1200; i++) bump[i] += 0.02 * Math.sin(2 * Math.PI * 2000 * i / RATE) * Math.exp(-i / 100);
  }
  const decBump = Sweep.deconvolve(Sweep.convolveFFT(sw.sweep, bump), sw, { tailSeconds: 0.2 });
  const respBump = Sweep.normalizeResponse(Sweep.frequencyResponse(decBump.ir, RATE, { windowMs: 100 }), Sweep.referenceResponse(sw, { windowMs: 100 }));
  const at2k = respBump.reduce((a, c) => (Math.abs(c.hz - 2000) < Math.abs(a.hz - 2000) ? c : a), respBump[0]);
  const at500 = respBump.reduce((a, c) => (Math.abs(c.hz - 500) < Math.abs(a.hz - 500) ? c : a), respBump[0]);
  check('機材の山（2 kHz）が特性に出て、離れたところは平ら', '2 kHz > +1 dB / 500 Hz ≈ 0', `${at2k.db.toFixed(2)} / ${at500.db.toFixed(2)} dB`, at2k.db > 1 && Math.abs(at500.db) < 0.3);

  // THD+N：1 kHz に 2 次 −60 dB、3 次 −70 dB、雑音 −100 dBFS
  const n = RATE * 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t) + 0.5 * 0.001 * Math.sin(2 * Math.PI * 2000 * t) + 0.5 * 0.000316 * Math.sin(2 * Math.PI * 3000 * t) + 1e-5 * rnd();
  }
  const th = Sweep.analyzeTone(x, RATE, 1000, { skipSeconds: 0.1 });
  const h2 = th.harmonics.find(h => h.n === 2), h3 = th.harmonics.find(h => h.n === 3);
  check('2 次倍音 −60 dB を測る', '−60 ± 1 dB', `${h2.db.toFixed(1)} dB`, Math.abs(h2.db + 60) < 1);
  check('3 次倍音 −70 dB を測る', '−70 ± 1 dB', `${h3.db.toFixed(1)} dB`, Math.abs(h3.db + 70) < 1);
  check('THD（倍音だけ）', '0.105% 付近', `${th.thdPercent.toFixed(4)}%`, Math.abs(th.thdPercent - 0.1049) < 0.01);
  check('SNR → 実効ビット（雑音 1e-5 の一様乱数 ＝ 95.8 dB）', '95.8 ± 1.5 dB → 15.6 bit', `${th.snrDb.toFixed(1)} dB → ${th.effectiveBits.toFixed(1)} bit`, Math.abs(th.snrDb - 95.8) < 1.5);

  // クリック：滑らかな波に 1 サンプルだけ 0.5 の飛びを 3 か所
  const cl = sine(220, 2, 0.3).samples;
  for (const at of [0.5, 1.0, 1.5]) { const i = Math.round(at * RATE); cl[i] += 0.5; }
  const clicks = Analysis.findClicks(cl, cl.length, 1, RATE);
  check('1 サンプルの飛びを 3 か所見つける', '3 か所（0.5 / 1.0 / 1.5 秒）', clicks.map(c => c.at.toFixed(3)).join(' / '),
    clicks.length === 3 && Math.abs(clicks[0].at - 0.5) < 0.001 && Math.abs(clicks[2].at - 1.5) < 0.001);
  const none = Analysis.findClicks(sine(220, 2, 0.9).samples, RATE * 2, 1, RATE);
  check('素の正弦波にクリックは無い', '0', String(none.length), none.length === 0);

  // ステレオ幾何：R が 0.5 ms 遅れ（17 cm 遠い）、L が 2 dB 大きい
  const lag = Math.round(RATE * 0.0005);
  const stF = new Float32Array(RATE * 3 * 2);
  for (let i = 0; i < RATE * 3; i++) {
    const v = (j) => 0.5 * Math.sin(2 * Math.PI * 220 * j / RATE) + 0.2 * Math.sin(2 * Math.PI * 1234 * j / RATE);
    stF[i * 2] = v(i) * Math.pow(10, 2 / 20);
    stF[i * 2 + 1] = i - lag >= 0 ? v(i - lag) : 0;
  }
  const geo = Analysis.stereoCheck(stF, RATE * 3, RATE);
  check('時間差を cm にする', '約 17 cm（R が遠い）', `${geo.distanceCm.toFixed(1)} cm`, Math.abs(geo.distanceCm - 17.15) < 1.5);
  check('レベル差を出す', 'L が +2.0 dB', `${geo.levelDiffDb.toFixed(1)} dB`, Math.abs(geo.levelDiffDb - 2) < 0.2);

  // マイク補正：+3 dB の山（2 kHz）がある較正 → 逆特性 FIR は 2 kHz で −3 dB、1 kHz・200 Hz で 0 dB
  const cal = MicCal.parseCalibration('* test mic\n20 0\n1000 0\n1500 1.5\n2000 3\n2600 1.5\n4000 0\n20000 0\n');
  check('較正ファイルを読む', '7 点', String(cal.length), cal.length === 7);
  check('点の間を補間する', '2 kHz で +3.0 dB', MicCal.calibrationAt(cal, 2000).toFixed(2), Math.abs(MicCal.calibrationAt(cal, 2000) - 3) < 0.01);
  const fir = MicCal.buildCalibrationFir(cal, RATE, 4096);
  const g2k = MicCal.firGainDb(fir, 2000), g1k = MicCal.firGainDb(fir, 1000), g200 = MicCal.firGainDb(fir, 200);
  check('逆特性の FIR：2 kHz で −3 dB', '−3.0 ± 0.3', g2k.toFixed(2), Math.abs(g2k + 3) < 0.3);
  check('逆特性の FIR：1 kHz と 200 Hz は 0 dB', '0 ± 0.3', `${g1k.toFixed(2)} / ${g200.toFixed(2)}`, Math.abs(g1k) < 0.3 && Math.abs(g200) < 0.3);
  check('FIR の遅れ', '2048 サンプル', String(fir.delay), fir.delay === 2048);

  // 仕上げにマイク補正を入れても素は不一致 0、仕上げは遅れを切って揃う
  const session = { id: 'mc', name: 'mc', sampleRate: RATE, listen: 'pure', finish: newFinish(), tracks: [makeTrack('t1', 440, 1)] };
  session.finish.micCorrection = true; session.finish.micCal = { name: 'test', points: cal };
  const audios = new Map([['a1', sine(440, 1, 0.3)]]);
  const loadTake = async (take) => audios.get(take.audioId);
  const pure = await Edit.mixdown(session, loadTake, { pure: true });
  const fin = await Edit.mixdown(session, loadTake, { pure: false });
  let diff = 0;
  for (let i = 0; i < pure.frames; i++) if (Math.abs(pure.samples[i * 2] - audios.get('a1').samples[i]) > 1e-7) diff++;
  check('マイク補正を入れても素は元の音そのもの', '不一致 0', String(diff), diff === 0);
  const L = new Float32Array(fin.frames);
  for (let i = 0; i < fin.frames; i++) L[i] = fin.samples[i * 2];
  const a440 = goertzel(L, 440, RATE, 4800, 24000);
  check('仕上げ側は遅れを切って揃い、440 Hz は 0 dB のまま', '−10.5 dB 付近', `${db(a440).toFixed(2)} dB`, Math.abs(db(a440) + 10.46) < 0.3);

  await wait();
}


/* ================= ⑬ FLAC ================= */

async function testFlac() {
  section('⑬ FLAC（自前の可逆圧縮）');
  const n = RATE * 2;
  const x = new Float32Array(n * 2);
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const v = Math.round((0.4 * Math.sin(2 * Math.PI * 440 * i / RATE) + 0.05 * Math.sin(2 * Math.PI * 3000 * i / RATE) + rnd() * 0.0005) * 8388608) / 8388608;
    x[i * 2] = v; x[i * 2 + 1] = Math.round(v * 0.5 * 8388608) / 8388608;
  }
  const blob = encodeFlac(x, 2, RATE, 24);
  let back = null, err = '';
  try { back = await decodeFlacWithBrowser(blob, RATE); } catch (e) { err = e.message; }
  check('ブラウザの復号器が読める', '読める', back ? `${back.frames} フレーム / ${back.channels}ch` : 'NG: ' + err, !!back && back.frames === n && back.channels === 2);
  if (back) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (back.samples[i] !== x[i]) diff++;
    check('復号して元と比べる（24bit の刻みの音）', '不一致 0 サンプル', String(diff), diff === 0);
  }
  const ratio = blob.size / (n * 2 * 3);
  check('容量が 24bit WAV より小さい', '0.85 未満', ratio.toFixed(3), ratio < 0.85);
  // 無音と定数はとても小さく
  const silent = encodeFlac(new Float32Array(RATE * 2), 2, RATE, 24);
  check('無音は数百バイトに', '2 KB 未満', `${silent.size} バイト`, silent.size < 2048);
  // 端数のブロック（4096 で割れない長さ）
  const odd = new Float32Array(5000);
  for (let i = 0; i < 5000; i++) odd[i] = Math.round(0.3 * Math.sin(2 * Math.PI * 300 * i / RATE) * 8388608) / 8388608;
  const oblob = encodeFlac(odd, 1, RATE, 24);
  let oback = null;
  try { oback = await decodeFlacWithBrowser(oblob, RATE); } catch { }
  let odiff = 0;
  if (oback) for (let i = 0; i < 5000; i++) if (oback.samples[i] !== odd[i]) odiff++;
  check('4096 で割れない長さ（最後のブロックが短い）', '5000 フレーム・不一致 0', oback ? `${oback.frames} / ${odiff}` : 'NG', !!oback && oback.frames === 5000 && odiff === 0);
  await wait();
}

/* ================= 走らせる ================= */

document.querySelector('#run').onclick = async () => {
  results.length = 0;
  document.querySelector('#summary').hidden = true;
  const btn = document.querySelector('#run');
  btn.disabled = true;

  try {
    step('① 変換の無劣化…'); await testConversion();
    step('② 解析の数値校正…'); await testAnalysis();
    step('③ メーターの目盛り…'); await testMeter();
    step('④ 編集…'); await testEdit();
    step('⑤ 後処理…'); await testProcessing();
    step('⑥ まとめて書き出す…'); await testMixdown();
    step('⑦ 割れの見張り…'); await testPeaks();
    step('⑧ 素と仕上げ…'); await testPureFinished();
    step('⑨ ホールの響き…'); await testReverb();
    step('⑩ 録る力…'); await testRecording();
    step('⑪ 質…'); await testQuality();
    step('⑫ 証明・測定・部屋…'); await testKarajan();
    step('⑬ FLAC…'); await testFlac();
    step('終わりました。');
  } catch (e) {
    section('途中で止まりました');
    check('例外', 'なし', String(e && e.message || e), false);
    step('止まりました。');
    console.error(e);
  }
  render();
  btn.disabled = false;
};
