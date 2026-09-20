/*
  Tonmeister — 画面の共有部品：状態・エンジン・DOM の小物・音の読み書き・報せの帯・問い。
  app.js から動きを変えずに分けたもの。共有の状態は context.js。
*/

import { Engine, delay } from '../engine.js';
import * as store from '../store.js';
import * as M from '../model.js';
import * as Meter from '../meterscale.js';
import * as Wave from '../waveform.js';
import * as Edit from '../edit.js';
import * as Analysis from '../analysis.js';
import { encodeWav, decodeWav, SaveFormat, formatLabel } from '../wav.js';
import * as Finish from '../finish.js';
import { HALLS, hallName } from '../reverb.js';
import { DiskMirror } from '../disk-writer.js';
import * as Quality from '../quality.js';
import * as Sweep from '../sweep.js';
import * as MicCal from '../miccal.js';
import * as Importer from '../importer.js';
import { T, setLang, applyStatic, currentLang } from '../i18n.js';
import { encodeFlac } from '../flac.js';
import { sessionMeta } from './export.js';
import { rebuildLanes, updateSessionUi } from './overdub.js';
import { addRecordedTake } from './record.js';
import { newSession } from './sessions.js';

/* ================= 小物 ================= */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const show = (el, on = true) => { if (el) el.hidden = !on; };
export const setText = (el, t) => { if (el) el.textContent = T(String(t)); };   // 辞書に載っている文はそのまま英語になる

/** 録り直しの前に何秒ぶん聴かせるか（助走）。 */
export const PREROLL_SECONDS = 2.0;


/* ================= 状態 ================= */

export const engine = new Engine();

export const state = {
  session: M.newSession(),
  mode: 'record',                 // 'record' | 'overdub'
  settings: {
    deviceId: '',
    sampleRate: 48000,
    channelCount: 0,              // 0 = 機器まかせ
    saveFormat: SaveFormat.Float32,
    latencyFrames: 0,
    latencyMeasured: false,
    outputDeviceId: '',
    openInputOnStartup: true,
    rawCapture: true,             // 生フレーム取得（使えるブラウザでは既定で使う）
    prerollSeconds: 5,            // 押す前の音を何秒残すか
    recordChannels: null,         // 録るチャンネル（入力の番号の配列）。null なら全部
    recordMode: 'mix',            // 'mix' = 1本に / 'split' = 各チャンネルを別トラックに / 'safety' = ch2 を ch1 の保険に
    autoLatency: true,            // 開いたときにズレ合わせを測る
    mirrorEnabled: false,         // 録りながら自分のフォルダにも WAV を書く
    driftCompensate: true,        // クロックのずれを、重ね録りのとき再生側で相殺する
    driftMemory: {},              // 機器の組ごとの最後のずれ（ppm）。開いてすぐの重ね録りで使う
    micCal: null,                 // マイクの較正ファイル { name, points }
    hostCapture: true,            // keyboard の中で開いたとき、アプリ音を別トラックに録る
    processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    lastSessionId: null,
  },
  fake: new URLSearchParams(location.search).has('fake'),   // 検証用：マイクの代わりに合成音
  mirrorDir: null,                // フォルダ直書きの先（FileSystemDirectoryHandle）
  wakeLock: null,
  latencyAutoDone: false,
  grade: null, grading: false, gradeAt: 0,   // 経路の格
  trial: false,
  verify: null,                              // 最後の経路検証の結果（録音証明に載せる）
  measureMode: 'loopback', measureBusy: false, lastResponse: null, lastRoom: null, lastTone: null,
  compare: [null, null, null],
  storageMinutes: Infinity, storageWarned: false,
  pendingMarkers: [],              // 録音中に打った印（秒）。止めたときに録りへ
  lastSavedBytes: 0,
  lanes: [],
  selectedLane: null,
  punch: null,                    // {track, at} 録り直し中
  removed: null,                  // 直前に外したトラック（1つだけ戻せる）
  recPeak: 0, recFlats: 0,
  hold: 0, holdAt: 0,
  verdict: 'unknown', pending: 'unknown', pendingSince: 0,
  outHold: 0, outHoldAt: 0, outputPeakDb: -Infinity, silentSince: 0,
  live: [],
  monitorWarned: false,
  alignToastShown: false,
  noticeTimer: null, noticeAction: null,
  diagHistory: [],
  exportFormat: SaveFormat.Float32,
  exportAudio: null,
  exportFinished: null,
  editor: null,
  dirty: false,
};

export const LIVE_CAPACITY = 450;        // 33ms × 450 ≒ 15 秒
export const audioCache = new Map();     // takeId → 復号した音


/* ================= 音の読み書き ================= */

export async function loadTake(take) {
  if (!take) return null;
  if (audioCache.has(take.id)) return audioCache.get(take.id);
  const blob = await store.getAudio(take.audioId);
  if (!blob) return null;
  const audio = decodeWav(await blob.arrayBuffer());
  audioCache.set(take.id, audio);
  return audio;
}

export async function saveTakeAudio(audio, format) {
  const id = M.uid();
  const blob = encodeWav(audio.samples, audio.channels, audio.sampleRate, format);
  await store.putAudio(id, blob);
  state.lastSavedBytes = blob.size;
  return id;
}

/** セッションの保存。フォルダを選んであれば、少し待ってから session.json の写しも書く（自動バックアップ）。 */
export async function saveSession(session) {
  const r = await store.saveSession(session);
  scheduleBackup();
  return r;
}

export let backupTimer = null;
export function scheduleBackup() {
  if (!state.mirrorDir || !engine.mirror) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backupSessionJson, 5000);
}

export async function backupSessionJson() {
  if (!state.mirrorDir || !engine.mirror) return;
  try {
    const sub = await state.mirrorDir.getDirectoryHandle(state.session.name.replace(/[\\/:*?"<>|]/g, '_'), { create: true });
    const fh = await sub.getFileHandle('session.json', { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(JSON.stringify(sessionMeta(), null, 2));
    await w.close();
  } catch { }
}


/* ================= 報せの帯 ================= */

/**
 * 画面の上に短く出す一言。叱るためではなく、次にやることを示すために出す。
 * action を渡すと、その場で1つだけ操作を足せる（取り消しなど）。
 */
export function showNotice(text, warn, actionLabel, action) {
  const strip = $('#notice');
  setText($('#txt-notice'), text);
  strip.classList.toggle('warn', !!warn);
  $('#notice-dot').className = 'dot ' + (warn ? 'warn' : 'gold');

  state.noticeAction = action || null;
  const btn = $('#btn-notice-action');
  setText(btn, actionLabel || '');
  show(btn, !!action);

  show(strip, true);
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(hideNotice, 14000);
}

export function hideNotice() {
  clearTimeout(state.noticeTimer);
  show($('#notice'), false);
  state.noticeAction = null;
}


/* ================= 問いと注意 ================= */

export function ask(title, body, okLabel = '続ける', cancelLabel = 'やめる') {
  const dlg = $('#dlg-ask');
  setText($('#ask-title'), title);
  setText($('#ask-body'), body);
  setText($('#ask-ok'), T(okLabel));
  setText($('#ask-cancel'), T(cancelLabel));
  show($('#ask-cancel'), true);
  dlg.showModal();
  return new Promise(resolve => {
    const done = (v) => { dlg.close(); $('#ask-ok').onclick = null; $('#ask-cancel').onclick = null; resolve(v); };
    $('#ask-ok').onclick = () => done(true);
    $('#ask-cancel').onclick = () => done(false);
  });
}

export function showError(message) {
  const dlg = $('#dlg-ask');
  setText($('#ask-title'), 'Tonmeister');
  setText($('#ask-body'), message);
  setText($('#ask-ok'), T('分かりました'));
  show($('#ask-cancel'), false);
  dlg.showModal();
  $('#ask-ok').onclick = () => { dlg.close(); $('#ask-ok').onclick = null; };
}

export function busy(text) { setText($('#busy-text'), text); show($('#busy'), true); }
export function unbusy() { show($('#busy'), false); }


/* ================= セッションの出し入れ ================= */

export async function loadLatestOrNewSession() {
  const list = await store.listSessions();
  let session = null;
  if (state.settings.lastSessionId) session = list.find(s => s.id === state.settings.lastSessionId) || null;
  if (!session) session = list[0] || null;
  await setSession(session || M.newSession());
  if (!list.length) await saveSession(state.session);
}

export async function setSession(session) {
  state.session = M.upgradeSession(session);
  if (engine.mirror && state.mirrorDir) engine.mirror = new DiskMirror(state.mirrorDir, session.name);
  state.settings.lastSessionId = session.id;
  await store.setSettings(state.settings);
  audioCache.clear();
  Wave.clearCache();
  rebuildLanes();
  updateSessionUi();
}

export function autoSave() {
  if (!state.dirty || engine.isRecording) return;
  state.dirty = false;
  saveSession(state.session).catch(() => { state.dirty = true; });
}

export const touch = () => { state.dirty = true; };

/**
 * 前回、録音の途中で閉じてしまった音を拾う。
 * デスクトップ版の「壊れた WAV ヘッダの自動修復」にあたる。
 */
export async function recoverOrphans() {
  let orphans = [];
  try { orphans = await Engine.listOrphanRecordings(); } catch { return; }
  const usable = orphans.filter(o => o.frames > o.sampleRate * 0.5);
  for (const o of orphans) if (!usable.includes(o)) await Engine.dropOrphanRecording(o.recId);
  if (!usable.length) return;

  const total = usable.reduce((a, o) => a + o.frames / o.sampleRate, 0);
  const ok = await ask('録音ファイルの修復',
    `前回の録音が正常に終わっていませんでした。\n録れていた ${total.toFixed(1)} 秒を、いまのセッションに足せます。\n\n足しますか？（やめると消えます）`,
    '足す', '消す');

  for (const o of usable) {
    if (ok) {
      const audio = await Engine.takeOrphanRecording(o.recId);
      // 録り終わりの一言は録音中のピークを見るので、復元した音のぶんはここで測っておく
      if (audio) { state.recPeak = Edit.truePeakInfo(audio).truePeak; state.recFlats = 0; await addRecordedTake(audio, null, '（復元）'); }
    }
    await Engine.dropOrphanRecording(o.recId);
  }
}
