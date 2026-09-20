/*
  持ち込み。丸ごと書き出したフォルダ（session.json ＋ WAV）と、デスクトップ版のセッションフォルダを
  そのまま読む。名前・トラック・テイク・仕上げの設定が戻る。WAV は素のまま置き場所へ入れる（再標本化も変換もしない）。
  1本の WAV を新しいトラックとして足すこともできる。

  デスクトップ版の session.json：
    { Name, SampleRate, Tracks: [{ Name, Volume, Muted, Soloed, ActiveTakeIndex, Processing, Takes: [{ Name, Files: [..], Seconds, SampleRate, Channels, RecordedAt }] }], Hall }
  Web 版はこれに StartSeconds / Gaps / Clicks / Provenance / Finish / Listen を足した形。
*/

import { decodeWav } from './wav.js';
import * as M from './model.js';

/** ファイル名だけで引けるように。サブフォルダ込みでも最後の名前で探す。 */
function indexFiles(files) {
  const map = new Map();
  for (const f of files) {
    const name = (f.webkitRelativePath || f.name).split('/').pop();
    map.set(name, f);
    map.set(f.name, f);
  }
  return map;
}

async function readWav(file) {
  const buf = await file.arrayBuffer();
  return decodeWav(buf);
}

/** 複数ファイルに分かれたテイク（デスクトップ版の 4GB 分割）を1本に繋ぐ。 */
function joinAudios(list) {
  if (list.length === 1) return list[0];
  const channels = list[0].channels, sampleRate = list[0].sampleRate;
  let total = 0;
  for (const a of list) total += a.samples.length;
  const samples = new Float32Array(total);
  let o = 0;
  for (const a of list) { samples.set(a.samples, o); o += a.samples.length; }
  const frames = Math.floor(total / channels);
  return { samples, frames, channels, sampleRate, seconds: frames / sampleRate, bext: list[0].bext };
}

/**
 * フォルダの中身（File の配列）からセッションを組み立てる。
 * @returns {{ session, audios: Map<takeId, audio>, warnings: string[] }}
 */
export async function importSession(files, { onProgress } = {}) {
  const idx = indexFiles(files);
  const metaFile = idx.get('session.json');
  if (!metaFile) throw new Error('session.json が見つかりません。丸ごと書き出したフォルダ（session.json ＋ WAV）を選んでください。');
  const meta = JSON.parse(await metaFile.text());
  const warnings = [];

  const session = M.newSession();
  session.name = (meta.Name || meta.name || session.name) + '';
  session.sampleRate = +(meta.SampleRate || meta.sampleRate || 0);
  session.listen = meta.Listen || 'pure';
  if (meta.Finish) {
    const F = meta.Finish;
    session.finish.level = F.Level ?? 0; session.finish.mode = F.Mode || 'dial';
    session.finish.rumbleCut = !!F.RumbleCut; session.finish.normalizeEnabled = !!F.NormalizeEnabled;
    session.finish.normalizeTargetDb = F.NormalizeTargetDb ?? -1;
    if (F.Reverb) session.finish.reverb = { enabled: !!F.Reverb.Enabled, hall: F.Reverb.Kind || 'chamber', seconds: F.Reverb.DecaySeconds || 1.3, amount: (F.Reverb.MixPercent ?? 30) / 100, preDelayMs: F.Reverb.PreDelayMs ?? 30 };
    session.finish.measured = F.Measured || null;
  } else if (meta.Hall) {
    // デスクトップ版のホール
    const H = meta.Hall;
    const kinds = ['room', 'chamber', 'hall', 'church'];
    session.finish.reverb = { enabled: !!H.Enabled, hall: typeof H.Kind === 'number' ? (kinds[H.Kind] || 'hall') : String(H.Kind || 'hall').toLowerCase(), seconds: H.DecaySeconds || 0, amount: (H.MixPercent ?? 25) / 100, preDelayMs: H.PreDelayMs ?? 30 };
    if (session.finish.reverb.enabled) { session.finish.mode = 'custom'; session.finish.level = -1; }
  }

  const audios = new Map();
  const tracks = meta.Tracks || meta.tracks || [];
  let n = 0, total = 0;
  for (const t of tracks) total += (t.Takes || []).length;

  for (const T of tracks) {
    const track = M.newTrack(T.Name || `トラック ${session.tracks.length + 1}`, +(T.StartSeconds || 0));
    track.volume = T.Volume ?? 1; track.muted = !!T.Muted; track.soloed = !!T.Soloed;
    if (T.Processing) {
      const P = T.Processing;
      track.processing.humEnabled = !!P.HumEnabled; track.processing.humFrequency = P.HumFrequency || 50;
      track.processing.humHarmonics = P.HumHarmonics || 4; track.processing.gateEnabled = !!P.GateEnabled;
      track.processing.gateThresholdDb = P.GateThresholdDb ?? -60; track.processing.reverbSend = P.ReverbSend ?? 1;
    }
    for (const K of (T.Takes || [])) {
      n++;
      onProgress && onProgress(`読んでいます… ${n}/${total}`);
      const names = K.Files || [];
      const parts = [];
      for (const name of names) {
        const f = idx.get(name) || idx.get(name.split(/[\\/]/).pop());
        if (!f) { warnings.push(`${name} が見つかりません`); continue; }
        try { parts.push(await readWav(f)); } catch (e) { warnings.push(`${name} を読めません: ${e.message}`); }
      }
      if (!parts.length) continue;
      const audio = joinAudios(parts);
      const take = M.newTake(K.Name || `${track.takes.length + 1}回目の録り`, null, audio);
      if (K.RecordedAt) { const d = Date.parse(K.RecordedAt); if (isFinite(d)) take.recordedAt = d; }
      if (K.Gaps && K.Gaps.length) take.gaps = K.Gaps;
      if (K.Clicks && K.Clicks.length) take.clicks = K.Clicks;
      if (K.Provenance) take.provenance = K.Provenance;
      else if (audio.bext) take.provenance = { at: `${audio.bext.date}T${audio.bext.time}`, imported: true, codingHistory: audio.bext.codingHistory };
      if (!T.StartSeconds && audio.bext && audio.bext.timeReference > 0 && !track.takes.length) {
        track.startSeconds = audio.bext.timeReference / audio.sampleRate;   // BWF の TimeReference から開始位置
      }
      track.takes.push(take);
      audios.set(take.id, audio);
      if (!session.sampleRate) session.sampleRate = audio.sampleRate;
      else if (audio.sampleRate !== session.sampleRate) warnings.push(`${take.name} のレート ${audio.sampleRate} Hz がセッション（${session.sampleRate} Hz）と違います`);
    }
    if (track.takes.length) {
      track.activeTakeIndex = Math.min(Math.max(0, T.ActiveTakeIndex | 0), track.takes.length - 1);
      session.tracks.push(track);
    }
  }
  if (!session.tracks.length) throw new Error('読める WAV がありませんでした。' + (warnings.length ? '\n' + warnings.join('\n') : ''));
  return { session, audios, warnings };
}

/** 1本の WAV を読む（新しいトラックとして足すため）。bext があれば開始位置も。 */
export async function importWav(file) {
  const audio = await readWav(file);
  const startSeconds = audio.bext && audio.bext.timeReference > 0 ? audio.bext.timeReference / audio.sampleRate : 0;
  return { audio, startSeconds, name: file.name.replace(/\.wav$/i, '') };
}

/** フォルダ選択（対応ブラウザ）か、ファイル選択（それ以外）でファイルの配列を得る。 */
export async function pickFolderFiles() {
  if (window.showDirectoryPicker) {
    const dir = await window.showDirectoryPicker({ mode: 'read', id: 'tonmeister-import' });
    const files = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      if (!/\.(wav|json)$/i.test(name)) continue;
      files.push(await h.getFile());
    }
    return { files, folderName: dir.name };
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.accept = '.wav,.json';
    input.onchange = () => resolve({ files: [...input.files], folderName: '' });
    input.oncancel = () => reject(new DOMException('cancel', 'AbortError'));
    input.click();
  });
}
