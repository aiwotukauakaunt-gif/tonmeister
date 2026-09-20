/*
  録音経路の素性を数値で出す。デスクトップ版の SignalAnalysis をそのまま移した。
  マイクとプリアンプの質、部屋の暗騒音、電源ハムはどれも「実際の音に寄せる」の
  邪魔をするが、耳だけでは判断しにくいので測る。
*/

import { fmtDb } from './meterscale.js';

const FFT_SIZE = 8192;

/* ---- FFT（基数2・その場で計算）。出力は 1/N 済みにして振幅の意味を持たせる ---- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function hann(i, size) {
  return 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
}

/**
 * ハン窓のエネルギー等価帯域幅（ビン数）。
 * 窓をかけると1本の正弦波が隣のビンにも漏れるので、複数ビンの電力を足したときは
 * この値で割らないと実際より大きく出る（ハン窓では +1.76 dB）。
 */
const HANN_ENBW_BINS = 1.5;

/** Welch 法（ハン窓・50%重ね）で振幅スペクトルを出す。単位は「正弦波振幅」。 */
function powerSpectrum(x, dc, rate) {
  const binHz = rate / FFT_SIZE;
  const half = FFT_SIZE / 2;
  const acc = new Float64Array(half);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const step = FFT_SIZE / 2;
  let blocks = 0;

  for (let start = 0; start + FFT_SIZE <= x.length; start += step) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (x[start + i] - dc) * hann(i, FFT_SIZE);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    blocks++;
  }

  if (blocks === 0) return { spectrum: acc, binHz };

  // ハン窓のコヒーレントゲイン 0.5 を戻して「その周波数にある正弦波の振幅」に換算する
  for (let k = 0; k < half; k++) acc[k] = Math.sqrt(acc[k] / blocks) * 2 / 0.5;
  return { spectrum: acc, binHz };
}

const THIRD_OCTAVE_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

function toThirdOctaveBands(spectrum, binHz) {
  const result = [];
  const nyquist = spectrum.length * binHz;
  const sixth = Math.pow(2, 1 / 6);

  for (const center of THIRD_OCTAVE_CENTERS) {
    const lo = center / sixth, hi = center * sixth;
    if (lo >= nyquist) break;

    let k0 = Math.max(0, Math.floor(lo / binHz));
    let k1 = Math.min(spectrum.length - 1, Math.ceil(hi / binHz));
    if (k1 < k0) continue;

    let power = 0;
    for (let k = k0; k <= k1; k++) power += spectrum[k] * spectrum[k];
    const amp = Math.sqrt(power / HANN_ENBW_BINS);
    result.push({ centerHz: center, db: amp > 0 ? 20 * Math.log10(amp) : -200 });
  }
  return result;
}

/** 指定ビンの周辺の電力をまとめて、そこにある正弦波の振幅に換算する。 */
function amplitudeAround(spectrum, center, spread) {
  let power = 0;
  for (let k = center - spread; k <= center + spread; k++) {
    if (k >= 0 && k < spectrum.length) power += spectrum[k] * spectrum[k];
  }
  return Math.sqrt(power / HANN_ENBW_BINS);
}

/**
 * 超音波（20 kHz 〜 ナイキスト）の雑音。耳には聞こえないが録音には入り、
 * スイッチング電源・ディスプレイ・USB の高周波雑音がここに出る。
 * 後で処理（リサンプル・圧縮）すると可聴域へ折り返すことがあるので、録る前に知りたい。
 */
function findUltrasonic(spectrum, binHz) {
  const nyquist = spectrum.length * binHz;
  if (nyquist <= 20500) return { db: -Infinity, overFloor: 0, available: false };
  const k0 = Math.ceil(20000 / binHz), k1 = spectrum.length - 1;
  let power = 0, bins = 0;
  for (let k = k0; k <= k1; k++) { power += spectrum[k] * spectrum[k]; bins++; }
  if (!bins) return { db: -Infinity, overFloor: 0, available: false };
  const amp = Math.sqrt(power / HANN_ENBW_BINS);
  // 比べる床：1〜10 kHz の中央値（楽音の倍音がある帯だが、雑音床としては十分）
  const f0 = Math.ceil(1000 / binHz), f1 = Math.floor(10000 / binHz);
  const mid = Array.from(spectrum.subarray(f0, f1)).sort((a, b) => a - b);
  const floor = mid.length ? mid[mid.length >> 1] * Math.sqrt(bins / HANN_ENBW_BINS) : 0;   // 同じビン数ぶんの床
  const db = amp > 0 ? 20 * Math.log10(amp) : -200;
  const floorDb = floor > 0 ? 20 * Math.log10(floor) : -200;
  return { db, overFloor: db - floorDb, available: true };
}

/**
 * 電源ハム（50/60Hz とその倍音）を探す。マイク録音で最も多い混入ノイズで、
 * 出てしまうと後から消すのが難しいので録る前に気づきたい。
 */
function findHum(spectrum, binHz) {
  const sorted = Array.from(spectrum).sort((a, b) => a - b);
  const floor = sorted[sorted.length >> 1];
  const floorDb = floor > 0 ? 20 * Math.log10(floor) : -200;

  let bestHz = 0, bestDb = -Infinity;
  for (const f0 of [50, 60]) {
    for (let h = 1; h <= 4; h++) {
      const f = f0 * h;
      const k = Math.round(f / binHz);
      if (k <= 0 || k >= spectrum.length) continue;
      // ハムの周波数はビンの中心とはずれるので、周辺の電力をまとめて振幅に戻す
      const amp = amplitudeAround(spectrum, k, 2);
      const db = amp > 0 ? 20 * Math.log10(amp) : -200;
      if (db > bestDb) { bestDb = db; bestHz = f; }
    }
  }
  return { hz: bestHz, db: bestDb, overFloor: bestDb - floorDb };
}

/**
 * フルスケール正弦波の RMS を基準にしたときの SN 比から実効ビット数を出す。
 * 16bit の理想 ADC ならノイズフロア -101 dBFS ＝ 16.0 bit になる。
 */
function effectiveBitsFromNoise(noiseRmsDb) {
  if (!isFinite(noiseRmsDb)) return 32;
  const snr = -3.01 - noiseRmsDb; // フルスケール正弦波の RMS は -3.01 dBFS
  return Math.max(0, (snr - 1.76) / 6.02);
}

/**
 * 届いている値の刻みから、途中で何ビットに丸められたかを見抜く。
 * 16bit を通った音は、すべての値が 1/32768 の整数倍になる（そのあとに音量が掛かっていなければ）。
 * ブラウザは float で渡してくるので、ここで見ないと 16bit で届いていることに気づけない。
 * Windows の「既定の形式」が 16bit のままの人は多く、そのままだと 24bit の機材を使っていても
 * 16bit しか届かない。
 */
export function detectBitDepth(x) {
  let nonzero = 0, fits16 = 0, fits24 = 0;
  const distinct = new Set();
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v === 0) continue;
    nonzero++;
    if (distinct.size < 64) distinct.add(v);
    const s16 = v * 32768;
    if (Math.abs(s16 - Math.round(s16)) < 1e-4) fits16++;
    const s24 = v * 8388608;
    if (Math.abs(s24 - Math.round(s24)) < 1e-3) fits24++;
  }
  if (nonzero < 1000 || distinct.size < 32) return { bits: 0, sure: false };   // 判断できる量がない
  if (fits16 / nonzero > 0.999) return { bits: 16, sure: true };
  if (fits24 / nonzero > 0.999) return { bits: 24, sure: true };
  return { bits: 32, sure: false };   // 整数の刻みに乗っていない＝float のまま、または途中で音量が掛かっている
}

export function analyzeChannel(x, index, rate) {
  const n = x.length;
  if (n === 0) {
    return {
      index, peakDb: -Infinity, rmsDb: -Infinity, dcOffset: 0, clipCount: 0,
      effectiveBits: 0, humHz: 0, humDb: -Infinity, humOverFloorDb: 0, bands: [],
      arrivedBits: 0, arrivedBitsSure: false, ultrasonicDb: -Infinity, ultrasonicOverFloorDb: 0, ultrasonicAvailable: false,
    };
  }

  let sum = 0, peak = 0, clips = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    sum += v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 1) clips++;
  }
  const dc = sum / n;

  // 直流成分は音ではないので取り除いてから RMS を出す
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const v = x[i] - dc; sumSq += v * v; }
  const rms = Math.sqrt(sumSq / n);
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  const { spectrum, binHz } = powerSpectrum(x, dc, rate);
  const bands = toThirdOctaveBands(spectrum, binHz);
  const hum = findHum(spectrum, binHz);
  const depth = detectBitDepth(x);
  const us = findUltrasonic(spectrum, binHz);

  return {
    index,
    arrivedBits: depth.bits,
    arrivedBitsSure: depth.sure,
    ultrasonicDb: us.db,
    ultrasonicOverFloorDb: us.overFloor,
    ultrasonicAvailable: us.available,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    rmsDb,
    dcOffset: dc,
    clipCount: clips,
    effectiveBits: effectiveBitsFromNoise(rmsDb),
    humHz: hum.hz,
    humDb: hum.db,
    humOverFloorDb: hum.overFloor,
    bands,
  };
}

export function analyze(interleaved, frames, channels, rate) {
  const reports = [];
  for (let c = 0; c < channels; c++) {
    const x = new Float32Array(frames);
    for (let i = 0; i < frames; i++) x[i] = interleaved[i * channels + c];
    reports.push(analyzeChannel(x, c, rate));
  }
  return reports;
}

/**
 * 2本のマイク（L/R）の時間差と極性を見る。
 * ピアノやギターを2本で録ると、距離の差ぶん片方が遅れて届き、
 * 合わせたときに低音が痩せる（位相打ち消し）。逆相のケーブルも同じ症状になる。
 * いちばん大きい 1 秒を取り出して、±20ms の範囲で相関を探す。
 */
export function stereoCheck(interleaved, frames, rate) {
  if (frames < rate) return null;
  const win = rate;                          // 1 秒
  const maxLag = Math.round(rate * 0.02);    // ±20ms
  // いちばん大きい 1 秒を探す（0.25 秒刻み）
  let bestStart = 0, bestE = -1;
  for (let s = 0; s + win <= frames; s += rate >> 2) {
    let e = 0;
    for (let i = s; i < s + win; i += 8) { const l = interleaved[i * 2], r = interleaved[i * 2 + 1]; e += l * l + r * r; }
    if (e > bestE) { bestE = e; bestStart = s; }
  }
  const L = new Float32Array(win), R = new Float32Array(win);
  for (let i = 0; i < win; i++) { L[i] = interleaved[(bestStart + i) * 2]; R[i] = interleaved[(bestStart + i) * 2 + 1]; }
  let el = 0, er = 0;
  for (let i = 0; i < win; i++) { el += L[i] * L[i]; er += R[i] * R[i]; }
  if (el <= 1e-9 || er <= 1e-9) return { silent: true };
  const norm = Math.sqrt(el * er);

  let best = 0, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0;
    const from = Math.max(0, -lag), to = Math.min(win, win - lag);
    for (let i = from; i < to; i += 2) acc += L[i] * R[i + lag];
    acc *= 2;
    if (Math.abs(acc) > Math.abs(best)) { best = acc; bestLag = lag; }
  }
  const corr = best / norm;
  const lagMs = bestLag / rate * 1000;
  return {
    silent: false,
    lagMs,                                 // 正なら R が遅れて届いている
    distanceCm: lagMs / 1000 * 343 * 100,  // その時間差ぶん、R のマイクが遠い（音源から見て）
    levelDiffDb: 10 * Math.log10(el / er), // 正なら L が大きい
    correlation: corr,
    inverted: corr < -0.3,                 // 極性が逆
    weak: Math.abs(corr) < 0.3,            // ほとんど別の音（離れたマイク／別楽器）
  };
}

/** ステレオペアの所見を一言に（幾何：cm とレベル差）。 */
export function describeStereo(sc) {
  if (!sc || sc.silent) return '';
  const parts = [];
  if (sc.inverted) parts.push('⚠ 極性が逆（片方のケーブルか設定が反転）');
  if (Math.abs(sc.distanceCm) >= 1) parts.push(`${sc.distanceCm > 0 ? 'R' : 'L'} のマイクが音源から ${Math.abs(sc.distanceCm).toFixed(1)} cm 遠い（時間差 ${Math.abs(sc.lagMs).toFixed(2)} ms）`);
  else parts.push('時間差なし（距離は揃っている）');
  if (Math.abs(sc.levelDiffDb) >= 0.5) parts.push(`${sc.levelDiffDb > 0 ? 'L' : 'R'} が ${Math.abs(sc.levelDiffDb).toFixed(1)} dB 大きい`);
  else parts.push('レベルは揃っている');
  if (sc.weak) parts.push('相関が弱い（別々の音を拾っている）');
  return parts.join('。') + '。';
}

/*
  クリック：1 サンプルの不連続。落ちた穴（無音）とは別で、USB やドライバの取りこぼしで
  値が飛ぶと「プチッ」と鳴る。前後の変化量に比べて桁違いに大きい飛びを探す。
*/
export function findClicks(interleaved, frames, channels, rate) {
  const clicks = [];
  const win = Math.max(8, Math.round(rate / 1000));   // 1 ms
  for (let c = 0; c < channels; c++) {
    // 差分の局所 RMS（1 ms 窓）を、飛びの基準にする
    let acc = 0;
    const ring = new Float64Array(win);
    let prev = interleaved[c];
    let last = -1e9;
    for (let i = 1; i < frames; i++) {
      const v = interleaved[i * channels + c];
      const d = v - prev;
      prev = v;
      // 基準（直前 1 ms の差分の実効値）は、いまの飛びを入れる前に見る
      const localRms = Math.sqrt(Math.max(1e-20, acc / win));
      // 大きな飛びで、次のサンプルで戻る（＝1 点だけ外れる）ものをクリックとする
      if (i >= win * 2 && Math.abs(d) > 0.02 && Math.abs(d) > 12 * localRms && i + 1 < frames) {
        const back = interleaved[(i + 1) * channels + c] - v;
        if (Math.sign(back) === -Math.sign(d) && Math.abs(back) > Math.abs(d) * 0.5 && i - last > win) {
          clicks.push({ at: i / rate, channel: c, jump: Math.abs(d) });
          last = i;
        }
      }
      const slot = i % win;
      acc += d * d - ring[slot];
      ring[slot] = d * d;
    }
  }
  clicks.sort((a, b) => a.at - b.at);
  return clicks;
}

/** 実在するマイクとプリアンプで、これより静かな暗騒音はまず出ない。 */
export const IMPLAUSIBLY_QUIET_DB = -120;

/** 測定結果から、次に何をすべきかの短い所見を組み立てる。 */
export function advise(channels, isSilenceTest) {
  const notes = [];
  if (channels.length === 0) return notes;

  const worstRms = Math.max(...channels.map(c => c.rmsDb));
  const bits = Math.min(...channels.map(c => c.effectiveBits));
  const maxDc = Math.max(...channels.map(c => Math.abs(c.dcOffset)));
  const hum = channels.slice().sort((a, b) => b.humOverFloorDb - a.humOverFloorDb)[0];

  if (worstRms < IMPLAUSIBLY_QUIET_DB) {
    notes.push(`⚠ 暗騒音 ${fmtDb(worstRms)} は、実在の機材では出ない静けさです。この数値は機材の性能ではありません。`);
    notes.push('考えられる原因：ブラウザのノイズ抑制が静かな間だけ入力を潰している／マイクがミュートされている／別のアプリが入力を占有している。');
    notes.push('「ブラウザが加工していないか調べる」で、静かな間に絞られていないかを確かめられます。絞られている場合、この測定値も録音した音も信用できません。');
    return notes; // これ以上の所見は意味を持たない
  }

  if (isSilenceTest) {
    notes.push(
      worstRms < -85 ? `ノイズフロア ${fmtDb(worstRms)}：とても静か。マイクとプリアンプに余裕がある。`
      : worstRms < -70 ? `ノイズフロア ${fmtDb(worstRms)}：実用範囲。静かな楽器を小さく録ると気になるかもしれない。`
      : worstRms < -55 ? `ノイズフロア ${fmtDb(worstRms)}：やや高い。入力ゲインを下げる、PCのファンから離す、で改善する余地がある。`
      : `ノイズフロア ${fmtDb(worstRms)}：高い。ゲインが上がりすぎているか、環境音を拾っている。`
    );

    // 民生用の AD 変換で 20bit を超える実効分解能はまず出ない
    notes.push(bits > 20
      ? `この暗騒音から計算した実効ビット深度は ${bits.toFixed(1)} bit ですが、実在の機材でこの値は出ません。入力に何らかの処理が入っている可能性があります。`
      : `この暗騒音での実効ビット深度は約 ${bits.toFixed(1)} bit。` +
        (bits < 12
          ? '24bit で録っても実際に使えているのはこの範囲なので、まずノイズを下げるのが先。'
          : '24bit 録音の意味が出る水準。'));
  }

  const arrived = channels.map(c => c.arrivedBits).filter(b => b > 0);
  if (arrived.length && Math.min(...arrived) === 16) {
    notes.push('⚠ 届いている値は 16bit の刻みに乗っています。24bit の機材でも、Windows の「サウンド設定 → 録音 → 既定の形式」が 16bit だとここで落ちます。24bit / 機器と同じレートに変えて、開き直してください。');
  }

  const us = channels.slice().sort((a, b) => b.ultrasonicOverFloorDb - a.ultrasonicOverFloorDb)[0];
  if (us.ultrasonicAvailable && us.ultrasonicOverFloorDb > 12) {
    notes.push(`20 kHz より上に、床より ${us.ultrasonicOverFloorDb.toFixed(0)} dB 高い雑音（${fmtDb(us.ultrasonicDb)}）がある。耳には聞こえないが録音には入る。` +
      'スイッチング電源のアダプタ・ディスプレイ・USB ハブが近いと出やすい。離す、別のポートにする、ノート PC ならバッテリー駆動で試す。');
  }

  if (hum.humOverFloorDb > 12) {
    notes.push(`${hum.humHz.toFixed(0)} Hz の電源ハムが暗騒音より ${hum.humOverFloorDb.toFixed(0)} dB 高い。` +
      '電源アダプタやディスプレイからマイクを離す、USBポートを変える、で減ることが多い。');
  }

  if (maxDc > 0.001) {
    notes.push(`直流オフセットが ${maxDc.toFixed(4)} ある。ヘッドルームを無駄に食うので、` +
      '録音後にハイパスをかけるか、機材側の設定を確認したい。');
  }

  const clips = channels.reduce((a, c) => a + c.clipCount, 0);
  if (clips > 0) notes.push(`測定中に ${clips} サンプルがクリップした。入力ゲインを下げること。`);

  return notes;
}
