/*
  FLAC（可逆圧縮）の書き出し。依存なしの自前エンコーダ。
  デスクトップ版の「FLAC 24bit 可逆・不一致サンプル 0」に揃える。

  作り
    ・ブロック 4096 サンプル、チャンネルは独立（ステレオ相関は使わない）
    ・サブフレームは FIXED 予測（0〜4 次）から残差の総和が最小の次数を選ぶ。定数なら CONSTANT
    ・残差は Rice 符号（4bit パラメータ、分割次数 0〜6 から最小を選ぶ）
    ・ヘッダの CRC-8、フレームの CRC-16、STREAMINFO の MD5（未計算 = 0 は仕様上許される）
  読み戻しはブラウザの decodeAudioData（同じレートの OfflineAudioContext）で確かめる。
*/

const BLOCK = 4096;

/* ---------------- ビットを書く ---------------- */
class BitWriter {
  constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.nbits = 0; }
  _grow() { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
  write(value, bits) {
    // value は 0 以上の整数（32bit 以内）。bits ≤ 32
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.nbits++;
      if (this.nbits === 8) { if (this.pos >= this.buf.length) this._grow(); this.buf[this.pos++] = this.acc; this.acc = 0; this.nbits = 0; }
    }
  }
  writeSigned(value, bits) { this.write(value < 0 ? (value + (2 ** bits)) : value, bits); }
  writeUnary(n) { for (let i = 0; i < n; i++) this.write(0, 1); this.write(1, 1); }
  /** Rice：折り返し（zigzag）→ 上位は単進法、下位 k ビット */
  writeRice(v, k) {
    const u = v >= 0 ? v * 2 : -v * 2 - 1;
    const q = Math.floor(u / (2 ** k));
    for (let i = 0; i < q; i++) this.write(0, 1);
    this.write(1, 1);
    if (k > 0) this.write(u % (2 ** k), k);
  }
  align() { while (this.nbits !== 0) this.write(0, 1); }
  bytes() { this.align(); return this.buf.subarray(0, this.pos); }
}

/* ---------------- CRC ---------------- */
const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xFFFF : (d << 1) & 0xFFFF;
  CRC16[i] = d;
}
function crc8(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = CRC8[c ^ bytes[i]]; return c; }
function crc16(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = ((c << 8) & 0xFFFF) ^ CRC16[((c >> 8) ^ bytes[i]) & 0xFF]; return c; }

/* ---------------- UTF-8 風のフレーム番号 ---------------- */
function writeUtf8Number(bw, n) {
  if (n < 0x80) { bw.write(n, 8); return; }
  if (n < 0x800) { bw.write(0xC0 | (n >> 6), 8); bw.write(0x80 | (n & 0x3F), 8); return; }
  if (n < 0x10000) { bw.write(0xE0 | (n >> 12), 8); bw.write(0x80 | ((n >> 6) & 0x3F), 8); bw.write(0x80 | (n & 0x3F), 8); return; }
  if (n < 0x200000) { bw.write(0xF0 | (n >> 18), 8); bw.write(0x80 | ((n >> 12) & 0x3F), 8); bw.write(0x80 | ((n >> 6) & 0x3F), 8); bw.write(0x80 | (n & 0x3F), 8); return; }
  bw.write(0xF8 | (n >> 24), 8); bw.write(0x80 | ((n >> 18) & 0x3F), 8); bw.write(0x80 | ((n >> 12) & 0x3F), 8); bw.write(0x80 | ((n >> 6) & 0x3F), 8); bw.write(0x80 | (n & 0x3F), 8);
}

/* ---------------- 予測と残差 ---------------- */
function fixedResidual(x, order) {
  const n = x.length;
  const r = new Int32Array(Math.max(0, n - order));
  for (let i = order; i < n; i++) {
    let p;
    switch (order) {
      case 0: p = 0; break;
      case 1: p = x[i - 1]; break;
      case 2: p = 2 * x[i - 1] - x[i - 2]; break;
      case 3: p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break;
      default: p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    }
    r[i - order] = x[i] - p;
  }
  return r;
}

/** Rice のビット数の見積り（分割ごとに最良の k を選ぶ）。 */
function riceCost(res, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += res[i] >= 0 ? res[i] * 2 : -res[i] * 2 - 1;
  const n = to - from;
  if (n === 0) return { k: 0, bits: 0 };
  const mean = sum / n;
  let k = mean > 0 ? Math.floor(Math.log2(mean)) : 0;
  k = Math.max(0, Math.min(14, k));
  // 近くの k を試して最小を採る
  let best = Infinity, bestK = k;
  for (let kk = Math.max(0, k - 1); kk <= Math.min(14, k + 1); kk++) {
    let bits = n * (kk + 1);
    for (let i = from; i < to; i++) { const u = res[i] >= 0 ? res[i] * 2 : -res[i] * 2 - 1; bits += Math.floor(u / (2 ** kk)); }
    if (bits < best) { best = bits; bestK = kk; }
  }
  return { k: bestK, bits: best };
}

function encodeSubframe(bw, x, bps) {
  const n = x.length;
  // 定数？
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) {
    bw.write(0, 1); bw.write(0b000000, 6); bw.write(0, 1);
    bw.writeSigned(x[0], bps);
    return;
  }
  // FIXED 0〜4 から残差の絶対和が最小の次数
  const maxOrder = Math.min(4, n - 1);
  let bestOrder = 0, bestSum = Infinity, bestRes = null;
  for (let o = 0; o <= maxOrder; o++) {
    const r = fixedResidual(x, o);
    let s = 0;
    for (let i = 0; i < r.length; i++) s += Math.abs(r[i]);
    if (s < bestSum) { bestSum = s; bestOrder = o; bestRes = r; }
  }
  // 分割次数：0〜6 で Rice のビット数が最小のもの
  let bestPart = 0, bestBits = Infinity, bestKs = null;
  for (let po = 0; po <= 6; po++) {
    const parts = 1 << po;
    if (n % parts !== 0 || n / parts <= bestOrder) break;
    let bits = 0; const ks = [];
    for (let p = 0; p < parts; p++) {
      const from = p === 0 ? 0 : p * (n / parts) - bestOrder;
      const to = (p + 1) * (n / parts) - bestOrder;
      const c = riceCost(bestRes, from, to);
      ks.push(c.k); bits += c.bits + 4;
    }
    if (bits < bestBits) { bestBits = bits; bestPart = po; bestKs = ks; }
  }
  // VERBATIM のほうが小さいなら、そのまま
  if (bestBits + bestOrder * bps > n * bps) {
    bw.write(0, 1); bw.write(0b000001, 6); bw.write(0, 1);
    for (let i = 0; i < n; i++) bw.writeSigned(x[i], bps);
    return;
  }
  bw.write(0, 1); bw.write(0b001000 | bestOrder, 6); bw.write(0, 1);
  for (let i = 0; i < bestOrder; i++) bw.writeSigned(x[i], bps);   // ウォームアップ
  bw.write(0b00, 2);                 // Rice（4bit パラメータ）
  bw.write(bestPart, 4);
  const parts = 1 << bestPart;
  for (let p = 0; p < parts; p++) {
    const from = p === 0 ? 0 : p * (n / parts) - bestOrder;
    const to = (p + 1) * (n / parts) - bestOrder;
    bw.write(bestKs[p], 4);
    for (let i = from; i < to; i++) bw.writeRice(bestRes[i], bestKs[p]);
  }
}

/* ---------------- 本体 ---------------- */

const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

/**
 * float（−1..1、インターリーブ）→ FLAC。bits は 16 か 24。
 * 値は 2^(bits-1) 倍して丸める（24bit の刻みに乗った音は完全に戻る）。
 * @returns Blob
 */
export function encodeFlac(samples, channels, sampleRate, bits = 24, { onProgress } = {}) {
  if (bits !== 16 && bits !== 24) throw new Error('FLAC は 16bit か 24bit で書きます。');
  const frames = Math.floor(samples.length / channels);
  const scale = 2 ** (bits - 1), lim = scale - 1;

  const out = new BitWriter(1 << 20);
  // fLaC + STREAMINFO
  out.write(0x66, 8); out.write(0x4C, 8); out.write(0x61, 8); out.write(0x43, 8);
  out.write(1, 1); out.write(0, 7); out.write(34, 24);           // 最後のメタデータ、type 0、長さ 34
  out.write(BLOCK, 16); out.write(BLOCK, 16);                    // 最小・最大ブロック
  out.write(0, 24); out.write(0, 24);                            // フレームサイズ（不明）
  out.write(sampleRate, 20); out.write(channels - 1, 3); out.write(bits - 1, 5);
  out.write(Math.floor(frames / 2 ** 32) & 0xF, 4); out.write(frames >>> 0, 32);   // 総サンプル数 36bit
  for (let i = 0; i < 16; i++) out.write(0, 8);                 // MD5（未計算）

  const chan = new Int32Array(BLOCK);
  const rateCode = RATE_CODES[sampleRate];
  let frameNo = 0;
  for (let start = 0; start < frames; start += BLOCK, frameNo++) {
    const n = Math.min(BLOCK, frames - start);
    const fw = new BitWriter(1 << 15);
    // フレームヘッダ
    fw.write(0x3FFE, 14); fw.write(0, 1); fw.write(0, 1);
    fw.write(n === BLOCK ? 12 : 7, 4);                          // 4096 → 12。それ以外は 16bit で後ろに
    fw.write(rateCode != null ? rateCode : (sampleRate < 65536 ? 13 : 14), 4);
    fw.write(channels - 1, 4);                                  // 独立チャンネル
    fw.write(bits === 24 ? 6 : 4, 3); fw.write(0, 1);
    writeUtf8Number(fw, frameNo);
    if (n !== BLOCK) fw.write(n - 1, 16);
    if (rateCode == null) fw.write(sampleRate < 65536 ? sampleRate : Math.round(sampleRate / 10), 16);
    const head = fw.bytes().slice();
    fw.write(crc8(head), 8);

    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < n; i++) {
        let v = Math.round(samples[(start + i) * channels + c] * scale);
        if (v > lim) v = lim; else if (v < -scale) v = -scale;
        chan[i] = v;
      }
      encodeSubframe(fw, chan.subarray(0, n), bits);
    }
    fw.align();
    const body = fw.bytes().slice();
    const crc = crc16(body);
    for (let i = 0; i < body.length; i++) out.write(body[i], 8);
    out.write(crc, 16);
    if (onProgress && frameNo % 64 === 0) onProgress(start / frames);
  }
  return new Blob([out.bytes()], { type: 'audio/flac' });
}

/** ブラウザの復号器で読み戻して、元と比べる（検証用）。同じレートの OfflineAudioContext なので再標本化は入らない。 */
export async function decodeFlacWithBrowser(blob, sampleRate) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await ctx.decodeAudioData(buf);
  const channels = audio.numberOfChannels, frames = audio.length;
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < frames; i++) out[i * channels + c] = d[i]; }
  return { samples: out, frames, channels, sampleRate: audio.sampleRate };
}
