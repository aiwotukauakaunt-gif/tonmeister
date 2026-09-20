/*
  多重録音の1セッション。全トラックは同じサンプルレートで、必ず先頭（0秒）から始まる。
  デスクトップ版の Session / Track / Take / TrackProcessing にあたる。
  中身は JSON と WAV だけなので、書き出せばそのまま持ち運べる。
*/

import { SaveFormat } from './wav.js';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newSession() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: uid(),
    name: `セッション_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`,
    sampleRate: 0,
    tracks: [],
    // 「素」と「仕上げ」。仕上げは再生と書き出しのときだけ通る。素の WAV には触らない。
    listen: 'pure',                 // 'pure' | 'finished'  再生のときどちらを聞くか
    finish: newFinish(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 仕上げ（盛り）の既定。すべて切＝素。 */
export function newFinish() {
  return {
    level: 0,                       // 段階ダイヤル 0..3。-1 は「自分で決める」
    mode: 'dial',                   // 'dial' | 'custom'
    rumbleCut: false,               // 30 Hz 以下の風音カット
    normalizeEnabled: false,
    normalizeTargetDb: -1,
    reverb: { enabled: false, hall: 'chamber', seconds: 1.3, amount: 0.3, preDelayMs: 30 },
    micCorrection: false,           // マイクの較正ファイルで色を戻す（仕上げ側。盛りではなく戻し）
    micCal: null,                   // { name, points: [{hz, db}] }（設定から写す。session.json だけで再現できるように）
    measured: null,                 // 最後に測った盛り度（{ grade, gainDb, residualDb, tailSeconds, quietDb, normalizeGainDb, at }）
  };
}

export function newTrack(name, startSeconds = 0) {
  return {
    id: uid(),
    name,
    startSeconds,                   // セッションの中でこのトラックが始まる位置（長時間録音の続きは 0 以外）
    volume: 1,
    muted: false,
    soloed: false,
    activeTakeIndex: 0,
    takes: [],
    processing: {
      humEnabled: false,
      humFrequency: 50,
      humHarmonics: 4,
      gateEnabled: false,
      gateThresholdDb: -60,
      reverbSend: 1,                // このトラックの響きの量（全体の量に対する倍率）
    },
  };
}

export function newTake(name, audioId, { seconds, sampleRate, channels }) {
  return {
    id: uid(),
    name,
    audioId,
    seconds,
    sampleRate,
    channels,
    recordedAt: Date.now(),
  };
}

export function activeTake(track) {
  if (!track.takes.length) return null;
  const i = Math.min(Math.max(0, track.activeTakeIndex | 0), track.takes.length - 1);
  return track.takes[i];
}

export function trackSeconds(track) {
  const t = activeTake(track);
  return t ? t.seconds : 0;
}

/** トラックがセッションの中で終わる位置。 */
export function trackEnd(track) {
  return (track.startSeconds || 0) + trackSeconds(track);
}

export function sessionLength(session) {
  return session.tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
}

export function anySoloed(session) {
  return session.tracks.some(t => t.soloed);
}

/** ミュート・ソロを考慮した実効ゲイン。 */
export function effectiveGain(session, track) {
  if (anySoloed(session)) return track.soloed ? track.volume : 0;
  return track.muted ? 0 : track.volume;
}

/** 仕上げ（盛り）が1つでも入っているか。入っていれば素と仕上げは別の音になる。 */
export function hasFinishing(session) {
  const f = session.finish;
  if (f && (f.normalizeEnabled || f.rumbleCut || (f.reverb && f.reverb.enabled && f.reverb.amount > 0) || (f.micCorrection && f.micCal))) return true;
  return session.tracks.some(t => trackHasFinishing(t));
}

export function trackHasFinishing(track) {
  const p = track.processing || {};
  return !!(p.humEnabled || p.gateEnabled);
}

/** 古いセッションに、素／仕上げの項目を足す。 */
export function upgradeSession(session) {
  if (!session.listen) session.listen = 'pure';
  session.finish = Object.assign(newFinish(), session.finish || {});
  session.finish.reverb = Object.assign(newFinish().reverb, session.finish.reverb || {});
  for (const t of session.tracks || []) {
    t.processing = Object.assign(newTrack('').processing, t.processing || {});
    if (!t.startSeconds) t.startSeconds = 0;
  }
  return session;
}

export function nextTrackName(session) {
  return `トラック ${session.tracks.length + 1}`;
}

export function volumeLabel(v) {
  if (v <= 0.0001) return '-inf';
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function trackInfo(track) {
  const take = activeTake(track);
  if (!take) return '（テイクなし）';
  const t = take.seconds;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t) % 60;
  const len = h >= 1
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
  return `${len}  ${(take.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}k / ${take.channels}ch`;
}

/** 次の録音のファイル名。デスクトップ版の NextRecordingPath と同じ付け方。 */
export function nextFileName(session, save, target) {
  const prefix = target
    ? `track${String(session.tracks.indexOf(target) + 1).padStart(2, '0')}_take${String(target.takes.length + 1).padStart(2, '0')}`
    : `track${String(session.tracks.length + 1).padStart(2, '0')}`;
  const suffix = save === SaveFormat.Float32 ? '32f' : '24';
  return `${prefix}_${suffix}.wav`;
}
