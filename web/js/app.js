/*
  Tonmeister — 楽器のための録音機（Web 版）

  デスクトップ版（WPF）の MainWindow / TrackLane / 各窓をブラウザへ移したもの。
  画面は「録る」「重ねる」の2モードに分かれ、アプリが自動で切り替える。
  専門用語は「詳しい設定」1枚に隔離してある。
*/

import { Engine, delay } from './engine.js';
import * as store from './store.js';
import * as M from './model.js';
import * as Meter from './meterscale.js';
import * as Wave from './waveform.js';
import * as Edit from './edit.js';
import * as Analysis from './analysis.js';
import { encodeWav, decodeWav, SaveFormat, formatLabel } from './wav.js';
import * as Finish from './finish.js';
import { HALLS, hallName } from './reverb.js';
import { DiskMirror } from './disk-writer.js';
import * as Quality from './quality.js';
import * as Sweep from './sweep.js';
import * as MicCal from './miccal.js';
import * as Importer from './importer.js';
import { T, setLang, applyStatic, currentLang } from './i18n.js';
import { encodeFlac } from './flac.js';
import { $, $$, ask, audioCache, autoSave, busy, engine, hideNotice, loadLatestOrNewSession, recoverOrphans, saveSession, saveTakeAudio, setSession, setText, show, showError, showNotice, state, unbusy } from './ui/context.js';
import { analyzeTrack, checkProcessing, compareRecord, measureSilence, measureSweep, measureTone, openCompare, openDiagnostics, openMeasure, renderCompare, updateMeasureUi, verifyPath } from './ui/diagnostics.js';
import { doExport, exportSessionFolder, openExport, updateExportCards, updateExportPeak } from './ui/export.js';
import { changeFinish, drawEditor, drawRuler, measureFinishNow, openEditor, redrawLanes, removeTrack, setDial, setHoldPure, setListen, setSwitch, stopEditorPlayback, switchOn, updateFinishUi, updateSessionUi, wireEditor } from './ui/overdub.js';
import { addMarker, assessNow, autoMeasureLatency, buildOrnaments, drawScale, guardRecording, measureLatency, openInput, scheduleAssess, seekBy, setMode, startPlayback, startRecording, stopAll, toggleMonitor, trialGain, uiTick, updateInputStatus, updateStorageLeft } from './ui/record.js';
import { importSessionFolder, importWavFiles, newSession, openSessions, redo, snapshot, undo } from './ui/sessions.js';
import { chooseMirrorFolder, clearMirrorFolder, needsGesture, openSettings, platformNotes, refreshDeviceList, registerServiceWorker, reopenInput, setupMirror, showTapStart, toggleLang, updateLangButton, updateSettingsDialog } from './ui/settings.js';

/* ================= 起動 ================= */

export async function init() {
  applyStatic(document);
  document.documentElement.lang = currentLang();
  updateLangButton();
  buildOrnaments();
  wireEvents();

  state.settings = Object.assign(state.settings, await store.getSettings());
  await loadLatestOrNewSession();

  setMode(state.session.tracks.length === 0 ? 'record' : 'overdub');
  updateSessionUi();

  // 起動直後にメーターが動いていないと「音量を合わせる」ができない。
  // 失敗しても止めない（状態ピルに理由が出る）。
  if (state.settings.openInputOnStartup) {
    try { await openInput(); }
    catch (err) {
      updateInputStatus();
      // 操作なしでは開けない環境（iOS Safari、自動再生の制限）では、まずタップしてもらう
      if (needsGesture(err)) showTapStart();
      else showNotice(err.message, true, '詳しい設定', openSettings);
    }
  } else {
    updateInputStatus();
  }
  // 開けたが AudioContext が止まったまま（自動再生の制限）なら、最初のタップで起こす
  if (engine.ctx && engine.ctx.state === 'suspended') showTapStart();
  registerServiceWorker();
  platformNotes();

  await recoverOrphans();
  await setupMirror();
  guardRecording();
  if (engine.isOpen) { autoMeasureLatency(); scheduleAssess(1200); }

  setInterval(uiTick, 33);
  updateStorageLeft();
  setInterval(updateStorageLeft, 15000);
  setInterval(autoSave, 20000);   // セッションは20秒ごとに自動保存
  window.addEventListener('resize', () => { drawScale(); drawRuler(); redrawLanes(); drawEditor(); });
  window.addEventListener('beforeunload', () => { try { saveSession(state.session); } catch { } });
}







/* ================= 配線 ================= */

export function wireEvents() {
  engine.onError = (msg) => showNotice(msg, true);

  $('#tab-record').onclick = () => setMode('record');
  $('#tab-overdub').onclick = () => {
    if (state.session.tracks.length === 0) {
      // まだ重ねるものが無い。ここで叱らず、やることを示すだけにする。
      setText($('#txt-verdict'), 'まず1本録ってください。録れたらこのタブが使えるようになります。');
      return;
    }
    setMode('overdub');
  };

  $('#btn-record-big').onclick = () => startRecording();
  $('#btn-record-small').onclick = () => startRecording();
  $('#btn-add-layer').onclick = () => startRecording(null);
  $('#btn-play').onclick = startPlayback;
  $('#btn-stop').onclick = stopAll;
  $('#btn-stop-big').onclick = stopAll;
  $('#btn-monitor').onclick = toggleMonitor;
  $('#btn-align').onclick = measureLatency;
  $('#btn-toast-measure').onclick = async () => { show($('#align-toast'), false); await stopAll(); await measureLatency(); };

  $('#btn-check').onclick = () => { show($('#list-popup'), false); openDiagnostics(); };
  $('#btn-check2').onclick = openDiagnostics;
  $('#btn-menu-measure').onclick = () => { show($('#list-popup'), false); openMeasure(); };
  $('#btn-menu-compare').onclick = () => { show($('#list-popup'), false); openCompare(); };
  $('#btn-more-record').onclick = () => { const p = $('#pnl-more-record'); show(p, p.hidden); show($('#txt-monitor-info'), !p.hidden && engine.isOpen); };
  $('#btn-more-diag').onclick = () => { const p = $('#pnl-more-diag'); show(p, p.hidden); setText($('#btn-more-diag'), p.hidden ? 'ほかの測り方 ▸' : 'ほかの測り方 ▾'); };
  $('#btn-settings-advanced').onclick = () => {
    const p = $('#pnl-settings-advanced');
    show(p, p.hidden);
    $('#btn-settings-advanced').firstChild.textContent = p.hidden ? 'くわしい設定 ▸' : 'くわしい設定 ▾';
  };
  $('#pill-grade').onclick = () => { const g = $('#path-grade'); show(g, g.hidden); };
  $('#btn-export').onclick = openExport;
  $('#btn-export-2').onclick = openExport;
  $('#btn-settings').onclick = () => { show($('#list-popup'), false); openSettings(); };
  $('#btn-lang').onclick = () => { show($('#list-popup'), false); toggleLang(); };
  $('#btn-change-input').onclick = openSettings;
  $('#btn-edit-track').onclick = openEditor;
  $('#btn-remove-track').onclick = removeTrack;

  $('#btn-list').onclick = () => show($('#list-popup'), $('#list-popup').hidden);
  $('#btn-new-session').onclick = newSession;
  $('#btn-open-sessions').onclick = openSessions;
  $('#btn-export-folder').onclick = exportSessionFolder;
  $('#btn-sessions-new').onclick = async () => { $('#dlg-sessions').close(); await newSession(); };
  $('#btn-sessions-import').onclick = async () => { $('#dlg-sessions').close(); await importSessionFolder(); };
  $('#btn-sessions-delete').onclick = async () => {
    const ids = [...(state.sessionPick || [])];
    if (!ids.length) return;
    const ok = await ask('まとめて消す', `${ids.length} 件の録音を消します。音のファイルも一緒に消えます。\nこれは元に戻せません。`, '消す');
    if (!ok) return;
    busy('消しています…');
    try {
      for (const id of ids) {
        await store.deleteSession(id);
        if (id === state.session.id) { await setSession(M.newSession()); await saveSession(state.session); setMode('record'); }
      }
    } finally { unbusy(); }
    await openSessions();
    updateStorageLeft();
  };
  $('#btn-import-session').onclick = importSessionFolder;
  $('#btn-add-wav').onclick = () => $('#file-wav').click();
  $('#file-wav').onchange = async (e) => { const fs = e.target.files; if (fs && fs.length) await importWavFiles(fs); e.target.value = ''; };
  // レーンへ WAV を落とす
  const dropHost = $('#stage');
  dropHost.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dropHost.classList.add('dropping'); } });
  dropHost.addEventListener('dragleave', () => dropHost.classList.remove('dropping'));
  dropHost.addEventListener('drop', async (e) => {
    dropHost.classList.remove('dropping');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.some(f => f.name === 'session.json')) {
      busy('読んでいます…');
      try {
        const { session, audios, warnings } = await Importer.importSession(files, { onProgress: busy });
        for (const t of session.tracks) for (const k of t.takes) { const a = audios.get(k.id); k.audioId = await saveTakeAudio(a, SaveFormat.Float32); k.bytes = state.lastSavedBytes; audioCache.set(k.id, a); }
        await stopAll(); await saveSession(state.session); await setSession(session); await saveSession(state.session); setMode('overdub');
        showNotice(`「${session.name}」を読み込みました。` + (warnings.length ? `　注意：${warnings.join('／')}` : ''), warnings.length > 0);
      } catch (err) { showError('読み込めませんでした: ' + err.message); }
      finally { unbusy(); }
    } else {
      await importWavFiles(files);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    const p = $('#list-popup');
    if (!p.hidden && !p.contains(e.target) && e.target !== $('#btn-list')) show(p, false);
    for (const vp of $$('.vol-popup')) {
      if (!vp.hidden && !vp.contains(e.target) && !e.target.classList.contains('vol')) show(vp, false);
    }
  });

  // 録音の名前
  const nameEl = $('#txt-session'), nameEdit = $('#edt-session');
  nameEl.onclick = () => {
    nameEdit.value = state.session.name;
    show(nameEdit, true); show(nameEl, false);
    nameEdit.focus(); nameEdit.select();
  };
  const commit = async () => {
    if (nameEdit.hidden) return;
    const name = nameEdit.value.trim();
    show(nameEdit, false); show(nameEl, true);
    if (name && name !== state.session.name) {
      snapshot(`録音の名前「${state.session.name}」→「${name}」`);
      state.session.name = name;
      await saveSession(state.session);
      updateSessionUi();
    }
  };
  nameEdit.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { show(nameEdit, false); show(nameEl, true); }
  };
  nameEdit.onblur = commit;

  // 報せの帯
  $('#btn-notice-close').onclick = hideNotice;
  $('#btn-notice-action').onclick = () => { const a = state.noticeAction; hideNotice(); a && a(); };

  // 後処理の摘み
  const onProcessing = async () => {
    const lane = state.selectedLane;
    if (!lane) return;
    await changeFinish(() => {
      lane.track.processing.humEnabled = switchOn($('#tgl-hum'));
      lane.track.processing.gateEnabled = switchOn($('#tgl-gate'));
    }, true);
  };
  $('#tgl-normalize').onclick = () => changeFinish(() => { state.session.finish.normalizeEnabled = !state.session.finish.normalizeEnabled; });
  $('#tgl-rumble').onclick = () => changeFinish(() => { state.session.finish.rumbleCut = !state.session.finish.rumbleCut; }, true);
  $('#tgl-reverb').onclick = () => changeFinish(() => { state.session.finish.reverb.enabled = !state.session.finish.reverb.enabled; }, true);
  $('#rng-rv-seconds').oninput = (e) => { setText($('#txt-rv-seconds'), `${(+e.target.value).toFixed(1)} 秒`); };
  $('#rng-rv-seconds').onchange = (e) => changeFinish(() => { state.session.finish.reverb.seconds = +e.target.value; }, true);
  $('#rng-rv-amount').oninput = (e) => {
    state.session.finish.reverb.amount = +e.target.value / 100;
    setText($('#txt-rv-amount'), `${e.target.value}%`);
    engine.refreshFinish(state.session);   // 量はその場で
  };
  $('#rng-rv-amount').onchange = (e) => changeFinish(() => { state.session.finish.reverb.amount = +e.target.value / 100; });
  $('#rng-rv-pre').oninput = (e) => { setText($('#txt-rv-pre'), `${e.target.value} ms`); };
  $('#rng-rv-pre').onchange = (e) => changeFinish(() => { state.session.finish.reverb.preDelayMs = +e.target.value; }, true);
  $('#rng-send').oninput = (e) => {
    const lane = state.selectedLane; if (!lane) return;
    lane.track.processing.reverbSend = +e.target.value / 100;
    setText($('#txt-send'), `${e.target.value}%`);
    engine.refreshFinish(state.session);
  };
  $('#rng-send').onchange = () => changeFinish(() => { });
  $$('#dial .dial-step').forEach(b => { b.onclick = () => setDial(+b.dataset.level); });
  $('#btn-finish-detail').onclick = () => {
    const p = $('#pnl-finish-detail');
    show(p, p.hidden);
    setText($('#btn-finish-detail'), p.hidden ? '細かく決める ▸' : '細かく決める ▾');
  };
  $('#btn-measure-finish').onclick = measureFinishNow;
  const hold = $('#btn-hold-pure');
  hold.onpointerdown = (e) => { e.preventDefault(); setHoldPure(true); };
  hold.onpointerup = hold.onpointerleave = hold.onpointercancel = () => setHoldPure(false);
  $('#lst-pure').onclick = () => setListen('pure');
  $('#lst-finished').onclick = () => setListen('finished');
  $('#tgl-hum').onclick = async () => { setSwitch($('#tgl-hum'), !switchOn($('#tgl-hum'))); await onProcessing(); };
  $('#tgl-gate').onclick = async () => { setSwitch($('#tgl-gate'), !switchOn($('#tgl-gate'))); await onProcessing(); };

  // 詳しい設定
  $('#btn-rescan').onclick = async () => { await reopenInput(); await refreshDeviceList(); updateSettingsDialog(); };
  $('#btn-measure').onclick = measureLatency;
  $('#btn-open-input').onclick = async () => { await reopenInput(); await refreshDeviceList(); updateSettingsDialog(); };
  $('#cmb-output').onchange = async (e) => {
    state.settings.outputDeviceId = e.target.value;
    await store.setSettings(state.settings);
    await engine.setOutputDevice(e.target.value);
  };
  $('#tgl-raw').onclick = async () => {
    state.settings.rawCapture = !switchOn($('#tgl-raw'));
    setSwitch($('#tgl-raw'), state.settings.rawCapture);
    await store.setSettings(state.settings);
    await reopenInput();
    updateSettingsDialog();
  };
  $('#btn-mirror-choose').onclick = chooseMirrorFolder;
  $('#btn-mirror-clear').onclick = clearMirrorFolder;
  $('#tgl-auto-latency').onclick = async () => {
    state.settings.autoLatency = !switchOn($('#tgl-auto-latency'));
    setSwitch($('#tgl-auto-latency'), state.settings.autoLatency);
    await store.setSettings(state.settings);
  };
  $('#tgl-startup').onclick = async () => {
    state.settings.openInputOnStartup = !switchOn($('#tgl-startup'));
    setSwitch($('#tgl-startup'), state.settings.openInputOnStartup);
    await store.setSettings(state.settings);
  };

  // 音のチェック
  $('#btn-silence').onclick = () => measureSilence(false);
  $('#btn-playing').onclick = () => measureSilence(true);
  $('#btn-processing').onclick = checkProcessing;
  $('#btn-verify-path').onclick = verifyPath;
  $('#btn-open-measure').onclick = () => { $('#dlg-diag').close(); openMeasure(); };
  $('#btn-open-compare').onclick = () => { $('#dlg-diag').close(); openCompare(); };
  $$('#measure-mode-chips .chip').forEach(c => { c.onclick = () => { state.measureMode = c.dataset.mode; updateMeasureUi(); }; });
  $('#btn-measure-sweep').onclick = measureSweep;
  $('#btn-measure-tone').onclick = measureTone;
  $$('.cmp-rec').forEach(b => { b.onclick = () => compareRecord(+b.dataset.slot); });
  $('#btn-cmp-clear').onclick = () => { state.compare = [null, null, null]; renderCompare(); };
  $('#file-miccal').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const points = MicCal.parseCalibration(await f.text());
      state.settings.micCal = { name: f.name, points };
      await store.setSettings(state.settings);
      showNotice(`較正ファイル「${f.name}」を読みました（${points.length} 点、${points[0].hz.toFixed(0)}〜${points[points.length - 1].hz.toFixed(0)} Hz）。`, false);
      updateSettingsDialog(); updateFinishUi();
    } catch (err) { showError(err.message); }
    e.target.value = '';
  };
  $('#btn-miccal-clear').onclick = async () => {
    state.settings.micCal = null;
    await store.setSettings(state.settings);
    updateSettingsDialog(); updateFinishUi();
  };
  $('#tgl-miccal').onclick = () => changeFinish(() => {
    const f = state.session.finish;
    f.micCorrection = !f.micCorrection;
    f.micCal = f.micCorrection && state.settings.micCal ? JSON.parse(JSON.stringify(state.settings.micCal)) : null;
  }, true);
  $('#btn-trial').onclick = trialGain;
  $('#btn-grade-again').onclick = assessNow;
  $('#btn-grade-detail').onclick = () => { const p = $('#pnl-grade-detail'); show(p, p.hidden); setText($('#btn-grade-detail'), p.hidden ? '詳しく' : '閉じる'); };
  $('#tgl-drift').onclick = async () => {
    state.settings.driftCompensate = !switchOn($('#tgl-drift'));
    setSwitch($('#tgl-drift'), state.settings.driftCompensate);
    await store.setSettings(state.settings);
  };
  $('#btn-diag-track').onclick = analyzeTrack;

  // 書き出す
  $('#card-wav').onclick = () => { state.exportFormat = SaveFormat.Float32; updateExportCards(); };
  $('#card-24').onclick = () => { state.exportFormat = SaveFormat.Pcm24; updateExportCards(); };
  $('#card-flac').onclick = () => { state.exportFormat = 'flac24'; updateExportCards(); };
  $('#btn-do-export').onclick = doExport;
  $('#chk-exp-finished').onchange = updateExportPeak;

  wireEditor();

  for (const btn of $$('[data-close]')) btn.onclick = (e) => e.target.closest('dialog').close();
  $('#dlg-editor').addEventListener('close', () => { stopEditorPlayback(); state.editor = null; });
  $('#dlg-settings').addEventListener('close', () => updateInputStatus());

  document.addEventListener('pointerdown', () => { if (engine.ctx && engine.ctx.state === 'suspended') engine.ctx.resume().catch(() => { }); }, { passive: true });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', (e) => { if ((e.key === 'b' || e.key === 'B') && engine.isHoldingPure) setHoldPure(false); });
  window.addEventListener('blur', () => { if (engine.isHoldingPure) setHoldPure(false); });
}

/* ---- キーボード操作 ---- */

export function onKeyDown(e) {
  // 文字入力中はショートカットを効かせない（名前にスペースが打てなくなるため）
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const openDialog = $$('dialog[open]').length > 0;

  // B を押している間だけ素で聞く（盛ってごまかしていないかをその場で確かめる）
  if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !openDialog) {
    e.preventDefault();
    if (!e.repeat && !engine.isHoldingPure) setHoldPure(true);
    return;
  }

  if (e.key === ' ') {
    if (openDialog) return;
    e.preventDefault();
    if (engine.isRecording || engine.isPlaying) stopAll();
    else if (state.mode === 'record') startRecording();
    else if (!$('#btn-play').disabled) startPlayback();
  } else if (e.key === 'r' || e.key === 'R') {
    if (openDialog || e.ctrlKey) return;
    e.preventDefault();
    if (!engine.isRecording && !engine.isPlaying) startRecording();
  } else if (e.key === 'Escape') {
    if (openDialog) return;
    if (engine.isRecording || engine.isPlaying) { e.preventDefault(); stopAll(); }
  } else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault(); redo();
  } else if (!e.ctrlKey && !openDialog && e.key >= '1' && e.key <= '9') {
    // 選んでいるトラックの録りを 1〜9 で選び直す
    const lane = state.selectedLane;
    if (!lane || engine.isRecording) return;
    const i = +e.key - 1;
    if (i < lane.track.takes.length && lane.track.activeTakeIndex !== i) {
      e.preventDefault();
      const pill = $$('.take-pill', lane.el)[i];
      if (pill) pill.click();
    }
  } else if (!e.ctrlKey && !openDialog && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    addMarker();
  } else if (!e.ctrlKey && !openDialog && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && engine.isPlaying) {
    e.preventDefault();
    seekBy(e.key === 'ArrowLeft' ? -5 : 5);
  } else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveSession(state.session);
    state.dirty = false;
    showNotice(T('保存しました。'), false);
  } else if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    if (!$('#btn-export').disabled) openExport();
  } else if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    if (!engine.isRecording && !engine.isPlaying) newSession();
  }
}


/* ================= 出発 ================= */

// 開発時の覗き穴（コンソールから状態を見るため。画面には出ない）
window.__tonmeister = { engine, state };


init().catch(err => {
  console.error(err);
  showError('開けませんでした: ' + err.message);
});

