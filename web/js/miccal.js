/*
  マイクの較正ファイル。測定用マイク（miniDSP UMIK-1 など）に付いてくる
    周波数[Hz]  感度のずれ[dB]  (位相)
  の行の並びを読み、
    ・解析側：周波数分布からマイクの色を引いて「本当の」分布を見る
    ・仕上げ側：逆特性の FIR（直線位相・4096 タップ）を作り、音からマイクの色を戻す
  に使う。素の WAV には触らない。仕上げ側は「盛り」ではなく「戻し」として扱う。
*/

/** テキストを [{hz, db}] にする。`*` や `#` で始まる行、数字で始まらない行は飛ばす。 */
export function parseCalibration(text) {
  const points = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[*#;]/.test(line)) continue;
    const m = line.split(/[\s,;\t]+/);
    const hz = parseFloat(m[0]), db = parseFloat(m[1]);
    if (!isFinite(hz) || !isFinite(db) || hz <= 0) continue;
    points.push({ hz, db });
  }
  points.sort((a, b) => a.hz - b.hz);
  // 同じ周波数が重なっていたら後を採る
  const out = [];
  for (const p of points) { if (out.length && Math.abs(out[out.length - 1].hz - p.hz) < 1e-6) out[out.length - 1] = p; else out.push(p); }
  if (out.length < 4) throw new Error('較正の点が足りません（周波数と dB の2列のテキストを選んでください）。');
  return out;
}

/** その周波数でのマイクのずれ（dB）。点の間は対数周波数で直線補間、外は端の値。 */
export function calibrationAt(points, hz) {
  if (!points || !points.length) return 0;
  if (hz <= points[0].hz) return points[0].db;
  if (hz >= points[points.length - 1].hz) return points[points.length - 1].db;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].hz <= hz) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi];
  const t = (Math.log(hz) - Math.log(a.hz)) / (Math.log(b.hz) - Math.log(a.hz));
  return a.db + (b.db - a.db) * t;
}

/** 帯（[{centerHz, db}]）からマイクの色を引く。 */
export function correctBands(bands, points) {
  return bands.map(b => ({ centerHz: b.centerHz, db: b.db - calibrationAt(points, b.centerHz) }));
}

/**
 * 逆特性の FIR（直線位相）。周波数標本化法：
 * 目標の振幅（−ずれ dB）を格子に置き、位相 0 で逆 FFT → 中央に寄せて窓を掛ける。
 * 20 Hz 以下と 20 kHz 以上は 0 dB に戻す（較正の外で暴れないように）。
 * 遅れは taps/2 サンプル。
 */
export function buildCalibrationFir(points, rate, taps = 4096) {
  const N = taps;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const hz = k * rate / N;
    let db = -calibrationAt(points, hz);
    if (hz < 20) db *= hz / 20;
    if (hz > 20000) db *= Math.max(0, 1 - (hz - 20000) / 2000);
    db = Math.max(-24, Math.min(24, db));   // 暴れ止め
    const g = Math.pow(10, db / 20);
    re[k] = g; im[k] = 0;
    if (k > 0 && k < N / 2) { re[N - k] = g; im[N - k] = 0; }
  }
  ifft(re, im);
  // 位相 0 の応答は先頭に集まる → 中央へ回して窓
  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const src = (i - N / 2 + N) % N;
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    h[i] = re[src] * w;
  }
  return { taps: h, delay: N / 2, rate };
}

function ifft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** FIR の実際の応答（検証用）：その周波数でのゲイン dB。 */
export function firGainDb(fir, hz) {
  const N = fir.taps.length;
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) { const a = -2 * Math.PI * hz * i / fir.rate; re += fir.taps[i] * Math.cos(a); im += fir.taps[i] * Math.sin(a); }
  return 20 * Math.log10(Math.hypot(re, im));
}
