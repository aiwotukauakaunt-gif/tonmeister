/*
  仕上げ（盛り）の一式。
    ・段階ダイヤル（0 素／1 整える／2 部屋／3 ホール／自分で決める）
    ・再生とミックスダウンで同じ形に組む配線（素の経路と仕上げの経路を並べて作る）
    ・どれだけ盛ったかを「測る」

  素の経路には何も挟まない。仕上げの経路だけに、風音カット・ハム除去・ゲート・響き・音量そろえを挟む。
  2つの経路は常に両方作り、最後のゲインで切り替える。だから再生中でも瞬時に「素」へ戻せる。
*/

import { effectiveGain, hasFinishing } from './model.js';
import { cachedImpulse, toAudioBuffer, hallName, defaultSeconds } from './reverb.js';
import { buildCalibrationFir } from './miccal.js';

/* マイク補正の FIR は同じ較正・同じレートなら使い回す */
const firCache = new Map();
function cachedFir(cal, rate) {
  const key = `${cal.name || ''}|${cal.points.length}|${rate}`;
  let f = firCache.get(key);
  if (!f) { f = buildCalibrationFir(cal.points, rate); firCache.set(key, f); if (firCache.size > 4) firCache.delete(firCache.keys().next().value); }
  return f;
}

/** 段階ダイヤル。番号と中身。 */
export const DIAL = [
  { level: 0, name: '素',     desc: '何もしない。録れた音そのもの。' },
  { level: 1, name: '整える', desc: '風音（30 Hz 以下）カット・ハム除去・音量そろえ。音色は変えない。' },
  { level: 2, name: '部屋',   desc: '整える ＋ 小さな部屋の響きを薄く。' },
  { level: 3, name: 'ホール', desc: '整える ＋ ホールの響き（種類と量を選べる）。' },
];

/** 段階を選んだときの中身を session に書き込む。「自分で決める」は何も書き換えない。 */
export function applyDial(session, level) {
  const f = session.finish;
  f.level = level;
  f.mode = 'dial';
  if (level === 0) {
    f.rumbleCut = false; f.normalizeEnabled = false; f.reverb.enabled = false;
    for (const t of session.tracks) { t.processing.humEnabled = false; t.processing.gateEnabled = false; }
    return;
  }
  f.rumbleCut = true;
  f.normalizeEnabled = true;
  for (const t of session.tracks) { t.processing.humEnabled = true; t.processing.gateEnabled = false; }
  if (level === 1) { f.reverb.enabled = false; return; }
  f.reverb.enabled = true;
  if (level === 2) { f.reverb.hall = 'room'; f.reverb.seconds = 0.7; f.reverb.amount = 0.25; f.reverb.preDelayMs = 12; }
  else { f.reverb.hall = 'chamber'; f.reverb.seconds = 1.3; f.reverb.amount = 0.45; f.reverb.preDelayMs = 30; }
}

/** 一つでも手で変えたら「自分で決める」になる。 */
export function markCustom(session) {
  session.finish.mode = 'custom';
  session.finish.level = hasFinishing(session) ? -1 : 0;
}

/** いま何を盛っているかの短い列挙。 */
export function summarize(session) {
  const f = session.finish;
  const parts = [];
  if (f.rumbleCut) parts.push('風音カット');
  if (session.tracks.some(t => t.processing.humEnabled)) parts.push('ハム除去');
  if (session.tracks.some(t => t.processing.gateEnabled)) parts.push('ゲート');
  if (f.reverb.enabled && f.reverb.amount > 0) parts.push(`${hallName(f.reverb.hall)} ${(f.reverb.seconds || defaultSeconds(f.reverb.hall)).toFixed(1)}秒・量 ${Math.round(f.reverb.amount * 100)}%`);
  if (f.normalizeEnabled) parts.push(`音量そろえ ${f.normalizeTargetDb} dBTP`);
  if (f.micCorrection && f.micCal) parts.push(`マイク補正（戻し：${f.micCal.name || '較正ファイル'}）`);
  return parts;
}

/** 響きの尾のぶん、書き出しが長くなる秒数。 */
export function tailSeconds(session) {
  const r = session.finish.reverb;
  if (!r.enabled || r.amount <= 0) return 0;
  return (r.seconds || defaultSeconds(r.hall)) * 1.25 + (r.preDelayMs || 0) / 1000;
}

/**
 * 経路のまとめ役（バス）を作る。
 *   pureOut … 素の経路の出口
 *   finOut  … 仕上げの経路の出口（響き・音量そろえ込み）
 * どちらも master に繋ぐ。切り替えは pureOut / finOut のゲイン。
 */
export function createBuses(ctx, session, master, { live = false } = {}) {
  const f = session.finish;
  const pureBus = ctx.createGain();
  const finBus = ctx.createGain();
  const finTrim = ctx.createGain();        // 音量そろえ（測ってあれば）
  const pureOut = ctx.createGain();
  const finOut = ctx.createGain();

  // マイク補正（戻し）：仕上げ側だけに逆特性の FIR。直線位相なので taps/2 だけ遅れる。
  // 生で聞き比べるときは素の側にも同じ遅れを置く（値は変えない）。書き出しでは先頭を切って揃える。
  let delaySamples = 0;
  if (f.micCorrection && f.micCal && f.micCal.points && f.micCal.points.length) {
    const fir = cachedFir(f.micCal, ctx.sampleRate);
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const buf = ctx.createBuffer(1, fir.taps.length, ctx.sampleRate);
    buf.getChannelData(0).set(fir.taps);
    conv.buffer = buf;
    finBus.connect(conv).connect(finTrim);
    delaySamples = fir.delay;
    if (live) {
      const d = ctx.createDelay(Math.max(1, fir.delay / ctx.sampleRate * 2));
      d.delayTime.value = fir.delay / ctx.sampleRate;
      pureBus.connect(d).connect(pureOut);
    } else {
      pureBus.connect(pureOut);
    }
  } else {
    pureBus.connect(pureOut);
    finBus.connect(finTrim);
  }
  pureOut.connect(master);
  finTrim.connect(finOut).connect(master);

  let reverb = null;
  if (f.reverb.enabled && f.reverb.amount > 0) {
    const ir = cachedImpulse(f.reverb.hall, f.reverb.seconds || defaultSeconds(f.reverb.hall), ctx.sampleRate, f.reverb.preDelayMs || 0);
    const convolver = ctx.createConvolver();
    convolver.normalize = false;             // 自分でエネルギーをそろえてあるので、ブラウザには触らせない
    convolver.buffer = toAudioBuffer(ctx, ir);
    const wet = ctx.createGain();
    wet.gain.value = f.reverb.amount;
    convolver.connect(wet).connect(finTrim);
    reverb = { convolver, wet, ir };
  }

  const measured = f.measured && isFinite(f.measured.normalizeGainDb) ? f.measured.normalizeGainDb : 0;
  finTrim.gain.value = f.normalizeEnabled ? Math.pow(10, measured / 20) : 1;

  return { pureBus, finBus, finTrim, pureOut, finOut, reverb, delaySamples };
}

/**
 * 1トラックぶんを両方の経路に配線する。
 * @returns {{ pureGain, finGain, send }}  音量・消音・単独の反映に使う
 */
export function wireTrack(ctx, session, track, src, buses) {
  const g = effectiveGain(session, track);
  const f = session.finish;
  const rate = ctx.sampleRate;

  // 素：何も挟まない
  const pureGain = ctx.createGain();
  pureGain.gain.value = g;
  src.connect(pureGain).connect(buses.pureBus);

  // 仕上げ
  let node = src;
  if (f.rumbleCut) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.707;
    node.connect(hp); node = hp;
  }
  const p = track.processing || {};
  if (p.humEnabled) {
    for (let h = 1; h <= (p.humHarmonics || 4); h++) {
      const freq = (p.humFrequency || 50) * h;
      if (freq >= rate / 2 * 0.95) break;
      const notch = ctx.createBiquadFilter();
      notch.type = 'notch'; notch.frequency.value = freq; notch.Q.value = 30;
      node.connect(notch); node = notch;
    }
  }
  if (p.gateEnabled) {
    const gate = new AudioWorkletNode(ctx, 'tm-gate', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
      processorOptions: { thresholdDb: p.gateThresholdDb ?? -60 },
    });
    node.connect(gate); node = gate;
  }
  const finGain = ctx.createGain();
  finGain.gain.value = g;
  node.connect(finGain).connect(buses.finBus);

  let send = null;
  if (buses.reverb) {
    send = ctx.createGain();
    send.gain.value = p.reverbSend == null ? 1 : p.reverbSend;   // トラックごとの響きの量（1 = 全体と同じ）
    finGain.connect(send).connect(buses.reverb.convolver);
  }
  return { pureGain, finGain, send };
}

export function needsGateWorklet(session) {
  return session.tracks.some(t => t.processing && t.processing.gateEnabled);
}

/* ---------------- どれだけ盛ったかを測る ---------------- */

const rmsOf = (x, from, len) => {
  let s = 0;
  for (let i = from; i < from + len; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, len));
};
const db = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);

/**
 * 素のミックス P と仕上げのミックス F を比べる。どちらも 2ch インターリーブ。
 *   gainDb      … 全体の音量差（最小二乗で合わせた倍率）
 *   residualDb  … 音量を合わせたあとに残る差（音色・響き・ゲートの変化）。素に対する dB
 *   tailSeconds … 素が終わったあとに残る響きの長さ（ピークから −60 dB まで）
 *   quietDb     … 静かな部分（素の下位 2 割のブロック）の音量がどれだけ変わったか
 *   grade       … '無' / '小' / '中' / '大'
 */
export function measureFinish(pure, fin) {
  const n = Math.min(pure.samples.length, fin.samples.length);
  const P = pure.samples, F = fin.samples;
  let pp = 0, pf = 0;
  for (let i = 0; i < n; i++) { pp += P[i] * P[i]; pf += P[i] * F[i]; }
  if (pp <= 1e-20) return { grade: '無', gainDb: 0, residualDb: -Infinity, tailSeconds: 0, quietDb: 0, identical: true };
  const g = pf / pp;
  let rr = 0;
  for (let i = 0; i < n; i++) { const d = F[i] - g * P[i]; rr += d * d; }
  const residualDb = db(Math.sqrt(rr / n) / (Math.abs(g) * Math.sqrt(pp / n)));
  const gainDb = db(Math.abs(g));

  // 尾：素が終わったあとの F
  let peak = 0;
  for (let i = 0; i < F.length; i++) { const a = Math.abs(F[i]); if (a > peak) peak = a; }
  const floor = peak * 1e-3;   // −60 dB
  let last = n;
  for (let i = F.length - 1; i >= n; i--) { if (Math.abs(F[i]) > floor) { last = i; break; } }
  const tailSeconds = Math.max(0, (last - n) / 2 / pure.sampleRate);

  // 静かな部分：100ms ブロックで、素の実効値が下位 2 割（ただし無音は除く）
  const block = Math.round(pure.sampleRate * 0.1) * 2;
  const blocks = [];
  for (let s = 0; s + block <= n; s += block) {
    const rp = rmsOf(P, s, block);
    if (rp > 1e-6) blocks.push({ s, rp });
  }
  let quietDb = 0;
  if (blocks.length >= 5) {
    blocks.sort((a, b) => a.rp - b.rp);
    const take = blocks.slice(0, Math.max(1, Math.floor(blocks.length * 0.2)));
    let sp = 0, sf = 0;
    for (const b of take) { sp += b.rp; sf += rmsOf(F, b.s, block) / Math.abs(g); }
    quietDb = db(sf / sp);
  }

  const identical = rr === 0 && Math.abs(g - 1) < 1e-9 && last === n;
  let grade;
  if (identical) grade = '無';
  else if (residualDb < -30 && tailSeconds < 0.2 && Math.abs(quietDb) < 3) grade = '小';
  else if (residualDb > -12 || tailSeconds > 1.5 || Math.abs(quietDb) > 12) grade = '大';
  else grade = '中';

  return { grade, gainDb, residualDb, tailSeconds, quietDb, identical };
}

/** 測った結果を一言に。 */
export function describeMeasure(m) {
  if (!m) return '';
  if (m.identical || m.grade === '無') return '素と1サンプルも違いません。';
  const parts = [];
  parts.push(`音量 ${m.gainDb >= 0 ? '+' : ''}${m.gainDb.toFixed(1)} dB`);
  parts.push(`音の変化 ${isFinite(m.residualDb) ? m.residualDb.toFixed(0) : '-inf'} dB（素に対して）`);
  if (m.tailSeconds > 0.05) parts.push(`尾 ${m.tailSeconds.toFixed(1)} 秒`);
  if (Math.abs(m.quietDb) >= 1) parts.push(`静かな部分 ${m.quietDb >= 0 ? '+' : ''}${m.quietDb.toFixed(0)} dB`);
  return parts.join('／');
}
