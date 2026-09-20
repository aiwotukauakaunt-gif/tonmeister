/*
  Tonmeister — 「重ねる」：レーン・インスペクタ・素／仕上げ・切り出しと録り直し・波形を見て直す。
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
import { $, $$, PREROLL_SECONDS, ask, audioCache, busy, engine, hideNotice, loadTake, saveSession, saveTakeAudio, setText, show, showError, showNotice, state, touch, unbusy } from './context.js';
import { driftForOverdub, ensureOpen, refreshRecordTargets, setMode, startPlayback, startRecording, updatePanes, updateSteps, updateTabs, updateTransport } from './record.js';
import { snapshot } from './sessions.js';

/* ================= セッションの見出し ================= */

export function updateSessionUi() {
  const s = state.session;
  const len = M.sessionLength(s);
  const el = $('#txt-session');
  setText(el, s.tracks.length === 0
    ? s.name
    : `${s.name}　${String(Math.floor(len / 60)).padStart(2, '0')}:${String(Math.floor(len % 60)).padStart(2, '0')}`);
  el.title = s.tracks.length === 0
    ? `${s.name}（まだ何も録っていません）`
    : `${s.name}　${s.tracks.length} トラック / ${(s.sampleRate / 1000).toFixed(1)} kHz`;

  updateTabs();
  refreshRecordTargets();
  updateSteps();
  updateTransport();
  updateFinishUi();
  for (const lane of state.lanes) lane.setTotalSeconds(len);
  drawRuler();
}


/* ================= 素／仕上げ ================= */

/**
 * 「盛り」の札、段階ダイヤル、細かい設定、盛り度。
 * 仕上げが1つでも入っていれば札が出る。素の WAV はどの操作でも変わらない。
 */
export function updateFinishUi() {
  const s = state.session;
  const f = s.finish;
  const has = M.hasFinishing(s);
  show($('#badge-finish'), has);

  // 聞く側
  const pure = (s.listen || 'pure') === 'pure';
  $('#lst-pure').classList.toggle('on', pure);
  $('#lst-finished').classList.toggle('on', !pure);
  $('#lst-finished').classList.toggle('finished', !pure);
  $('#lst-finished').disabled = !has;
  $('#lst-finished').title = has ? '仕上げを通した音を聞きます' : 'まだ何も盛っていないので、素と同じ音です';
  show($('.tp-listen'), has);

  // 段階ダイヤル
  const custom = f.mode === 'custom' && has;
  $('#dial').classList.toggle('custom', custom);
  const level = custom ? -1 : (has ? f.level : 0);
  $$('#dial .dial-step').forEach(b => b.classList.toggle('on', +b.dataset.level === (custom ? f.level : level)));
  setText($('#txt-dial-desc'), custom
    ? (currentLang() === 'en' ? 'Custom: ' : '自分で決める：') + Finish.summarize(s).join('／')
    : T((Finish.DIAL[Math.max(0, level)] || Finish.DIAL[0]).desc));

  // 細かい設定
  setSwitch($('#tgl-rumble'), !!f.rumbleCut);
  setSwitch($('#tgl-normalize'), !!f.normalizeEnabled);
  setSwitch($('#tgl-reverb'), !!f.reverb.enabled);
  show($('#pnl-reverb'), !!f.reverb.enabled);
  show($('#row-miccal'), !!state.settings.micCal || !!f.micCorrection);
  setSwitch($('#tgl-miccal'), !!f.micCorrection);
  const hallHost = $('#hall-chips');
  hallHost.innerHTML = '';
  for (const [key, h] of Object.entries(HALLS)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (f.reverb.hall === key ? ' on' : '');
    chip.innerHTML = `<b>${h.name}</b><small>${h.width}×${h.depth}×${h.height}m</small>`;
    chip.onclick = () => changeFinish(() => { f.reverb.hall = key; f.reverb.seconds = h.seconds; }, true);
    hallHost.appendChild(chip);
  }
  $('#rng-rv-seconds').value = f.reverb.seconds;
  setText($('#txt-rv-seconds'), `${(+f.reverb.seconds).toFixed(1)} 秒`);
  $('#rng-rv-amount').value = Math.round(f.reverb.amount * 100);
  setText($('#txt-rv-amount'), `${Math.round(f.reverb.amount * 100)}%`);
  $('#rng-rv-pre').value = f.reverb.preDelayMs;
  setText($('#txt-rv-pre'), `${Math.round(f.reverb.preDelayMs)} ms`);

  // 盛り度
  const m = f.measured;
  const gradeEl = $('#txt-grade');
  if (!has) { setText(gradeEl, T('無')); gradeEl.className = 'grade none ml8'; $('#grade-fill').style.width = '0%'; setText($('#txt-finish-measure'), ''); }
  else if (!m) { setText(gradeEl, T('未測定')); gradeEl.className = 'grade ml8'; $('#grade-fill').style.width = '0%'; setText($('#txt-finish-measure'), T('「測る」を押すと、素とどれだけ違うかを実際に計算します。')); }
  else {
    setText(gradeEl, T(m.grade)); gradeEl.className = 'grade ml8';
    $('#grade-fill').style.width = ({ '無': 0, '小': 25, '中': 60, '大': 100 })[m.grade] + '%';
    setText($('#txt-finish-measure'), Finish.describeMeasure(m) + (m.stale ? '　（設定を変えたので測り直してください）' : ''));
  }
  $('#btn-measure-finish').disabled = !has || s.tracks.length === 0;
  $('#btn-hold-pure').disabled = !has;
  show($('#pnl-grade'), has);
  show($('#txt-finish-state'), has);

  setText($('#txt-finish-state'), has
    ? (currentLang() === 'en'
      ? `Finishing: ${Finish.summarize(s).join(' / ')}. The raw WAV is untouched. Export gives both raw and finished.`
      : `盛っているもの：${Finish.summarize(s).join('／')}。素の WAV には触っていません。書き出すと「素」と「仕上げ」の2つが出ます。`)
    : T('いまは何も盛っていません。聞こえるのも書き出すのも「素」そのものです。'));

  // トラックごとの響きの量
  const lane = state.selectedLane;
  show($('#row-send'), !!(lane && f.reverb.enabled));
  if (lane) {
    const send = lane.track.processing.reverbSend == null ? 1 : lane.track.processing.reverbSend;
    $('#rng-send').value = Math.round(send * 100);
    setText($('#txt-send'), `${Math.round(send * 100)}%`);
  }

  for (const lane of state.lanes) lane.refreshFinish && lane.refreshFinish();
}

/**
 * 仕上げの設定を変える。細かく触ったら「自分で決める」になり、測った盛り度は古くなる。
 * 響きの構造（ホール・長さ・間）が変わったら再生を組み直す。量だけならその場で反映。
 */
export async function changeFinish(mutate, rebuild = false) {
  const s = state.session;
  const wasPlaying = engine.isPlaying;
  snapshot('仕上げの変更');
  mutate();
  Finish.markCustom(s);
  if (s.finish.measured) s.finish.measured.stale = true;
  await store.saveSession(s);
  updateFinishUi();
  if (wasPlaying) {
    if (rebuild) await restartPlaybackInPlace();
    else engine.refreshFinish(s);
  }
}

export async function setDial(level) {
  const s = state.session;
  snapshot(`盛りの段階 → ${Finish.DIAL[level] ? Finish.DIAL[level].name : level}`);
  Finish.applyDial(s, level);
  if (s.finish.measured) s.finish.measured.stale = true;
  // 段階を選んだら、聞く側もそれに合わせる（0 なら素、それ以外は仕上げ）
  s.listen = level === 0 ? 'pure' : 'finished';
  await store.saveSession(s);
  updateFinishUi();
  updateInspector();
  if (engine.isPlaying) await restartPlaybackInPlace();
  else engine.setListen(s);
}

export async function restartPlaybackInPlace() {
  const at = engine.playbackSeconds;
  engine.stopPlayback();
  try { await engine.startPlayback(state.session, { startSeconds: at, loadTake }); }
  catch (e) { showError(e.message); }
  updateTransport();
}

export async function setListen(mode) {
  if (state.session.listen === mode) return;
  state.session.listen = mode;
  await saveSession(state.session);
  updateFinishUi();
  engine.setListen(state.session);   // 再生中でも瞬時に切り替わる（組み直さない）
}

/** 素と仕上げを実際に作って比べる。長いセッションでは少し待つ。 */
export async function measureFinishNow() {
  const s = state.session;
  if (!s.tracks.length) return;
  busy('素と仕上げを作って比べています…');
  try {
    const pure = await Edit.mixdown(s, loadTake, { pure: true });
    const fin = await Edit.mixdown(s, loadTake, { pure: false });
    const m = Finish.measureFinish(pure, fin);
    m.normalizeGainDb = fin.normalizeGainDb == null ? 0 : fin.normalizeGainDb;
    m.at = Date.now();
    s.finish.measured = m;
    await store.saveSession(s);
    updateFinishUi();
    if (engine.isPlaying) engine.refreshFinish(s);
    return { pure, fin, m };
  } catch (e) { showError('測れませんでした: ' + e.message); return null; }
  finally { unbusy(); }
}

export function setHoldPure(on) {
  engine.holdPure(on);
  $('#btn-hold-pure').classList.toggle('holding', on);
}


/* ================= レーン（重ねるモード） ================= */

export function rebuildLanes() {
  const host = $('#lane-host');
  host.innerHTML = '';
  state.lanes = [];
  state.selectedLane = null;

  state.session.tracks.forEach((track, i) => {
    const lane = createLane(track, i);
    host.appendChild(lane.el);
    state.lanes.push(lane);
    lane.setTotalSeconds(M.sessionLength(state.session));
    lane.reloadWaveform();
  });

  updateInspector();
  updateTransport();
  drawRuler();
}

export function redrawLanes() { for (const lane of state.lanes) lane.redraw(); }

export const WAVE_COLORS = ['#C9A227', '#4E7CB5', '#B3A98F', '#B06A2C']; // 金／ベルリン藍／象牙／赤銅

/**
 * 「重ねる」モードの1トラック分のレーン。
 * 波形・テイクの選び直し・部分録り直し・切り出しを、その行の中だけで完結させる。
 */
export function createLane(track, colorIndex) {
  const el = $('#tpl-lane').content.firstElementChild.cloneNode(true);
  const canvas = $('.lane-wave', el);
  const color = WAVE_COLORS[colorIndex % WAVE_COLORS.length];

  const lane = {
    el, track, canvas, color,
    wave: null, waveTakeId: null,
    total: 1, playhead: null, playheadOn: false,
    selStart: null, selEnd: null,
    dragging: false, dragOrigin: 0,
  };

  const nameEl = $('.lane-name', el);
  const nameEdit = $('.lane-name-edit', el);
  const volBtn = $('.mini.vol', el);
  const volPopup = $('.vol-popup', el);
  const volRange = $('.vol-range', el);

  lane.refreshFinish = () => show($('.lane-finish', el), M.trackHasFinishing(track));

  lane.refreshFromTrack = () => {
    setText(nameEl, track.name);
    lane.refreshFinish();
    $('.mini.mute', el).classList.toggle('on', track.muted);
    $('.mini.solo', el).classList.toggle('on', track.soloed);
    setText(volBtn, M.volumeLabel(track.volume).replace(' dB', 'dB'));
    volRange.value = track.volume;
  };

  lane.refreshTakes = () => {
    const host = $('.take-pills', el);
    host.innerHTML = '';
    track.takes.forEach((take, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'take-pill' + (i === track.activeTakeIndex ? ' on' : '');
      b.textContent = `${i + 1}回目`;
      b.title = `${take.name}  ${Meter.mmss(take.seconds)}`;
      b.onclick = async () => {
        if (track.activeTakeIndex === i) return;
        snapshot(`「${track.name}」の録りを ${i + 1}回目 に`);
        track.activeTakeIndex = i;
        lane.refreshTakes();
        await lane.reloadWaveform();
        await saveSession(state.session);
        updateSessionUi();
        if (engine.isPlaying) await restartPlaybackInPlace();
      };
      host.appendChild(b);
    });
    // 1本しか無いなら選びようがないので、行ごと畳む
    show($('.takes', el), track.takes.length > 1 && !lane.hasSelection());
  };

  lane.hasSelection = () => lane.selStart != null && lane.selEnd != null &&
    Math.abs(lane.selEnd - lane.selStart) > 0.02;
  lane.selection = () => lane.hasSelection()
    ? [Math.min(lane.selStart, lane.selEnd), Math.max(lane.selStart, lane.selEnd)] : null;

  lane.clearSelection = () => { lane.selStart = lane.selEnd = null; lane.updateBottomRow(); lane.redraw(); };

  lane.updateBottomRow = () => {
    const has = lane.hasSelection();
    show($('.sel-actions', el), has);
    show($('.takes', el), !has && track.takes.length > 1);
  };

  lane.setTotalSeconds = (s) => { lane.total = Math.max(0.01, s); lane.redraw(); };

  lane.setPlayhead = (seconds, visible) => {
    lane.playhead = seconds; lane.playheadOn = visible; lane.redraw();
  };

  lane.reloadWaveform = async () => {
    const take = M.activeTake(track);
    if (!take) { lane.wave = null; lane.redraw(); return; }
    if (lane.waveTakeId === take.id && lane.wave) return;
    lane.waveTakeId = take.id;
    const wave = await Wave.getCached(take, loadTake);
    if (lane.waveTakeId !== take.id) return;   // 読んでいる間に切り替わっていたら捨てる
    lane.wave = wave;
    lane.redraw();
  };

  // レーンの横軸はセッションの時間。トラックが途中から始まるなら、波形はそのぶん右へずれる
  lane.offset = () => track.startSeconds || 0;
  lane.redraw = () => {
    if (!canvas.clientWidth) return;
    const off = lane.offset();
    const sel = lane.selection();
    const take = M.activeTake(track);
    Wave.draw(canvas, lane.wave, {
      fromSeconds: -off, toSeconds: lane.total - off, color,
      selection: sel ? [sel[0] - off, sel[1] - off] : null,
      playhead: lane.playheadOn ? lane.playhead - off : null,
      marks: take ? [...(take.gaps || []).map(g => g.at), ...(take.clicks || []).map(c => c.at)] : null,
      goldMarks: take && take.markers ? take.markers.map(m => m.at) : null,
    });
  };

  lane.setBusy = (busyNow) => {
    $('.punch', el).disabled = busyNow;
    $('.crop', el).disabled = busyNow;
  };

  /* ---- 名前 ---- */
  nameEl.onclick = () => {
    nameEdit.value = track.name;
    show(nameEdit, true); show(nameEl, false);
    nameEdit.focus(); nameEdit.select();
  };
  const commitName = async () => {
    if (nameEdit.hidden) return;
    const name = nameEdit.value.trim();
    show(nameEdit, false); show(nameEl, true);
    if (name && name !== track.name) {
      snapshot(`トラック名「${track.name}」→「${name}」`);
      track.name = name;
      lane.refreshFromTrack();
      await saveSession(state.session);
      updateSessionUi();
      updateInspector();
    }
  };
  nameEdit.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') { show(nameEdit, false); show(nameEl, true); }
  };
  nameEdit.onblur = commitName;

  /* ---- 消音・単独・音量 ---- */
  $('.mini.mute', el).onclick = async () => {
    snapshot(`「${track.name}」の消音`); track.muted = !track.muted; lane.refreshFromTrack(); await saveSession(state.session);
  };
  $('.mini.solo', el).onclick = async () => {
    snapshot(`「${track.name}」の単独`); track.soloed = !track.soloed; lane.refreshFromTrack(); await saveSession(state.session);
  };
  let volBefore = null;
  volBtn.onclick = () => show(volPopup, volPopup.hidden);
  volRange.oninput = () => {
    if (volBefore == null) volBefore = track.volume;
    track.volume = +volRange.value;
    setText(volBtn, M.volumeLabel(track.volume).replace(' dB', 'dB'));
    touch();
  };
  volRange.onchange = () => {
    if (volBefore != null && volBefore !== track.volume) {
      const after = track.volume; track.volume = volBefore; snapshot(`「${track.name}」の音量`); track.volume = after;
    }
    volBefore = null;
    saveSession(state.session);
  };

  /* ---- 範囲選択 ---- */
  const xToSeconds = (x) => Math.min(lane.total, Math.max(0, x / Math.max(1, canvas.clientWidth) * lane.total));

  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { }
    lane.dragging = true;
    lane.dragOrigin = xToSeconds(e.offsetX);
    lane.selStart = lane.selEnd = lane.dragOrigin;
    selectLane(lane);
    lane.redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!lane.dragging) return;
    lane.selStart = lane.dragOrigin;
    lane.selEnd = xToSeconds(e.offsetX);
    lane.redraw();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!lane.dragging) return;
    lane.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { }
    // 掴んだだけ（動かしていない）なら、範囲ではなくトラックを選んだものとして扱う
    if (!lane.hasSelection()) lane.selStart = lane.selEnd = null;
    lane.updateBottomRow();
    lane.redraw();
    updateInspector();
  });

  $('.punch', el).onclick = () => requestPunch(lane);
  $('.crop', el).onclick = () => requestCrop(lane);

  lane.refreshFromTrack();
  lane.refreshTakes();
  setTimeout(() => lane.redraw(), 0);
  return lane;
}

export function selectLane(lane) {
  for (const other of state.lanes) {
    if (other !== lane) { other.selStart = other.selEnd = null; other.updateBottomRow(); other.redraw(); }
    other.el.classList.toggle('selected', other === lane);
  }
  state.selectedLane = lane;
  updateInspector();
}


/* ================= インスペクタ ================= */

export function updateInspector() {
  const lane = state.selectedLane;
  show($('#pnl-inspector'), !!lane);
  show($('#txt-no-selection'), !lane);
  if (!lane) return;

  const track = lane.track;
  const sel = lane.selection();
  if (sel) {
    setText($('#txt-sel-title'), `${track.name} の ${Meter.mmss(sel[0])}〜${Meter.mmss(sel[1])}`);
    setText($('#txt-sel-body'),
      '波形をドラッグして「使いたいところ」を選びます。元の録音は書き換えません。結果は新しい録りとして増えます。\n\n' +
      '「ここだけ録り直す」を押すと、2秒の助走のあと選んだところだけ録り直します。継ぎ目は自動でなめらかにつながり、前の音は別の録りとして残ります。' +
      '\n\n波形は、小さい音も見えるように音の大きさ（dB）の目盛りで描いています。音そのものは変わりません。');
  } else {
    setText($('#txt-sel-title'), track.name);
    setText($('#txt-sel-body'), `${M.trackInfo(track)}　録り ${track.takes.length} 本。\n\n` +
      '波形をドラッグすると、そこだけ録り直したり切り出したりできます。' +
      '\n\n波形は、小さい音も見えるように音の大きさ（dB）の目盛りで描いています。音そのものは変わりません。');
  }

  setSwitch($('#tgl-hum'), track.processing.humEnabled);
  setSwitch($('#tgl-gate'), track.processing.gateEnabled);
  updateFinishUi();
}

export function setSwitch(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); }
export const switchOn = (el) => el.getAttribute('aria-checked') === 'true';


/* ================= 切り出し・部分録り直し ================= */

export async function requestCrop(lane) {
  const sel = lane.selection();
  const take = M.activeTake(lane.track);
  if (!sel || !take) return;

  busy('切り出しています…');
  try {
    snapshot('切り出し');
    const audio = await loadTake(take);
    const off = lane.offset();
    const cropped = Edit.crop(audio, sel[0] - off, sel[1] - off);
    const audioId = await saveTakeAudio(cropped, state.settings.saveFormat);
    const newTake = M.newTake(`${lane.track.takes.length + 1}回目の録り（切り出し）`, audioId, cropped);
    audioCache.set(newTake.id, cropped);
    lane.track.takes.push(newTake);
    lane.track.activeTakeIndex = lane.track.takes.length - 1;
    await saveSession(state.session);

    lane.clearSelection();
    lane.refreshTakes();
    await lane.reloadWaveform();
    updateSessionUi();
    updateInspector();
    showNotice(`切り出しました（${Meter.mmss(sel[0])}〜${Meter.mmss(sel[1])}）。元の録りは残っています。`, false);
  } catch (e) {
    showError('切り出せませんでした: ' + e.message);
  } finally { unbusy(); }
}

export async function requestPunch(lane) {
  const sel = lane.selection();
  if (!sel || !M.activeTake(lane.track)) return;

  const error = await ensureOpen();
  if (error) { showError(error); return; }

  const latency = state.settings.latencyFrames;
  const ok = await ask('ここだけ録り直す',
    `${Meter.mmss(sel[0])} から録り直します。\n\n` +
    `・${PREROLL_SECONDS} 秒の助走のあと、録音に入ります\n` +
    '・どこまで録り直すかは、止めるまでの時間で決まります\n' +
    '・このトラックは録音中は鳴りません（前の音が二重に聴こえないため）\n' +
    '・継ぎ目は自動でなめらかにつなぎます\n\n' +
    (latency > 0 ? `ズレ合わせ: ${latency} サンプル` : '⚠ ズレ合わせを測っていません。ズレたまま繋がる可能性があります。') +
    '\n\n始めますか？', '始める');
  if (!ok) return;

  const rate = engine.recordRate;
  const at = sel[0];
  const playFrom = Math.max(0, at - PREROLL_SECONDS);

  try {
    const playing = await engine.startPlayback(state.session, {
      exclude: lane.track, startSeconds: playFrom, loadTake, driftPpm: driftForOverdub(),
    });
    // 助走ぶんとズレ合わせぶんを捨てれば、録音の先頭が録り直し開始位置になる
    const lead = playing ? Math.max(0, engine.playStartAt - engine.ctx.currentTime) : 0;
    const trim = Math.max(0, latency + Math.round((lead + (at - playFrom)) * rate));

    state.punch = { lane, at };
    state.recPeak = 0;
    state.recFlats = 0;
    hideNotice();
    engine.startRecording(trim);

    setText($('#txt-rec-target'), `「${lane.track.name}」の ${Meter.mmss(at)} から録り直しています`);
    state.live.length = 0;
    updatePanes();
  } catch (e) {
    state.punch = null;
    engine.stopPlayback();
    showError(e.message);
  } finally { updateTransport(); }
}

export async function finishPunch(punch, recorded) {
  const { lane, at } = punch;
  const take = M.activeTake(lane.track);
  if (!take || !recorded || recorded.frames === 0) return;

  busy('差し替えています…');
  try {
    snapshot('録り直しの差し替え');
    const original = await loadTake(take);
    const punched = Edit.punchIn(original, recorded, at - lane.offset());
    const audioId = await saveTakeAudio(punched, state.settings.saveFormat);
    const newTake = M.newTake(`${lane.track.takes.length + 1}回目の録り（録り直し）`, audioId, punched);
    audioCache.set(newTake.id, punched);
    lane.track.takes.push(newTake);
    lane.track.activeTakeIndex = lane.track.takes.length - 1;
    await saveSession(state.session);

    lane.clearSelection();
    lane.refreshTakes();
    await lane.reloadWaveform();
    updateSessionUi();
    updateInspector();
    showNotice(`${Meter.mmss(at)} からを差し替えました。前の録りは残っています。`, false);
  } catch (e) {
    showError('差し替えられませんでした: ' + e.message + '\n\n録り直した音は残っています。');
  } finally { unbusy(); }
}


/* ================= 時間ルーラー ================= */

export function drawRuler() {
  const cv = $('#ruler');
  if (!cv || cv.offsetParent === null) return;
  const { ctx, w } = Wave.fitCanvas(cv);
  const total = M.sessionLength(state.session);
  if (w < 20 || total <= 0) return;

  const left = 159, right = 9;          // レーンの波形と左端を揃える
  const usable = w - left - right;
  if (usable < 20) return;

  // 目盛りが 70px 以上あくものを選ぶ
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (s / total * usable >= 70) { step = s; break; } }

  ctx.font = '10.5px Consolas, monospace';
  ctx.fillStyle = '#9E937A';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= total; t += step) {
    const x = left + t / total * usable;
    if (x > w - 20) break;
    ctx.fillText(Meter.mmss(t), x + 2, 6);
  }
}


/* ================= 波形を見て直す ================= */

export async function openEditor() {
  const lane = state.selectedLane;
  if (!lane) return;
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }

  const take = M.activeTake(lane.track);
  if (!take) return;
  const audio = await loadTake(take);
  const wave = await Wave.getCached(take, loadTake);

  const off = lane.offset();
  const lsel = lane.selection();
  state.editor = {
    lane, audio, wave,
    zoomX: 1, zoomY: 1, autoY: true, scroll: 0,
    sel: lsel ? [lsel[0] - off, lsel[1] - off] : null, dragging: false, dragOrigin: 0,   // 窓の中はテイクの時間
    source: null,
  };
  setText($('#txt-editor-target'), `${lane.track.name}　${M.trackInfo(lane.track)}`);
  $('#zoom-x').value = 1;
  $('#zoom-y').value = 1;
  $('#chk-auto-y').checked = true;
  $('#ed-scroll').value = 0;
  $('#dlg-editor').showModal();
  // 窓が開いた直後は canvas の幅がまだ決まっていない。
  // 描画のきっかけを requestAnimationFrame だけに任せると、
  // タブが裏に回っているときに一度も描かれないので、時間でも一度呼ぶ。
  drawEditor();
  setTimeout(drawEditor, 0);
  setTimeout(drawEditor, 120);
}

export function editorRange() {
  const e = state.editor;
  const total = e.audio.seconds;
  const span = total / e.zoomX;
  const from = Math.max(0, Math.min(total - span, e.scroll * (total - span)));
  return [from, from + span, total];
}

/** 縦倍率「自動」。暗騒音しかない録音でも波形が見えるようにする。 */
export function autoGainY() {
  const e = state.editor;
  if (!e.wave || !e.wave.bucketCount) return 1;
  let peak = 0;
  for (let i = 0; i < e.wave.bucketCount; i++) {
    peak = Math.max(peak, Math.abs(e.wave.min[i]), Math.abs(e.wave.max[i]));
  }
  const scaled = Wave.toScale(peak);
  return scaled > 0.001 ? Math.min(8, 0.92 / scaled) : 1;
}

export function drawEditor() {
  const e = state.editor;
  if (!e) return;
  const [from, to] = editorRange();
  const gainY = e.autoY ? autoGainY() : e.zoomY;
  Wave.draw($('#editor-wave'), e.wave, {
    fromSeconds: from, toSeconds: to, color: e.lane.color,
    selection: e.sel, gainY,
  });
  setText($('#txt-editor-sel'), e.sel
    ? `選んでいる範囲 ${Meter.mmss(e.sel[0])}〜${Meter.mmss(e.sel[1])}（${(e.sel[1] - e.sel[0]).toFixed(2)} 秒）／縦 ×${gainY.toFixed(1)}`
    : `全体 ${Meter.mmss(e.audio.seconds)}／ドラッグで範囲を選びます／縦 ×${gainY.toFixed(1)}`);
  $('#btn-ed-crop').disabled = !e.sel;
  $('#btn-ed-punch').disabled = !e.sel;
}

export function wireEditor() {
  const cv = $('#editor-wave');
  const xToSeconds = (x) => {
    const [from, to] = editorRange();
    return from + x / Math.max(1, cv.clientWidth) * (to - from);
  };
  cv.addEventListener('pointerdown', (ev) => {
    const e = state.editor; if (!e) return;
    try { cv.setPointerCapture(ev.pointerId); } catch { }
    e.dragging = true;
    e.dragOrigin = xToSeconds(ev.offsetX);
    e.sel = null;
    drawEditor();
  });
  cv.addEventListener('pointermove', (ev) => {
    const e = state.editor; if (!e || !e.dragging) return;
    const t = xToSeconds(ev.offsetX);
    e.sel = [Math.min(e.dragOrigin, t), Math.max(e.dragOrigin, t)];
    drawEditor();
  });
  cv.addEventListener('pointerup', (ev) => {
    const e = state.editor; if (!e || !e.dragging) return;
    e.dragging = false;
    try { cv.releasePointerCapture(ev.pointerId); } catch { }
    if (e.sel && e.sel[1] - e.sel[0] < 0.02) e.sel = null;
    drawEditor();
  });

  $('#zoom-x').oninput = (ev) => { state.editor.zoomX = +ev.target.value; drawEditor(); };
  $('#zoom-y').oninput = (ev) => {
    state.editor.zoomY = +ev.target.value;
    state.editor.autoY = false;
    $('#chk-auto-y').checked = false;
    drawEditor();
  };
  $('#chk-auto-y').onchange = (ev) => { state.editor.autoY = ev.target.checked; drawEditor(); };
  $('#ed-scroll').oninput = (ev) => { state.editor.scroll = +ev.target.value; drawEditor(); };

  $('#btn-ed-play').onclick = async () => {
    const e = state.editor;
    if (!e) return;
    stopEditorPlayback();
    const ctx = engine.ctx;
    if (!ctx) { showError('先に音の入り口を開いてください。'); return; }
    const [s0, s1] = e.sel || [0, e.audio.seconds];
    const buffer = ctx.createBuffer(e.audio.channels, e.audio.frames, e.audio.sampleRate);
    for (let c = 0; c < e.audio.channels; c++) {
      const dst = buffer.getChannelData(c);
      for (let i = 0; i < e.audio.frames; i++) dst[i] = e.audio.samples[i * e.audio.channels + c];
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(engine.masterGain);
    src.start(0, s0, Math.max(0.05, s1 - s0));
    e.source = src;
  };
  $('#btn-ed-stop').onclick = stopEditorPlayback;

  $('#btn-ed-crop').onclick = async () => {
    const e = state.editor;
    e.lane.selStart = e.sel[0] + e.lane.offset(); e.lane.selEnd = e.sel[1] + e.lane.offset();
    stopEditorPlayback();
    $('#dlg-editor').close();
    await requestCrop(e.lane);
    state.editor = null;
  };
  $('#btn-ed-punch').onclick = async () => {
    const e = state.editor;
    e.lane.selStart = e.sel[0] + e.lane.offset(); e.lane.selEnd = e.sel[1] + e.lane.offset();
    e.lane.updateBottomRow();
    stopEditorPlayback();
    $('#dlg-editor').close();
    await requestPunch(e.lane);
    state.editor = null;
  };
}

export function stopEditorPlayback() {
  const e = state.editor;
  if (e && e.source) { try { e.source.stop(); } catch { } try { e.source.disconnect(); } catch { } e.source = null; }
}


/* ================= トラックを外す ================= */

export async function removeTrack() {
  const lane = state.selectedLane;
  if (!lane) return;
  const track = lane.track;

  const ok = await ask('トラックを外す',
    `「${track.name}」をこの録音から外します（録り ${track.takes.length} 本）。\n音そのものは残るので、すぐ元に戻せます。`, '外す');
  if (!ok) return;

  snapshot(`「${track.name}」を外す`);
  const index = state.session.tracks.indexOf(track);
  const rate = state.session.sampleRate;
  state.session.tracks.splice(index, 1);
  if (state.session.tracks.length === 0) state.session.sampleRate = 0;
  await saveSession(state.session);
  updateSessionUi();
  rebuildLanes();
  if (state.session.tracks.length === 0) setMode('record');

  state.removed = { track, index };
  showNotice(`「${track.name}」を外しました。音は残っています。`, false, '元に戻す', () => undoRemove(rate));
}

export async function undoRemove(sampleRate) {
  if (!state.removed) return;
  const { track, index } = state.removed;
  state.removed = null;
  state.session.tracks.splice(Math.max(0, Math.min(index, state.session.tracks.length)), 0, track);
  if (state.session.sampleRate <= 0) state.session.sampleRate = sampleRate;
  await saveSession(state.session);
  updateSessionUi();
  rebuildLanes();
  setMode('overdub');
  showNotice(`「${track.name}」を戻しました。`, false);
}

