/*
  波形描画用に、一定サンプルごとの最小値・最大値だけを取り出したもの。
  波形は「どこで鳴っていて、どこが無音か」が見えれば十分なので、
  全サンプルを持たずにこの要約だけを持つ。

  一度読んだ波形は覚えておき、タブを行き来しても読み直さない（WaveformCache）。
*/

import { P, alpha } from './palette.js';

export const FRAMES_PER_BUCKET = 256;

export function build(audio) {
  const { samples, frames, channels, sampleRate } = audio;
  const buckets = Math.max(1, Math.ceil(frames / FRAMES_PER_BUCKET));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);

  let b = 0, carry = 0;
  let lo = Infinity, hi = -Infinity;

  for (let f = 0; f < frames; f++) {
    // 左右をまとめて1本の波形にする（見た目の判断にはこれで足りる）
    let v = 0;
    const base = f * channels;
    for (let c = 0; c < channels; c++) v += samples[base + c];
    v /= channels;

    if (v < lo) lo = v;
    if (v > hi) hi = v;

    if (++carry >= FRAMES_PER_BUCKET) {
      min[b] = lo; max[b] = hi; b++;
      lo = Infinity; hi = -Infinity; carry = 0;
    }
  }
  if (carry > 0 && b < buckets) {
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
    b++;
  }

  return {
    min, max, sampleRate, channels,
    bucketCount: b,
    totalSeconds: frames / sampleRate,
    secondsPerBucket: FRAMES_PER_BUCKET / sampleRate,
  };
}

/**
 * 振幅を「音の大きさ（dB）」の目盛りで高さに直す。
 *
 * 素の振幅のまま描くと、−36 dBFS の音は枠の 1.6% にしかならず線1本に見える。
 * かといってトラックごとに倍率を変えると、大きさを目で比べられなくなる。
 * dB の目盛りなら、小さい音も見えて、大きいトラックはちゃんと大きく見える。
 * −60 dBFS で中心、0 dBFS で枠いっぱい。
 */
export function toScale(amplitude) {
  const a = Math.abs(amplitude);
  if (a <= 0.000001) return 0;
  const db = 20 * Math.log10(a);
  const h = Math.min(1, Math.max(0, (db + 60) / 60));
  return amplitude < 0 ? -h : h;
}

/** 画面の実寸に合わせて canvas の中身を用意する（高精細画面でぼやけないように）。 */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * 波形を描く。
 * @param opts.fromSeconds/toSeconds 見せる範囲（レーンでは 0〜セッション全長）
 * @param opts.gainY 縦の倍率（編集の窓でだけ 1 以外にする）
 */
export function draw(canvas, wave, opts = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  const from = opts.fromSeconds ?? 0;
  const to = opts.toSeconds ?? (opts.totalSeconds ?? (wave ? wave.totalSeconds : 1));
  const span = Math.max(0.0001, to - from);
  const mid = h / 2;
  const gainY = opts.gainY ?? 1;

  // 選択範囲（ベルリン藍）
  if (opts.selection && opts.selection[1] > opts.selection[0]) {
    const x0 = (opts.selection[0] - from) / span * w;
    const x1 = (opts.selection[1] - from) / span * w;
    ctx.fillStyle = alpha(P.blue(), .33);
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = P.blue();
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, .5, x1 - x0 - 1, h - 1);
  }

  if (wave && wave.bucketCount > 0) {
    ctx.strokeStyle = opts.color || P.good();
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const spb = wave.secondsPerBucket;
    for (let x = 0; x < w; x++) {
      const t0 = from + x / w * span;
      const t1 = from + (x + 1) / w * span;
      let b0 = Math.floor(t0 / spb);
      let b1 = Math.max(b0 + 1, Math.ceil(t1 / spb));
      if (b0 >= wave.bucketCount) break;
      if (b0 < 0) b0 = 0;
      if (b1 > wave.bucketCount) b1 = wave.bucketCount;

      let lo = Infinity, hi = -Infinity;
      for (let b = b0; b < b1; b++) {
        if (wave.min[b] < lo) lo = wave.min[b];
        if (wave.max[b] > hi) hi = wave.max[b];
      }
      if (lo > hi) continue;

      let yTop = mid - Math.min(1, toScale(hi) * gainY) * mid;
      let yBottom = mid - Math.max(-1, toScale(lo) * gainY) * mid;
      if (yBottom - yTop < 1) yBottom = yTop + 1;
      ctx.moveTo(x + 0.5, yTop);
      ctx.lineTo(x + 0.5, yBottom);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 中心線
  ctx.strokeStyle = alpha(P.waveLine(), .5);
  ctx.beginPath();
  ctx.moveTo(0, mid + .5); ctx.lineTo(w, mid + .5);
  ctx.stroke();

  // 落ちた場所の印（深紅の小さな旗）。隠さないために描く
  if (opts.marks && opts.marks.length) {
    ctx.fillStyle = P.rec();
    for (const m of opts.marks) {
      if (m < from || m > to) continue;
      const x = (m - from) / span * w;
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.closePath(); ctx.fill();
    }
  }

  // 「ここ良かった」の印（金の小さな旗）
  if (opts.goldMarks && opts.goldMarks.length) {
    ctx.fillStyle = P.good();
    for (const m of opts.goldMarks) {
      if (m < from || m > to) continue;
      const x = (m - from) / span * w;
      ctx.fillRect(x - .5, 0, 1, h);
      ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x - 4, h - 6); ctx.lineTo(x + 4, h - 6); ctx.closePath(); ctx.fill();
    }
  }

  // 再生位置
  if (opts.playhead != null && opts.playhead >= from && opts.playhead <= to) {
    const x = (opts.playhead - from) / span * w;
    ctx.strokeStyle = P.rec();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, h);
    ctx.stroke();
  }
  return { w, h };
}

/** 一度読んだ波形を覚えておく。 */
const cache = new Map();

export async function getCached(take, loader) {
  if (cache.has(take.id)) return cache.get(take.id);
  const audio = await loader(take);
  if (!audio) return null;
  const wave = build(audio);
  cache.set(take.id, wave);
  return wave;
}

export function clearCache(takeId) {
  if (takeId) cache.delete(takeId); else cache.clear();
}
