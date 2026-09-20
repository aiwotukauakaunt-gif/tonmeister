/*
  WAV の読み書きと、整数 PCM ⇔ float の無劣化変換。
  デスクトップ版の SampleConvert / PartWavWriter / WavRepair にあたる。

  24bit 整数と float32 の往復は完全に元へ戻る（1 / 2^23 刻みは float32 で正確に表せる）。
*/

export const SaveFormat = {
  Float32: 'float32',
  Pcm24: 'pcm24',
};

export function bytesPerSample(format) {
  return format === SaveFormat.Pcm24 ? 3 : 4;
}

export function formatLabel(format) {
  return format === SaveFormat.Pcm24 ? '24bit PCM WAV' : '32bit float WAV';
}

/*
  float(-1..1) → 24bit 整数。
  元の値が 24bit の刻みに乗っているなら丸めるだけ（完全に戻る）。
  乗っていない（float32 で録った・ミックスした）なら TPDF ディザを足して丸める。
  丸めの誤差が信号に相関した歪みになるのを、無相関の小さな雑音に置き換える。
  刻みに乗っている値には触らないので、「24bit で録った音は完全に無劣化」は保たれる。
*/
let ditherSeed = 0x2545F491;
function ditherTpdf() {
  // 2つの一様乱数の差 → 三角分布（±1 LSB）
  ditherSeed = (ditherSeed * 1664525 + 1013904223) >>> 0;
  const a = ditherSeed / 4294967296;
  ditherSeed = (ditherSeed * 1664525 + 1013904223) >>> 0;
  const b = ditherSeed / 4294967296;
  return a - b;
}
export function resetDither(seed = 0x2545F491) { ditherSeed = seed >>> 0; }

function writeInt24(view, offset, v) {
  let x = v * 8388608;
  const r = Math.round(x);
  if (Math.abs(x - r) > 1e-4) x += ditherTpdf();   // 刻みに乗っていないときだけ
  let s = Math.round(x);
  if (s > 8388607) s = 8388607;
  if (s < -8388608) s = -8388608;
  if (s < 0) s += 16777216;
  view.setUint8(offset, s & 0xff);
  view.setUint8(offset + 1, (s >> 8) & 0xff);
  view.setUint8(offset + 2, (s >> 16) & 0xff);
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 4GB を超える WAV は RF64（BWF の 64bit 版）で書く。境目はこの手前。 */
const RF64_THRESHOLD = 0xFFFFFFFF - 1024;
/** 大きな音を1つの ArrayBuffer にしない（ブラウザの上限に当たる）。この大きさで刻んで Blob にまとめる。 */
const CHUNK_BYTES = 64 * 1024 * 1024;

/*
  BWF（Broadcast Wave Format）の bext チャンク。放送・制作の現場で使う「この音はどう録られたか」の札。
    Description      256  何の録音か
    Originator        32  作ったもの（Tonmeister）
    OriginatorRef     32  一意の参照（セッション id など）
    OriginationDate   10  yyyy-mm-dd
    OriginationTime    8  hh:mm:ss
    TimeReference  8 (64bit)  0 時からのサンプル数。続きのトラックはここに開始位置が入るので、DAW に置くと正しい位置に並ぶ
    Version            2  1
    UMID              64  0
    Loudness…         10  0（version 1 では使わない）
    Reserved         180
    CodingHistory   可変  経路の証拠（A=PCM,F=48000,W=32,M=stereo,T=…）
*/
const BEXT_FIXED = 602;

function asciiBytes(text, length) {
  const out = new Uint8Array(length);
  const enc = new TextEncoder().encode(text);
  out.set(enc.subarray(0, length));
  return out;
}

function buildBext(b, channels, sampleRate, bits, isFloat) {
  const history = (b.codingHistory || `A=${isFloat ? 'PCM' : 'PCM'},F=${sampleRate},W=${bits},M=${channels === 1 ? 'mono' : channels === 2 ? 'stereo' : channels + 'ch'},T=Tonmeister\r\n`);
  let hist = new TextEncoder().encode(history);
  if (hist.length % 2 === 1) { const h2 = new Uint8Array(hist.length + 1); h2.set(hist); hist = h2; }   // チャンクは偶数長
  const size = BEXT_FIXED + hist.length;
  const buf = new ArrayBuffer(8 + size);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  writeString(v, 0, 'bext'); v.setUint32(4, size, true);
  let o = 8;
  const now = b.date instanceof Date ? b.date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  u8.set(asciiBytes(b.description || '', 256), o); o += 256;
  u8.set(asciiBytes(b.originator || 'Tonmeister', 32), o); o += 32;
  u8.set(asciiBytes(b.originatorReference || '', 32), o); o += 32;
  u8.set(asciiBytes(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, 10), o); o += 10;
  u8.set(asciiBytes(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, 8), o); o += 8;
  const tr = Math.max(0, Math.round(b.timeReference || 0));
  v.setUint32(o, tr % 4294967296, true); v.setUint32(o + 4, Math.floor(tr / 4294967296), true); o += 8;
  v.setUint16(o, 1, true); o += 2;          // version
  o += 64;                                   // UMID
  o += 10 + 180;                             // loudness (v2) + reserved
  u8.set(hist, o);
  return buf;
}

/** 読むとき：bext があれば中身を返す。 */
export function parseBext(view, body, size) {
  const txt = (o, n) => new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + body + o, n)).replace(/\0+$/, '');
  const tr = view.getUint32(body + 338, true) + view.getUint32(body + 342, true) * 4294967296;
  return {
    description: txt(0, 256), originator: txt(256, 32), originatorReference: txt(288, 32),
    date: txt(320, 10), time: txt(330, 8), timeReference: tr,
    codingHistory: size > BEXT_FIXED ? txt(BEXT_FIXED, size - BEXT_FIXED) : '',
  };
}

/**
 * インターリーブされた float から WAV を作る。
 * 大きくても1つの ArrayBuffer にせず、刻んだ部品を Blob にまとめる。
 * データが 4GB を超えるときは RF64（ds64 チャンクに 64bit の長さ）にする。
 * bext を渡すと BWF（放送用の札つき）になる。
 * @param {Float32Array} samples インターリーブ済み
 */
export function encodeWav(samples, channels, sampleRate, format = SaveFormat.Float32, { forceRf64 = false, bext = null } = {}) {
  const bps = bytesPerSample(format);
  const bits = bps * 8;
  const isFloat = format === SaveFormat.Float32;
  const dataBytes = samples.length * bps;
  const rf64 = forceRf64 || dataBytes > RF64_THRESHOLD;   // forceRf64 は自己検証用
  const bextBuf = bext ? buildBext(bext, channels, sampleRate, bits, isFloat) : null;
  const bextBytes = bextBuf ? bextBuf.byteLength : 0;

  const headerBytes = (rf64 ? 12 + 8 + 28 : 12) + 8 + 16 + 8;   // RIFF/WAVE (+ds64) + fmt + data ヘッダ
  const header = new ArrayBuffer(headerBytes);
  const view = new DataView(header);
  let p = 0;
  const riffSize = headerBytes - 8 + bextBytes + dataBytes;
  if (rf64) {
    writeString(view, 0, 'RF64'); view.setUint32(4, 0xFFFFFFFF, true); writeString(view, 8, 'WAVE');
    writeString(view, 12, 'ds64'); view.setUint32(16, 28, true);
    view.setUint32(20, riffSize % 4294967296, true); view.setUint32(24, Math.floor(riffSize / 4294967296), true);
    view.setUint32(28, dataBytes % 4294967296, true); view.setUint32(32, Math.floor(dataBytes / 4294967296), true);
    const frames = samples.length / channels;
    view.setUint32(36, frames % 4294967296, true); view.setUint32(40, Math.floor(frames / 4294967296), true);
    view.setUint32(44, 0, true);   // 表の数
    p = 48;
  } else {
    writeString(view, 0, 'RIFF'); view.setUint32(4, riffSize, true); writeString(view, 8, 'WAVE');
    p = 12;
  }
  writeString(view, p, 'fmt ');
  view.setUint32(p + 4, 16, true);
  view.setUint16(p + 8, isFloat ? 3 : 1, true);      // 3=IEEE float / 1=PCM
  view.setUint16(p + 10, channels, true);
  view.setUint32(p + 12, sampleRate, true);
  view.setUint32(p + 16, sampleRate * channels * bps, true);
  view.setUint16(p + 20, channels * bps, true);
  view.setUint16(p + 22, bits, true);
  p += 24;
  writeString(view, p, 'data');
  view.setUint32(p + 4, rf64 ? 0xFFFFFFFF : dataBytes, true);

  // bext は fmt の前に置く（RIFF/WAVE の直後）。fmt と data のヘッダは1つの buffer なので、間に挟むため分ける
  const fmtStart = rf64 ? 48 : 12;
  const parts = bextBuf
    ? [header.slice(0, fmtStart), bextBuf, header.slice(fmtStart)]
    : [header];
  const perChunk = Math.floor(CHUNK_BYTES / bps);
  for (let start = 0; start < samples.length; start += perChunk) {
    const n = Math.min(perChunk, samples.length - start);
    if (isFloat) {
      // float32 リトルエンディアンはそのままのバイト列（この環境は LE）。写しを取って Blob に渡す
      parts.push(new Float32Array(samples.subarray(start, start + n)).buffer);
    } else {
      const buf = new ArrayBuffer(n * 3);
      const v = new DataView(buf);
      for (let i = 0, q = 0; i < n; i++, q += 3) writeInt24(v, q, samples[start + i]);
      parts.push(buf);
    }
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/**
 * WAV を読む。ブラウザの decodeAudioData は再標本化してしまうので使わない
 * （「実際に鳴っている音」を変えないため、自前で読む）。
 *
 * 前回異常終了して data の長さが書かれていないファイルも、残りを全部音として読む。
 */
export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 12) throw new Error('WAV として短すぎます。');
  const magic = view.getUint32(0, false);
  const isRf64 = magic === 0x52463634;   // 'RF64'
  if (magic !== 0x52494646 && !isRf64) throw new Error('RIFF ではありません。');

  let p = 12;
  let fmt = null, dataOffset = -1, dataBytes = 0;
  let ds64Data = -1;   // RF64 の data の長さ（64bit）
  let bext = null;

  while (p + 8 <= view.byteLength) {
    const id = view.getUint32(p, false);
    let size = view.getUint32(p + 4, true);
    const body = p + 8;

    if (id === 0x64733634) { // 'ds64'
      ds64Data = view.getUint32(body + 8, true) + view.getUint32(body + 12, true) * 4294967296;
    } else if (id === 0x62657874 && size >= BEXT_FIXED) { // 'bext'
      try { bext = parseBext(view, body, size); } catch { }
    } else if (id === 0x666d7420) { // 'fmt '
      let tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (tag === 0xfffe && size >= 40) tag = view.getUint16(body + 24, true); // EXTENSIBLE
      fmt = { tag, channels, sampleRate, bits };
    } else if (id === 0x64617461) { // 'data'
      dataOffset = body;
      if (size === 0xFFFFFFFF && ds64Data >= 0) size = ds64Data;
      // 壊れたヘッダの修復：長さが 0／ファイルをはみ出すなら、残り全部を音として扱う
      const rest = view.byteLength - body;
      dataBytes = (size === 0 || size > rest) ? rest : size;
      break;
    }

    if (size % 2 === 1) size++;
    p = body + size;
  }

  if (!fmt) throw new Error('fmt チャンクが見つかりません。');
  if (dataOffset < 0) throw new Error('data チャンクが見つかりません。');

  const bytes = fmt.bits / 8;
  const frameBytes = bytes * fmt.channels;
  const frames = Math.floor(dataBytes / frameBytes);
  const total = frames * fmt.channels;
  const out = new Float32Array(total);

  let q = dataOffset;
  if (fmt.tag === 3 && fmt.bits === 32) {
    for (let i = 0; i < total; i++, q += 4) out[i] = view.getFloat32(q, true);
  } else if (fmt.tag === 3 && fmt.bits === 64) {
    for (let i = 0; i < total; i++, q += 8) out[i] = view.getFloat64(q, true);
  } else if (fmt.tag === 1 && fmt.bits === 24) {
    for (let i = 0; i < total; i++, q += 3) {
      let v = view.getUint8(q) | (view.getUint8(q + 1) << 8) | (view.getUint8(q + 2) << 16);
      if (v & 0x800000) v -= 16777216;
      out[i] = v / 8388608;
    }
  } else if (fmt.tag === 1 && fmt.bits === 16) {
    for (let i = 0; i < total; i++, q += 2) out[i] = view.getInt16(q, true) / 32768;
  } else if (fmt.tag === 1 && fmt.bits === 32) {
    for (let i = 0; i < total; i++, q += 4) out[i] = view.getInt32(q, true) / 2147483648;
  } else if (fmt.tag === 1 && fmt.bits === 8) {
    for (let i = 0; i < total; i++, q += 1) out[i] = (view.getUint8(q) - 128) / 128;
  } else {
    throw new Error(`未対応の形式です（tag ${fmt.tag} / ${fmt.bits}bit）。`);
  }

  return {
    samples: out,
    frames,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    seconds: fmt.sampleRate > 0 ? frames / fmt.sampleRate : 0,
    bext,
  };
}

/** 保存形式を1往復させて、記録される値そのものにする（書き出しと同じ音を画面で見るため）。 */
export function quantize(samples, format) {
  if (format !== SaveFormat.Pcm24) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let x = samples[i] * 8388608;
    const r0 = Math.round(x);
    if (Math.abs(x - r0) > 1e-4) x += ditherTpdf();
    let s = Math.round(x);
    if (s > 8388607) s = 8388607;
    if (s < -8388608) s = -8388608;
    out[i] = s / 8388608;
  }
  return out;
}
