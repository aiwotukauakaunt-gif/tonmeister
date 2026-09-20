/*
  テイクの編集と、1本にまとめる書き出し。
  元の音には一切触らず、常に新しいものを作る。
  失敗しても、気に入らなくても、前のテイクを選び直せば戻せる。

  デスクトップ版の AudioEdit / SessionMix / Mixdown にあたる。
*/

import { effectiveGain, activeTake, hasFinishing } from './model.js';
import { truePeakOf } from './capture-core.js';
import * as Finish from './finish.js';

/** 継ぎ目のプチッという音を避けるためのクロスフェード長。 */
export const CROSSFADE_SECONDS = 0.005;

const clampFrame = (f, frames) => Math.max(0, Math.min(frames, Math.round(f)));

/** 選択範囲だけを取り出す。 */
export function crop(audio, startSeconds, endSeconds) {
  if (endSeconds <= startSeconds) throw new Error('範囲の長さが 0 です。');
  const { samples, frames, channels, sampleRate } = audio;
  const a = clampFrame(startSeconds * sampleRate, frames);
  const b = clampFrame(endSeconds * sampleRate, frames);
  const n = Math.max(0, b - a);
  const out = samples.slice(a * channels, (a + n) * channels);
  return { samples: out, frames: n, channels, sampleRate, seconds: n / sampleRate };
}

/**
 * 録り直した音を元のテイクの途中に差し替える（パンチイン）。
 * 差し替えの前後は短くクロスフェードして、継ぎ目が聴こえないようにする。
 * 合計のエネルギーが一定になる形（等パワー）で重ねる。
 */
export function punchIn(original, recorded, punchInSeconds) {
  const { channels, sampleRate } = original;
  if (recorded.channels !== channels || recorded.sampleRate !== sampleRate) {
    throw new Error(
      `録り直した音の形式が違います（元 ${(sampleRate / 1000).toFixed(1)}kHz ${channels}ch / ` +
      `録り直し ${(recorded.sampleRate / 1000).toFixed(1)}kHz ${recorded.channels}ch）。`);
  }

  const fade = Math.max(1, Math.round(CROSSFADE_SECONDS * sampleRate));
  const inAt = clampFrame(punchInSeconds * sampleRate, original.frames);
  const recFrames = recorded.frames;
  if (recFrames <= fade * 2) throw new Error('録り直しが短すぎます。');

  const outAt = inAt + recFrames;                      // 差し替えの終わり（元の音での位置）
  const hasTail = outAt < original.frames;             // 元のテイクがまだ続くか
  const totalFrames = Math.max(original.frames, outAt);
  const out = new Float32Array(totalFrames * channels);

  const O = original.samples, R = recorded.samples;
  const put = (dstFrame, v, c) => { out[dstFrame * channels + c] = v; };

  // ① 差し替え開始位置まで、元の音をそのまま
  for (let f = 0; f < inAt; f++) {
    for (let c = 0; c < channels; c++) put(f, O[f * channels + c], c);
  }

  // ② 元の音と録り直した音をクロスフェードで繋ぐ
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.cos(t * Math.PI / 2); // 出ていく側
    const b = Math.sin(t * Math.PI / 2); // 入ってくる側
    const of = inAt + i;
    for (let c = 0; c < channels; c++) {
      const ov = of < original.frames ? O[of * channels + c] : 0;
      put(of, ov * a + R[i * channels + c] * b, c);
    }
  }

  // ③ 録り直した音の本体
  for (let i = fade; i < recFrames - fade; i++) {
    const df = inAt + i;
    for (let c = 0; c < channels; c++) put(df, R[i * channels + c], c);
  }

  // ④ 録り直しの終わりと元の音を、もう一度クロスフェードで繋ぐ
  //    元のテイクより長く録り直した場合は繋ぐ相手がいないので、そのまま最後まで書く
  for (let i = 0; i < fade; i++) {
    const ri = recFrames - fade + i;
    const df = inAt + ri;
    if (!hasTail) {
      for (let c = 0; c < channels; c++) put(df, R[ri * channels + c], c);
      continue;
    }
    const t = i / fade;
    const a = Math.cos(t * Math.PI / 2);
    const b = Math.sin(t * Math.PI / 2);
    for (let c = 0; c < channels; c++) {
      put(df, R[ri * channels + c] * a + O[df * channels + c] * b, c);
    }
  }

  // ⑤ 残りの元の音（④ が outAt の直前まで書いているので、ここは outAt から）
  for (let f = outAt; f < original.frames; f++) {
    for (let c = 0; c < channels; c++) put(f, O[f * channels + c], c);
  }

  return { samples: out, frames: totalFrames, channels, sampleRate, seconds: totalFrames / sampleRate };
}

/**
 * 全トラックを1本のステレオにまとめる。
 * 仕上げ（風音カット・ハム除去・ゲート・響き・音量そろえ）は再生と同じ配線（finish.js）を通すので、
 * 画面で聞いた音と書き出した音が食い違わない。
 *
 * @param pure  true なら「素」。仕上げを一切通さず、音量・消音・単独だけを反映して足し合わせる。
 */
export async function mixdown(session, loadTake, { onProgress, pure = false } = {}) {
  const playable = session.tracks.filter(t => t.takes.length > 0);
  if (playable.length === 0) throw new Error('まだ書き出すものがありません。');

  const rate = session.sampleRate || (activeTake(playable[0]) || {}).sampleRate || 48000;
  let lengthFrames = 0;
  const loaded = [];
  for (const track of playable) {
    const take = activeTake(track);
    if (!take) continue;
    const audio = await loadTake(take);
    if (!audio) continue;
    const offsetFrames = Math.round((track.startSeconds || 0) * rate);
    lengthFrames = Math.max(lengthFrames, offsetFrames + audio.frames);
    loaded.push({ track, audio, offsetFrames });
  }
  if (!loaded.length || lengthFrames === 0) throw new Error('鳴らせるトラックがありません。');

  onProgress && onProgress('まとめています…');

  // 響きの尾のぶん長くする（途中で切らない）。マイク補正の遅れぶんも足しておく（あとで先頭を切る）
  const tail = pure ? 0 : Math.ceil(Finish.tailSeconds(session) * rate) + ((session.finish.micCorrection && session.finish.micCal) ? 2048 : 0);
  const offline = new OfflineAudioContext(2, lengthFrames + tail, rate);
  if (!pure && Finish.needsGateWorklet(session)) await offline.audioWorklet.addModule('js/worklets.js');

  const buses = Finish.createBuses(offline, session, offline.destination, { live: false });
  buses.finTrim.gain.value = 1;                  // 音量そろえは描画のあとで True Peak を測って掛ける
  buses.pureOut.gain.value = pure ? 1 : 0;
  buses.finOut.gain.value = pure ? 0 : 1;

  for (const { track, audio, offsetFrames } of loaded) {
    const buffer = offline.createBuffer(audio.channels, audio.frames, rate);
    for (let c = 0; c < audio.channels; c++) {
      const dst = buffer.getChannelData(c);
      for (let i = 0; i < audio.frames; i++) dst[i] = audio.samples[i * audio.channels + c];
    }
    const src = offline.createBufferSource();
    src.buffer = buffer;
    Finish.wireTrack(offline, session, track, src, buses);
    src.start(offsetFrames / rate);
  }

  const rendered = await offline.startRendering();
  // マイク補正の FIR の遅れぶん、先頭を切って素と揃える（仕上げ側だけ）
  const skip = pure ? 0 : (buses.delaySamples || 0);
  const frames = rendered.length - skip;
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = left[i + skip];
    out[i * 2 + 1] = right[i + skip];
  }
  const mix = { samples: out, frames, channels: 2, sampleRate: rate, seconds: frames / rate };

  // セッション全体の仕上げ：音量をそろえる（True Peak を目標に合わせる。掛け算1回だけ）
  const fin = session.finish || {};
  if (!pure && fin.normalizeEnabled) {
    onProgress && onProgress('音量をそろえています…');
    const tp = truePeakOf(out, 2).truePeak;
    if (tp > 0) {
      const g = Math.pow(10, (fin.normalizeTargetDb ?? -1) / 20) / tp;
      for (let i = 0; i < out.length; i++) out[i] *= g;
      mix.normalizeGainDb = 20 * Math.log10(g);
    }
  }
  return mix;
}

/** 素とまったく同じになるか（仕上げが1つも入っていないか）。 */
export function isPure(session) { return !hasFinishing(session); }

/** サンプルの間も含めた、いちばん大きいところ。書き出す前に「音が割れるか」を先に見せるため。 */
export function truePeakInfo(audio) { return truePeakOf(audio.samples, audio.channels); }

/** いちばん大きいところ。書き出す前に「音が割れるか」を先に見せるため。 */
export function peakOf(audio) {
  let peak = 0;
  const s = audio.samples;
  for (let i = 0; i < s.length; i++) {
    const a = Math.abs(s[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/* ---------------- 多入力：チャンネルを分ける ---------------- */

/** 1つのチャンネルだけを取り出す。 */
export function extractChannel(audio, index) {
  const { samples, frames, channels, sampleRate } = audio;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = samples[i * channels + index];
  return { samples: out, frames, channels: 1, sampleRate, seconds: frames / sampleRate };
}

/** 全チャンネルを別々のモノラルに分ける。 */
export function splitChannels(audio) {
  const out = [];
  for (let c = 0; c < audio.channels; c++) out.push(extractChannel(audio, c));
  return out;
}

/* ---------------- 保険トラックで割れたところを直す ---------------- */

const SAFETY_CLIP = 0.985;      // これ以上は「割れた」とみなす
const SAFETY_BLOCK_MS = 20;
const SAFETY_XFADE_MS = 10;

/**
 * 本線（main）が割れたところだけを、機材側で下げて録った保険（safety）で差し替える。
 * 保険の倍率は、割れていない区間で最小二乗で合わせる（機材の −12 dB などの実際の値が出る）。
 * 割れていなければ null を返す（何もしない）。
 *
 * @returns {{ audio, regions: [{from, to}], gainDb, clippedSeconds }} | null
 */
export function repairWithSafety(audio, main = 0, safety = 1) {
  const { frames, channels, sampleRate } = audio;
  if (channels < 2 || main === safety) return null;
  const A = new Float32Array(frames), B = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { A[i] = audio.samples[i * channels + main]; B[i] = audio.samples[i * channels + safety]; }

  const block = Math.round(sampleRate * SAFETY_BLOCK_MS / 1000);
  const nBlocks = Math.ceil(frames / block);
  const bad = new Uint8Array(nBlocks);
  let anyBad = false;
  for (let b = 0; b < nBlocks; b++) {
    const s = b * block, e = Math.min(frames, s + block);
    for (let i = s; i < e; i++) { if (Math.abs(A[i]) >= SAFETY_CLIP) { bad[b] = 1; anyBad = true; break; } }
  }
  if (!anyBad) return null;

  // 倍率：割れていない、かつ大きすぎない区間で A ≒ g·B
  let ab = 0, bb = 0;
  for (let b = 0; b < nBlocks; b++) {
    if (bad[b]) continue;
    const s = b * block, e = Math.min(frames, s + block);
    for (let i = s; i < e; i++) { if (Math.abs(A[i]) < 0.7) { ab += A[i] * B[i]; bb += B[i] * B[i]; } }
  }
  if (bb <= 1e-12) return null;
  const g = ab / bb;
  if (!(g > 0)) return null;   // 極性が逆か、保険に音が入っていない

  // 割れた塊を前後 1 ブロック広げてつなげる
  const regions = [];
  for (let b = 0; b < nBlocks; b++) {
    if (!bad[b]) continue;
    const from = Math.max(0, b - 1), to = Math.min(nBlocks, b + 2);
    if (regions.length && from <= regions[regions.length - 1].toBlock) regions[regions.length - 1].toBlock = Math.max(regions[regions.length - 1].toBlock, to);
    else regions.push({ fromBlock: from, toBlock: to });
  }

  const out = A.slice();
  const xf = Math.round(sampleRate * SAFETY_XFADE_MS / 1000);
  let clipped = 0;
  const list = [];
  for (const r of regions) {
    const s = r.fromBlock * block, e = Math.min(frames, r.toBlock * block);
    clipped += e - s;
    for (let i = s; i < e; i++) {
      let wB = 1;
      if (i - s < xf) wB = (i - s) / xf;
      if (e - 1 - i < xf) wB = Math.min(wB, (e - 1 - i) / xf);
      const wA = 1 - wB;
      // 等パワーで継ぐ（プチッと言わせない）
      const ca = Math.cos(wB * Math.PI / 2), cb = Math.sin(wB * Math.PI / 2);
      out[i] = A[i] * (wA > 0 ? ca : 0) + g * B[i] * cb;
    }
    list.push({ from: s / sampleRate, to: e / sampleRate });
  }
  return {
    audio: { samples: out, frames, channels: 1, sampleRate, seconds: frames / sampleRate },
    regions: list, gainDb: 20 * Math.log10(g), clippedSeconds: clipped / sampleRate,
  };
}
