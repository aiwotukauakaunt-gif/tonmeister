/*
  Tonmeister — 録音一覧・持ち込み・元に戻す。
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
import { $, ask, audioCache, busy, engine, saveSession, saveTakeAudio, setSession, setText, show, showError, showNotice, state, unbusy } from './context.js';
import { rebuildLanes, restartPlaybackInPlace, updateFinishUi, updateSessionUi } from './overdub.js';
import { addRecordedTake, codingHistory, setMode, stopAll } from './record.js';

/* ================= 元に戻す ================= */
/*
   セッション（JSON）を丸ごと控える。音そのものは消さないので、控えを戻すだけでどの操作も戻せる。
   名前・テイクの選び直し・音量・消音・単独・仕上げ・外す・切り出し・録り直し・読み込み。
*/
export const history = { undo: [], redo: [] };
export const HISTORY_MAX = 50;

export function snapshot(label) {
  history.undo.push({ label, json: JSON.stringify(state.session) });
  if (history.undo.length > HISTORY_MAX) history.undo.shift();
  history.redo.length = 0;
}

export async function restoreSnapshot(json) {
  const restored = M.upgradeSession(JSON.parse(json));
  if (restored.id !== state.session.id) return false;   // 別のセッションに移っていたら戻さない
  state.session = restored;
  await saveSession(state.session);
  rebuildLanes();
  updateSessionUi();
  updateFinishUi();
  setMode(state.session.tracks.length === 0 ? 'record' : 'overdub');
  if (engine.isPlaying) await restartPlaybackInPlace();
  return true;
}

export async function undo() {
  if (engine.isRecording) return;
  const h = history.undo.pop();
  if (!h) { showNotice(T('戻すものがありません。'), false); return; }
  history.redo.push({ label: h.label, json: JSON.stringify(state.session) });
  if (await restoreSnapshot(h.json)) showNotice(T('戻しました：{label}', { label: h.label }), false, T('やり直す'), redo);
}

export async function redo() {
  if (engine.isRecording) return;
  const h = history.redo.pop();
  if (!h) return;
  history.undo.push({ label: h.label, json: JSON.stringify(state.session) });
  if (await restoreSnapshot(h.json)) showNotice(T('やり直しました：{label}', { label: h.label }), false);
}


/* ================= 録音一覧 ================= */

export async function openSessions() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  show($('#list-popup'), false);
  await saveSession(state.session);

  const list = await store.listSessions();
  const host = $('#session-list');
  host.innerHTML = '';
  const est = await store.estimate();
  const sizeOf = (sess) => (sess.tracks || []).reduce((a, t) => a + (t.takes || []).reduce((b, k) => b + (k.bytes || Math.round((k.seconds || 0) * (k.sampleRate || 48000) * (k.channels || 2) * 4)), 0), 0);
  const mb = (b) => b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  const totalBytes = list.reduce((a, x) => a + sizeOf(x), 0);
  setText($('#txt-sessions-total'), `${list.length} 件・音 ${mb(totalBytes)}` + (est && est.quota ? `　このブラウザの空き ${mb(Math.max(0, est.quota - est.usage))}` : ''));
  state.sessionPick = new Set();
  $('#btn-sessions-delete').disabled = true;

  for (const s of list) {
    const len = (s.tracks || []).reduce((m, t) => {
      const take = t.takes && t.takes[Math.min(t.activeTakeIndex, t.takes.length - 1)];
      return Math.max(m, (t.startSeconds || 0) + (take ? take.seconds : 0));
    }, 0);
    const row = document.createElement('div');
    row.className = 'session-row' + (s.id === state.session.id ? ' on' : '');
    row.innerHTML = '<input class="s-pick" type="checkbox" title="まとめて消すときに選ぶ"><span class="s-name"></span><span class="s-meta"></span>' +
      '<button class="btn btn-small ghosty s-del" type="button" title="この録音を消す">✕</button>';
    setText($('.s-name', row), s.name);
    setText($('.s-meta', row),
      `${(s.tracks || []).length} トラック　${Meter.mmss(len)}　${mb(sizeOf(s))}　${new Date(s.updatedAt || s.createdAt).toLocaleString('ja-JP')}`);
    $('.s-pick', row).onclick = (ev) => {
      ev.stopPropagation();
      if (ev.target.checked) state.sessionPick.add(s.id); else state.sessionPick.delete(s.id);
      $('#btn-sessions-delete').disabled = state.sessionPick.size === 0;
      setText($('#btn-sessions-delete'), state.sessionPick.size ? `選んだ ${state.sessionPick.size} 件を消す` : '選んだものを消す');
    };

    row.onclick = async (ev) => {
      if (ev.target.classList.contains('s-del') || ev.target.classList.contains('s-pick')) return;
      $('#dlg-sessions').close();
      if (s.id === state.session.id) return;
      await setSession(await store.loadSession(s.id));
      setMode(state.session.tracks.length === 0 ? 'record' : 'overdub');
    };
    $('.s-del', row).onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await ask('この録音を消す',
        `「${s.name}」を消します。音のファイルも一緒に消えます。\nこれは元に戻せません。`, '消す');
      if (!ok) return;
      await store.deleteSession(s.id);
      if (s.id === state.session.id) { await setSession(M.newSession()); await saveSession(state.session); setMode('record'); }
      await openSessions();
    };
    host.appendChild(row);
  }
  $('#dlg-sessions').showModal();
}


/* ================= 持ち込み ================= */

export async function importSessionFolder() {
  show($('#list-popup'), false);
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから読み込んでください。'); return; }
  let picked;
  try { picked = await Importer.pickFolderFiles(); }
  catch (e) { if (e && e.name !== 'AbortError') showError(e.message); return; }
  if (!picked.files.length) { showError('ファイルがありません。'); return; }
  busy('読んでいます…');
  try {
    const { session, audios, warnings } = await Importer.importSession(picked.files, { onProgress: busy });
    // 置き場所へ入れる（素のまま。float32 で保存すれば 24bit の値も完全に戻る）
    let n = 0;
    for (const t of session.tracks) for (const k of t.takes) {
      busy(`置き場所へ入れています… ${++n}`);
      const audio = audios.get(k.id);
      k.audioId = await saveTakeAudio(audio, SaveFormat.Float32);
      k.bytes = state.lastSavedBytes;
      audioCache.set(k.id, audio);
    }
    await stopAll();
    await saveSession(state.session);
    await setSession(session);
    await saveSession(state.session);
    history.undo.length = 0; history.redo.length = 0;
    setMode('overdub');
    showNotice(`「${session.name}」を読み込みました（${session.tracks.length} トラック）。` + (warnings.length ? `　注意：${warnings.join('／')}` : ''), warnings.length > 0);
  } catch (e) { showError('読み込めませんでした: ' + e.message); }
  finally { unbusy(); }
}

/** 1本の WAV を新しいトラックとして足す。 */
export async function importWavFiles(files) {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから足してください。'); return; }
  const list = [...files].filter(f => /\.wav$/i.test(f.name));
  if (!list.length) { showError('WAV を選んでください。'); return; }
  busy('読んでいます…');
  try {
    snapshot('WAV を足す');
    for (const f of list) {
      const { audio, startSeconds, name } = await Importer.importWav(f);
      if (state.session.sampleRate > 0 && audio.sampleRate !== state.session.sampleRate) {
        showError(`「${f.name}」は ${audio.sampleRate} Hz で、この録音（${state.session.sampleRate} Hz）と揃いません。変換はしないので足せません。新しく始めてから足してください。`);
        continue;
      }
      state.recPeak = Edit.truePeakInfo(audio).truePeak; state.recFlats = 0;
      const tr = await addRecordedTake(audio, null, '（持ち込み）', { startSeconds, trackName: name, quiet: true });
      if (tr) { const k = tr.takes[tr.takes.length - 1]; k.provenance = Object.assign(k.provenance || {}, { imported: true, file: f.name, codingHistory: audio.bext ? audio.bext.codingHistory : null }); }
    }
    await saveSession(state.session);
    setMode('overdub');
    showNotice(`${list.length} 本の WAV を足しました。素のまま（変換なし）です。`, false);
  } catch (e) { showError('読み込めませんでした: ' + e.message); }
  finally { unbusy(); }
}

export async function newSession() {
  show($('#list-popup'), false);
  await stopAll();
  await saveSession(state.session);
  await setSession(M.newSession());
  await saveSession(state.session);
  setMode('record');
  showNotice(T('新しく始めました。'), false);
}

