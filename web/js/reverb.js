/*
  ホールの響き。デスクトップ版の HallImpulse / ImpulseResponse をそのまま移したもの。

  前半（初期反射）は鏡像法。壁を鏡に見立てて音源を映し、どの壁からいつ返るかを距離そのままに置く。
  後半（後部残響）は反射が数え切れないほど混ざった状態なので雑音で作り、
  低・中・高の3帯域に分けて、高い音ほど早く減らす。
  壁の吸音率はザビーンの式で「響きの長さ」から逆算するので、つまみを動かすと反射の強さも一緒に変わる。

  **直接音には触らない。** 元の信号はそのまま出し、響きだけを足す。
  だから「響きの量 0%」は元の音と1サンプルも違わない（自己検証で確かめている）。
*/

const C = 343.0;                       // 音速 m/s
export const LENGTH_FACTOR = 1.25;     // 響きの長さ × これ ＝ IR の長さ
export const MIN_SECONDS = 0.2, MAX_SECONDS = 6.0;
export const MIN_PREDELAY_MS = 0, MAX_PREDELAY_MS = 150;

/** 内蔵ホール。寸法は m。distance は音源から聴取点まで。 */
export const HALLS = {
  room:    { name: '小さな部屋',   width: 6.5,  depth: 8.5,  height: 3.6,  distance: 3.0,  seconds: 0.7 },
  chamber: { name: '室内楽ホール', width: 14.0, depth: 20.0, height: 9.0,  distance: 6.0,  seconds: 1.3 },
  hall:    { name: '大ホール',     width: 24.0, depth: 44.0, height: 16.0, distance: 9.0,  seconds: 2.0 },
  church:  { name: '石の教会',     width: 17.0, depth: 48.0, height: 20.0, distance: 10.0, seconds: 3.4 },
};

export function hallName(kind) { return (HALLS[kind] || HALLS.hall).name; }
export function defaultSeconds(kind) { return (HALLS[kind] || HALLS.hall).seconds; }

/* 同じ設定なら同じ響きになるよう、乱数は種から作る（Random(seed) にあたる） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (ax, ay, az, bx, by, bz) => Math.hypot(ax - bx, ay - by, az - bz);

function onePole(src, cutoff, rate) {
  const dst = new Float64Array(src.length);
  const a = Math.exp(-2 * Math.PI * cutoff / rate);
  let y = 0;
  for (let i = 0; i < src.length; i++) { y = y * a + src[i] * (1 - a); dst[i] = y; }
  return dst;
}

function lowPassInPlace(buf, cutoff, rate) {
  if (cutoff >= rate * 0.45) return;
  const a = Math.exp(-2 * Math.PI * cutoff / rate);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y = y * a + buf[i] * (1 - a); buf[i] = y; }
}

function rms2(a, b, start, count) {
  if (count <= 0 || start >= a.length) return 0;
  count = Math.min(count, a.length - start);
  let s = 0;
  for (let i = start; i < start + count; i++) s += a[i] * a[i] + b[i] * b[i];
  return Math.sqrt(s / (2 * count));
}

function rms1(a, start, count) {
  if (count <= 0 || start >= a.length) return 0;
  count = Math.min(count, a.length - start);
  let s = 0;
  for (let i = start; i < start + count; i++) s += a[i] * a[i];
  return Math.sqrt(s / count);
}

/** RT60 秒で 60dB（1/1000）落ちる、1サンプルあたりの減衰係数。 */
const decay = (rt60, rate) => Math.pow(10, -3 / Math.max(1e-6, rt60 * rate));

/**
 * 内蔵ホールの響き（ステレオ IR）を組み立てる。
 * @returns {{ left: Float32Array, right: Float32Array, sampleRate: number, seconds: number, description: string }}
 */
export function buildImpulse(kind, seconds, rate, preDelayMs = 0) {
  const shape = HALLS[kind] || HALLS.hall;
  const rt60 = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds || shape.seconds));
  const pre = Math.round(Math.min(MAX_PREDELAY_MS, Math.max(MIN_PREDELAY_MS, preDelayMs)) / 1000 * rate);

  const length = Math.ceil(rt60 * LENGTH_FACTOR * rate);
  const left = new Float64Array(length);
  const right = new Float64Array(length);

  const volume = shape.width * shape.depth * shape.height;
  const surface = 2 * (shape.width * shape.depth + shape.width * shape.height + shape.depth * shape.height);
  // 壁の吸音率をザビーンの式から逆算する。α が大きいほど反射が弱い。
  const alpha = Math.min(0.90, Math.max(0.02, 0.161 * volume / (surface * rt60)));
  const beta = Math.sqrt(1 - alpha);
  // 混ざりきるまでの時間。ここを境に、数えられる反射から雑音へ渡す。
  const tMix = Math.min(0.12, Math.max(0.02, 0.002 * Math.sqrt(volume)));

  buildEarly(left, right, shape, beta, tMix, rate);
  buildLate(left, right, rt60, tMix, rate, 20250819 + Object.keys(HALLS).indexOf(kind));

  // 末尾を短く絞って、切れ目のプツッという音が出ないようにする
  const fade = Math.min(length, Math.floor(0.05 * length));
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade;
    left[length - fade + i] *= g;
    right[length - fade + i] *= g;
  }

  // エネルギーを 1 にそろえる。白色雑音を通すと、響きの実効値が元と同じくらいになる。
  let sum = 0;
  for (let i = 0; i < length; i++) sum += left[i] * left[i] + right[i] * right[i];
  const g = sum > 1e-30 ? 1 / Math.sqrt(sum / 2) : 0;

  // プリディレイ：先頭に無音を置く（直接音が届いてから響きが始まるまでの間）
  const outL = new Float32Array(pre + length), outR = new Float32Array(pre + length);
  for (let i = 0; i < length; i++) { outL[pre + i] = left[i] * g; outR[pre + i] = right[i] * g; }

  return {
    left: outL, right: outR, sampleRate: rate, seconds: (pre + length) / rate, rt60, alpha,
    description: `${shape.name} ${shape.width}×${shape.depth}×${shape.height}m / 響き ${rt60.toFixed(1)}秒 / 吸音率 ${alpha.toFixed(2)} / 間 ${(pre / rate * 1000).toFixed(0)}ms`,
  };
}

/** 鏡像法。壁ごとの反射回数だけ β を掛け、距離で割る。反射を重ねた音ほど高い音が削れる。 */
function buildEarly(left, right, shape, beta, tMix, rate) {
  const ORDER = 3;
  // 完全に対称に置くと左右まったく同じ時刻に届いて真ん中で団子になるので、少しずらす
  const sx = shape.width * 0.42, sy = shape.depth * 0.15, sz = 1.4;
  const baseY = sy + shape.distance;
  const rxs = [shape.width * 0.5 - 0.85, shape.width * 0.5 + 0.85];
  const rys = [baseY, baseY + 0.25];
  const rzs = [1.45, 1.58];

  const bands = [2, 5, Infinity];
  const cutoff = [12000, 6000, 2500];
  const window = tMix * 1.8;
  const limit = Math.min(left.length, Math.ceil(window * rate) + 2);

  for (let ch = 0; ch < 2; ch++) {
    const rx = rxs[ch], ry = rys[ch], rz = rzs[ch];
    const target = ch === 0 ? left : right;
    const bucket = bands.map(() => new Float64Array(limit));
    const direct = dist(sx, sy, sz, rx, ry, rz);

    for (let qx = 0; qx <= 1; qx++) for (let mx = -ORDER; mx <= ORDER; mx++)
      for (let qy = 0; qy <= 1; qy++) for (let my = -ORDER; my <= ORDER; my++)
        for (let qz = 0; qz <= 1; qz++) for (let mz = -ORDER; mz <= ORDER; mz++) {
          const refl = Math.abs(mx - qx) + Math.abs(mx) + Math.abs(my - qy) + Math.abs(my) + Math.abs(mz - qz) + Math.abs(mz);
          if (refl === 0) continue;   // 直接音は入れない

          const ix = (1 - 2 * qx) * sx + 2 * mx * shape.width;
          const iy = (1 - 2 * qy) * sy + 2 * my * shape.depth;
          const iz = (1 - 2 * qz) * sz + 2 * mz * shape.height;
          const d = dist(ix, iy, iz, rx, ry, rz);
          const t = (d - direct) / C;
          if (t < 0 || t >= window) continue;

          let amp = Math.pow(beta, refl) * direct / Math.max(d, 0.5);
          if (Math.abs(amp) < 1e-4) continue;
          // 混ざりきる手前で数えられる反射を引いていく
          const taper = t <= tMix * 0.6 ? 1 : Math.max(0, 1 - (t - tMix * 0.6) / (window - tMix * 0.6));
          amp *= taper;

          let b = 0;
          while (b < bands.length - 1 && refl > bands[b]) b++;
          const pos = t * rate, i0 = Math.floor(pos), frac = pos - i0;
          if (i0 >= 0 && i0 < limit) bucket[b][i0] += amp * (1 - frac);
          if (i0 + 1 < limit) bucket[b][i0 + 1] += amp * frac;
        }

    for (let b = 0; b < bands.length; b++) {
      lowPassInPlace(bucket[b], cutoff[b], rate);
      for (let i = 0; i < limit; i++) target[i] += bucket[b][i];
    }
  }
}

/** 後部残響。雑音を3帯域に分け、低い音ほどゆっくり、高い音ほど早く減らす。左右は別の雑音。 */
function buildLate(left, right, rt60, tMix, rate, seed) {
  const n = left.length;
  const rng = mulberry32(seed);
  const handover = tMix;
  const earlyLevel = rms2(left, right, Math.floor(handover * 0.7 * rate), Math.floor(handover * 0.35 * rate));

  for (let ch = 0; ch < 2; ch++) {
    const target = ch === 0 ? left : right;
    const noise = new Float64Array(n);
    for (let i = 0; i < n; i++) noise[i] = rng() * 2 - 1;
    const low = onePole(noise, 400, rate);
    const lowMid = onePole(noise, 3500, rate);

    const tail = new Float64Array(n);
    const kLow = decay(rt60 * 1.15, rate), kMid = decay(rt60, rate), kHigh = decay(rt60 * 0.60, rate);
    let eLow = 1, eMid = 1, eHigh = 1;
    for (let i = 0; i < n; i++) {
      const lo = low[i];
      const hi = noise[i] - lowMid[i];
      const mid = noise[i] - lo - hi;
      const t = i / rate;
      const rise = 1 - Math.exp(-t / (handover * 0.5));   // 初期反射から受け取る形で入る
      tail[i] = rise * (0.55 * lo * eLow + 1.00 * mid * eMid + 0.45 * hi * eHigh);
      eLow *= kLow; eMid *= kMid; eHigh *= kHigh;
    }

    const tailLevel = rms1(tail, Math.floor(handover * 0.7 * rate), Math.floor(handover * 0.35 * rate));
    const gain = tailLevel > 1e-12 ? earlyLevel / tailLevel : 0;
    for (let i = 0; i < n; i++) target[i] += tail[i] * gain;
  }
}

/** AudioBuffer にする（ConvolverNode に渡す形）。 */
export function toAudioBuffer(ctx, ir) {
  const buf = ctx.createBuffer(2, ir.left.length, ir.sampleRate);
  buf.getChannelData(0).set(ir.left);
  buf.getChannelData(1).set(ir.right);
  return buf;
}

/* 同じ設定の IR を何度も作らないための小さな控え */
const cache = new Map();
export function cachedImpulse(kind, seconds, rate, preDelayMs) {
  const key = `${kind}|${(+seconds).toFixed(2)}|${rate}|${(+preDelayMs).toFixed(0)}`;
  let ir = cache.get(key);
  if (!ir) {
    ir = buildImpulse(kind, seconds, rate, preDelayMs);
    cache.set(key, ir);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return ir;
}

/**
 * 直接的な畳み込み（検証用）。ConvolverNode と同じ答えになるかを確かめるため。
 * @param x mono Float32Array, @param h Float32Array
 */
export function convolveDirect(x, h, outLength = x.length + h.length - 1) {
  const y = new Float64Array(outLength);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const lim = Math.min(h.length, outLength - i);
    for (let k = 0; k < lim; k++) y[i + k] += xi * h[k];
  }
  return y;
}

/** 響きの実測 T30（−5〜−35 dB の減衰から外挿）。内蔵ホールの検証用。 */
export function measureT30(ir) {
  const n = ir.left.length;
  // 後ろから積分したエネルギー減衰曲線（シュレーダー積分）
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += ir.left[i] * ir.left[i] + ir.right[i] * ir.right[i]; edc[i] = acc; }
  const top = edc[0];
  if (top <= 0) return 0;
  const find = (db) => { const th = top * Math.pow(10, db / 10); for (let i = 0; i < n; i++) if (edc[i] <= th) return i; return n - 1; };
  const i5 = find(-5), i35 = find(-35);
  return (i35 - i5) / ir.sampleRate * 2;   // 30 dB ぶんを 60 dB に外挿
}
