/*
  スイープ測定。対数スイープを鳴らして録り、逆畳み込みでインパルス応答（IR）を得る。
  同じ道具を2通りに使う。
    ループバック … ケーブルで出力→入力を繋ぐ。インターフェース＋Windows の往復の素性
                    （周波数特性・THD+N・SNR → 実効ビット）。隠れた EQ（APO）もここで露見する
    部屋とマイク … スピーカー→マイク。帯域ごとの RT60、初期反射（いつ・どの強さ → 面までの距離）、
                    フラッターエコー、近い面による櫛形

  録音経路には触らない。測って言うだけ。
*/

/* ---------------- FFT（基数2・複素・正規化なし） ---------------- */
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = sign * 2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
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
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/** FFT で畳み込む（検証用：スイープに仮の部屋を通す）。 */
export function convolveFFT(a, b) {
  const N = nextPow2(a.length + b.length);
  const re = new Float64Array(N), im = new Float64Array(N), hr = new Float64Array(N), hi = new Float64Array(N);
  re.set(a); hr.set(b);
  fft(re, im); fft(hr, hi);
  for (let i = 0; i < N; i++) { const r = re[i] * hr[i] - im[i] * hi[i]; const m = re[i] * hi[i] + im[i] * hr[i]; re[i] = r; im[i] = m; }
  fft(re, im, true);
  return Float32Array.from(re.subarray(0, a.length + b.length - 1));
}

/* ---------------- スイープ ---------------- */

/**
 * 対数スイープ（f1 → f2、T 秒）と、その逆フィルタ。
 * 逆フィルタは時間反転に 6 dB/oct の振幅補正を掛けたもの。畳み込むとディラックに戻る。
 */
export function makeSweep(rate, seconds = 5, f1 = 20, f2 = null, amp = 0.5) {
  f2 = f2 || Math.min(20000, rate * 0.45);
  const n = Math.round(seconds * rate);
  const sweep = new Float32Array(n);
  const inv = new Float32Array(n);
  const L = seconds / Math.log(f2 / f1);
  const fade = Math.round(rate * 0.02);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * f1 * L * (Math.exp(t / L) - 1);
    let w = 1;
    if (i < fade) w = 0.5 * (1 - Math.cos(Math.PI * i / fade));
    else if (i > n - fade) w = 0.5 * (1 - Math.cos(Math.PI * (n - i) / fade));
    sweep[i] = amp * w * Math.sin(phase);
  }
  // 逆：時間反転 × exp(-t/L)（高い音ほど短い時間しか鳴らないぶんを戻す）
  for (let i = 0; i < n; i++) inv[i] = sweep[n - 1 - i] * Math.exp(-i / rate / L);
  // 全体の倍率：sweep ⊛ inv のピークが 1 になるように
  const peak = convolvePeakAtCenter(sweep, inv);
  if (peak > 0) for (let i = 0; i < n; i++) inv[i] /= peak;
  return { sweep, inverse: inv, seconds, f1, f2, rate };
}

/** sweep ⊛ inv の中心（ラグ 0 に当たるところ）の値。倍率合わせ用。 */
function convolvePeakAtCenter(a, b) {
  const n = a.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += a[i] * b[n - 1 - i];
  return Math.abs(acc);
}

/**
 * 録った音（モノ）に逆フィルタを畳み込んで IR を取り出す。
 * 直接音のピークを t=0 に置き、その前の少しと、後ろ tail 秒を返す。
 */
export function deconvolve(recorded, sw, { tailSeconds = 1.5, preMs = 5 } = {}) {
  const rate = sw.rate;
  const N = nextPow2(recorded.length + sw.inverse.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  const hr = new Float64Array(N), hi = new Float64Array(N);
  for (let i = 0; i < recorded.length; i++) re[i] = recorded[i];
  for (let i = 0; i < sw.inverse.length; i++) hr[i] = sw.inverse[i];
  fft(re, im); fft(hr, hi);
  for (let i = 0; i < N; i++) {
    const r = re[i] * hr[i] - im[i] * hi[i];
    const m = re[i] * hi[i] + im[i] * hr[i];
    re[i] = r; im[i] = m;
  }
  fft(re, im, true);
  // ピーク（直接音）
  let peak = 0, at = 0;
  for (let i = 0; i < N; i++) { const a = Math.abs(re[i]); if (a > peak) { peak = a; at = i; } }
  const pre = Math.round(rate * preMs / 1000);
  const len = Math.min(N - (at - pre), Math.round(rate * tailSeconds) + pre);
  const ir = new Float32Array(Math.max(0, len));
  for (let i = 0; i < ir.length; i++) ir[i] = re[at - pre + i];
  return { ir, rate, peakIndex: pre, peak, peakAtRecorded: at - sw.inverse.length + 1 };
}

/* ---------------- 周波数特性 ---------------- */

/**
 * IR の一部分（窓）の周波数特性。1/6 オクターブで滑らかにし、1 kHz を 0 dB にする。
 * @returns [{hz, db}]
 */
export function frequencyResponse(ir, rate, { fromIndex = 0, windowMs = 100, f1 = 20, f2 = 20000 } = {}) {
  const len = Math.min(ir.length - fromIndex, Math.round(rate * windowMs / 1000));
  const N = nextPow2(len * 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len; i++) {
    // 後ろを半分だけ滑らかに落とす（前は直接音の立ち上がりなので触らない）
    const w = i > len / 2 ? 0.5 * (1 + Math.cos(Math.PI * (i - len / 2) / (len / 2))) : 1;
    re[i] = ir[fromIndex + i] * w;
  }
  fft(re, im);
  const binHz = rate / N;
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  // 1/6 オクターブの点で、その帯の平均電力
  const out = [];
  const step = Math.pow(2, 1 / 6), half = Math.pow(2, 1 / 12);
  for (let f = f1; f <= Math.min(f2, rate / 2 * 0.98); f *= step) {
    const k0 = Math.max(1, Math.floor(f / half / binHz)), k1 = Math.min(N / 2 - 1, Math.ceil(f * half / binHz));
    let p = 0, n = 0;
    for (let k = k0; k <= k1; k++) { p += mag[k] * mag[k]; n++; }
    out.push({ hz: f, db: n && p > 0 ? 10 * Math.log10(p / n) : -200 });
  }
  const ref = out.reduce((a, c) => (Math.abs(c.hz - 1000) < Math.abs(a.hz - 1000) ? c : a), out[0]);
  for (const o of out) o.db -= ref.db;
  return out;
}

/**
 * スイープ自身を逆畳み込みした「素通し」の特性。逆フィルタの端のうねりはここに出るので、
 * 測った特性からこれを引けば、うねりが消えて機材と部屋だけが残る。
 */
const refCache = new Map();
export function referenceResponse(sw, opts = {}) {
  const key = `${sw.rate}|${sw.seconds}|${sw.f1}|${sw.f2}|${opts.windowMs || 100}`;
  let r = refCache.get(key);
  if (!r) {
    const dec = deconvolve(sw.sweep, sw, { tailSeconds: Math.max(0.2, (opts.windowMs || 100) / 1000 * 1.5) });
    r = frequencyResponse(dec.ir, sw.rate, { fromIndex: 0, windowMs: opts.windowMs || 100 });
    refCache.set(key, r);
  }
  return r;
}

/** 測った特性から素通しの特性を引く（同じ周波数の点どうし）。 */
export function normalizeResponse(resp, ref) {
  const out = resp.map((o, i) => ({ hz: o.hz, db: ref[i] && ref[i].db > -100 ? o.db - ref[i].db : o.db }));
  const at1k = out.reduce((a, c) => (Math.abs(c.hz - 1000) < Math.abs(a.hz - 1000) ? c : a), out[0]);
  for (const o of out) o.db -= at1k.db;
  return out;
}

/** 特性の凸凹：帯の中での最大と最小（1 kHz 基準）。 */
export function responseSpread(resp, f1 = 20, f2 = 20000) {
  let lo = Infinity, hi = -Infinity;
  for (const o of resp) if (o.hz >= f1 && o.hz <= f2 && o.db > -100) { lo = Math.min(lo, o.db); hi = Math.max(hi, o.db); }
  return { minDb: lo, maxDb: hi };
}

/* ---------------- THD+N ---------------- */

/**
 * 1 kHz の正弦波を鳴らして録った音から、基音・倍音・雑音を分ける。
 * @returns { fundamentalDb, thdPercent, thdnPercent, snrDb, effectiveBits, harmonics: [{n, db}] }
 */
export function analyzeTone(x, rate, freq = 1000, { skipSeconds = 0.3 } = {}) {
  const start = Math.round(rate * skipSeconds);
  const len = Math.floor((x.length - start) / (rate / freq)) * (rate / freq) | 0;   // 周期の整数倍
  if (len < rate * 0.5) return null;
  const N = nextPow2(len);
  const re = new Float64Array(N), im = new Float64Array(N);
  // ブラックマン・ハリス窓：漏れが少なく、倍音と雑音を分けやすい
  for (let i = 0; i < len; i++) {
    const a = 2 * Math.PI * i / (len - 1);
    const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    re[i] = x[start + i] * w;
  }
  fft(re, im);
  const binHz = rate / N;
  const power = (k) => re[k] * re[k] + im[k] * im[k];
  const around = (f, spread) => { const k = Math.round(f / binHz); let p = 0; for (let j = k - spread; j <= k + spread; j++) if (j > 0 && j < N / 2) p += power(j); return p; };
  const spread = Math.max(4, Math.round(8 * N / len));   // 窓の主ローブぶん
  const fund = around(freq, spread);
  let harm = 0;
  const harmonics = [];
  for (let n = 2; n <= 10; n++) {
    if (n * freq >= rate / 2 * 0.95) break;
    const p = around(n * freq, spread);
    harm += p;
    harmonics.push({ n, db: 10 * Math.log10(p / fund) });
  }
  // 雑音：基音と倍音（とその窓の裾）を除いたビンの電力の中央値 × ビン数。
  // 「全体 − 基音」だと窓の裾（−90 dB 台の漏れ）が雑音に混ざり、SNR が 90 dB 台で頭打ちになる。
  const k0 = Math.ceil(20 / binHz), k1 = Math.floor(N / 2 * 0.95);
  const skirt = spread * 3;
  const isTone = (k) => { for (let n = 1; n <= 10; n++) { const kc = Math.round(n * freq / binHz); if (Math.abs(k - kc) <= skirt) return true; } return false; };
  const others = [];
  for (let k = k0; k < k1; k++) if (!isTone(k)) others.push(power(k));
  others.sort((a, b) => a - b);
  const medianBin = others.length ? others[others.length >> 1] : 0;
  // 中央値は指数分布（雑音の電力）の ln2 倍なので、平均に戻す
  const noise = medianBin / Math.LN2 * (k1 - k0);
  const rest = harm + noise;
  return {
    fundamentalDb: 10 * Math.log10(fund) - 10 * Math.log10(fundamentalRef(len)),
    thdPercent: 100 * Math.sqrt(harm / fund),
    thdnPercent: 100 * Math.sqrt(rest / fund),
    snrDb: noise > 0 ? 10 * Math.log10(fund / noise) : Infinity,
    effectiveBits: noise > 0 ? (10 * Math.log10(fund / noise) - 1.76) / 6.02 : 32,
    harmonics,
  };
}
// 窓の電力（フルスケール正弦波が何になるか）。表示の絶対値合わせにだけ使う
function fundamentalRef(len) {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const a = 2 * Math.PI * i / (len - 1);
    const w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    s += w;
  }
  return (s / 2) * (s / 2);
}

/* ---------------- 部屋：RT60・初期反射・フラッター ---------------- */

function bandpass(x, rate, f0, Q = 1.41) {
  const w0 = 2 * Math.PI * f0 / rate, alpha = Math.sin(w0) / (2 * Q), cos = Math.cos(w0);
  const b0 = alpha, b1 = 0, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** シュレーダー積分から T20 を外挿（−5〜−25 dB）。 */
function t60Of(ir, rate) {
  const n = ir.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += ir[i] * ir[i]; edc[i] = acc; }
  const top = edc[0];
  if (top <= 0) return 0;
  const find = (db) => { const th = top * Math.pow(10, db / 10); for (let i = 0; i < n; i++) if (edc[i] <= th) return i; return n - 1; };
  const i5 = find(-5), i25 = find(-25);
  if (i25 <= i5) return 0;
  return (i25 - i5) / rate * 3;
}

export const ROOM_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

/**
 * 部屋の素性。
 *   rt60: [{hz, seconds}]
 *   reflections: [{ms, db, distanceM, notchHz}]  直接音のあと 0.5〜40 ms、−25 dB より強い山
 *   flutter: { period, count } | null              規則的に並ぶ山
 *   directToReverbDb: 直接音（最初の 2.5 ms）と残り全部の比
 */
export function analyzeRoom(irIn, rate, peakIndex) {
  const ir = Float64Array.from(irIn);
  const rt60 = ROOM_BANDS.filter(f => f < rate / 2 * 0.8).map(f => ({ hz: f, seconds: t60Of(bandpass(ir, rate, f), rate) }));

  // 初期反射：包絡線（1 ms の窓の最大）で山を探す
  const dm = Math.max(1, Math.round(rate / 1000));
  const peak = Math.abs(ir[peakIndex]) || 1e-9;
  const refl = [];
  const from = peakIndex + Math.round(rate * 0.0005), to = Math.min(ir.length, peakIndex + Math.round(rate * 0.04));
  let i = from;
  while (i < to) {
    let m = 0, mi = i;
    for (let j = i; j < Math.min(to, i + dm); j++) { const a = Math.abs(ir[j]); if (a > m) { m = a; mi = j; } }
    const db = 20 * Math.log10(m / peak);
    if (db > -25) {
      // 同じ山を二重に数えない：前の山から 1 ms 以上離れているときだけ
      if (!refl.length || mi - refl[refl.length - 1].index > dm) {
        const ms = (mi - peakIndex) / rate * 1000;
        refl.push({ index: mi, ms, db, distanceM: ms / 1000 * 343 / 2, notchHz: 1000 / (2 * ms) });
      }
    }
    i += dm;
  }
  refl.sort((a, b) => b.db - a.db);
  const reflections = refl.slice(0, 5).sort((a, b) => a.ms - b.ms);

  // フラッターエコー：30 ms 以降の包絡線の自己相関に、規則的な山があるか
  let flutter = null;
  const envStart = peakIndex + Math.round(rate * 0.03), envEnd = Math.min(ir.length, peakIndex + Math.round(rate * 0.6));
  if (envEnd - envStart > rate * 0.2) {
    const hop = Math.round(rate / 2000);   // 0.5 ms
    const env = [];
    for (let s = envStart; s + hop <= envEnd; s += hop) { let m = 0; for (let j = s; j < s + hop; j++) m = Math.max(m, Math.abs(ir[j])); env.push(m); }
    const mean = env.reduce((a, v) => a + v, 0) / env.length;
    const e = env.map(v => v - mean);
    const e0 = e.reduce((a, v) => a + v * v, 0) || 1;
    let bestLag = 0, best = 0;
    for (let lag = Math.round(0.01 / (hop / rate)); lag < e.length / 3; lag++) {
      let acc = 0;
      for (let k = 0; k + lag < e.length; k++) acc += e[k] * e[k + lag];
      acc /= e0;
      if (acc > best) { best = acc; bestLag = lag; }
    }
    if (best > 0.35) flutter = { periodMs: bestLag * hop / rate * 1000, strength: best };
  }

  // 直接音と響きの比
  const dEnd = peakIndex + Math.round(rate * 0.0025);
  let direct = 0, rest = 0;
  for (let k = 0; k < ir.length; k++) { const p = ir[k] * ir[k]; if (k <= dEnd) direct += p; else rest += p; }
  const directToReverbDb = rest > 0 ? 10 * Math.log10(direct / rest) : Infinity;

  return { rt60, reflections, flutter, directToReverbDb };
}

/** 部屋の所見を文にする。 */
export function adviseRoom(room) {
  const notes = [];
  const mid = room.rt60.find(b => b.hz === 1000) || room.rt60[Math.floor(room.rt60.length / 2)];
  if (mid && mid.seconds > 0) {
    notes.push(mid.seconds < 0.3 ? `響き（1 kHz）${mid.seconds.toFixed(2)} 秒：とても短い。乾いた録りになる。` :
      mid.seconds < 0.6 ? `響き（1 kHz）${mid.seconds.toFixed(2)} 秒：練習室として自然。` :
      mid.seconds < 1.2 ? `響き（1 kHz）${mid.seconds.toFixed(2)} 秒：やや長い。マイクを楽器に近づけると直接音が勝つ。` :
      `響き（1 kHz）${mid.seconds.toFixed(2)} 秒：長い。ホールのような部屋。近接で録るか、響きを録りたいなら離す。`);
    const lo = room.rt60.find(b => b.hz === 125), hi = room.rt60.find(b => b.hz === 4000);
    if (lo && hi && lo.seconds > 0 && hi.seconds > 0 && lo.seconds > hi.seconds * 1.8) notes.push(`低い音の響き（125 Hz ${lo.seconds.toFixed(2)} 秒）が高い音（4 kHz ${hi.seconds.toFixed(2)} 秒）より長い：低域がこもる部屋。角にものを置く、マイクを壁から離す。`);
  }
  for (const r of room.reflections.slice(0, 3)) {
    if (r.ms < 1) continue;
    notes.push(`初期反射 ${r.ms.toFixed(1)} ms・${r.db.toFixed(0)} dB：約 ${(r.distanceM * 100).toFixed(0)} cm 先の面（机・床・壁）からの返り。${r.db > -12 ? `${r.notchHz.toFixed(0)} Hz あたりに櫛形の谷ができる。マイクをその面から離す／角度を変える。` : '弱いので問題は小さい。'}`);
  }
  if (room.flutter) notes.push(`フラッターエコー（${room.flutter.periodMs.toFixed(1)} ms ごと ≒ ${(room.flutter.periodMs / 1000 * 343 * 100).toFixed(0)} cm の平行面）。壁に対して斜めに置く、布や本棚で片側を崩す。`);
  if (isFinite(room.directToReverbDb)) notes.push(`直接音／響き ${room.directToReverbDb.toFixed(0)} dB${room.directToReverbDb < 0 ? '：響きが直接音より大きい。マイクを近づける。' : room.directToReverbDb > 15 ? '：ほぼ直接音だけ。部屋の鳴りは入らない。' : '。'}`);
  return notes;
}

/** ループバックの所見。 */
export function adviseLoopback(resp, tone) {
  const notes = [];
  const sp = responseSpread(resp, 20, 20000);
  if (isFinite(sp.minDb) && isFinite(sp.maxDb)) {
    const dev = Math.max(Math.abs(sp.minDb), Math.abs(sp.maxDb));
    notes.push(dev < 0.5 ? `往復の周波数特性 ${sp.minDb.toFixed(2)}〜+${sp.maxDb.toFixed(2)} dB（20 Hz〜20 kHz）：平ら。途中で色は付いていない。`
      : dev < 2 ? `往復の周波数特性 ${sp.minDb.toFixed(1)}〜+${sp.maxDb.toFixed(1)} dB：わずかな傾き。機材のフィルタの範囲。`
      : `往復の周波数特性 ${sp.minDb.toFixed(1)}〜+${sp.maxDb.toFixed(1)} dB：⚠ 平らではない。Windows の「オーディオ拡張機能」や EQ（APO）が効いている可能性が高い。サウンド設定で切る。`);
  }
  if (tone) {
    notes.push(`THD+N ${tone.thdnPercent.toFixed(4)}%（THD ${tone.thdPercent.toFixed(4)}%）・SNR ${isFinite(tone.snrDb) ? tone.snrDb.toFixed(1) : '∞'} dB → 実効 ${Math.min(24, tone.effectiveBits).toFixed(1)} bit。` +
      (tone.effectiveBits < 14 ? ' ⚠ 16bit 相当以下。届いているビット数と Windows の既定の形式を確かめる。' : tone.effectiveBits < 17 ? ' 16bit 級のインターフェース。' : ' 良い。'));
    const h2 = tone.harmonics.find(h => h.n === 2), h3 = tone.harmonics.find(h => h.n === 3);
    if (h2 && h3 && h3.db > h2.db + 6 && h3.db > -70) notes.push(`3 次倍音（${h3.db.toFixed(0)} dB）が 2 次より強い：どこかで頭が潰れている（レベルが高すぎるか、リミッターが入っている）。`);
  }
  return notes;
}
