/*
  Tonmeister — 「録る」：入力の開閉・メーター・録音の開始と停止・録音の証明・経路の格・試し弾き。
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
import { $, $$, LIVE_CAPACITY, ask, audioCache, busy, engine, hideNotice, loadTake, saveSession, saveTakeAudio, setText, show, showError, showNotice, state, unbusy } from './context.js';
import { openDiagnostics } from './diagnostics.js';
import { drawRuler, finishPunch, rebuildLanes, redrawLanes, updateSessionUi } from './overdub.js';
import { openSessions, snapshot } from './sessions.js';
import { updateSettingsDialog } from './settings.js';

/* ================= 入力（音の入り口） ================= */

export async function openInput() {
  const s = state.settings;
  engine.prerollSeconds = s.prerollSeconds || 0;
  engine.setRecordChannels(s.recordChannels);
  const status = await engine.open({
    deviceId: s.deviceId,
    sampleRate: state.session.sampleRate || s.sampleRate,
    channelCount: s.channelCount || undefined,
    processing: s.processing,
    raw: s.rawCapture !== false,
    fake: state.fake,
  });
  if (s.outputDeviceId) await engine.setOutputDevice(s.outputDeviceId);
  s.deviceId = engine.deviceId || s.deviceId;
  await store.setSettings(s);
  updateInputStatus();
  return status;
}

export async function ensureOpen() {
  if (engine.isOpen) return null;
  try { await openInput(); return null; }
  catch (e) { return e.message; }
}

/** 「いま何につながっているか」を1行で。 */
export function updateInputStatus() {
  const st = engine.status();
  const dot = $('#status-dot');
  const line = $('#txt-status-line');

  if (!st) {
    dot.className = 'dot';
    setText(line, T('マイクをまだ使えていません。「詳しい設定」で選んでください。'));
    setText($('#txt-record-big'), T('マイクを選んでください。').replace(/[.。]$/, ''));
    show($('#txt-record-hint'), false);
  } else {
    const rate = st.rawPath ? st.captureRate : st.contextRate;
    const parts = [
      st.device,
      `${(rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz / ${st.channels}ch`,
      T(st.rawPath ? '生取得' : 'AudioContext 経由'),
    ];
    if (st.unknown) parts.push(T('ブラウザ加工: 不明'));
    else parts.push(T(st.clean ? 'ブラウザ加工: すべて切' : 'ブラウザ加工: 入ったまま'));
    if (st.resampled) parts.push(`⚠ 再標本化 ${(st.streamRate / 1000).toFixed(1)}k→${(st.contextRate / 1000).toFixed(1)}k`);

    dot.className = 'dot ' + (st.clean && !st.resampled ? 'gold' : st.unknown ? '' : 'warn');
    setText(line, parts.join('　'));
    setText($('#txt-record-big'), T('録音する'));
    show($('#txt-record-hint'), true);
  }

  updateAlignPill();
  updateMonitorInfo();
  updateTransport();
}


/* ================= モード ================= */

export function setMode(mode) {
  state.mode = mode;
  updateTabs();
  updatePanes();
  if (mode === 'overdub') { drawRuler(); redrawLanes(); }
}

export function updateTabs() {
  const rec = state.mode === 'record';
  $('#tab-record').classList.toggle('is-active', rec);
  $('#tab-overdub').classList.toggle('is-active', !rec);

  const n = state.session.tracks.length;
  const badge = $('#tab-badge');
  setText(badge, n === 0 ? T('まだ0本') : T('{n}本', { n }));
  badge.classList.toggle('has', n > 0);

  show($('#btn-export'), !rec);
}

export function updatePanes() {
  const recording = engine.isRecording;
  show($('#tabbar'), !recording);
  show($('#recbar'), recording);
  show($('#pane-recording'), recording);
  show($('#pane-record'), !recording && state.mode === 'record');
  show($('#pane-overdub'), !recording && state.mode === 'overdub');
  if (!recording && state.mode === 'record') { drawScale(); drawRing(0); }
}


/* ================= 画面更新（33ms ごと） ================= */

export function uiTick() {
  updateMeters();

  if (engine.isRecording) {
    setTime(engine.recordedSeconds);
    const dropped = engine.droppedBuffers;
    const el = $('#txt-rec-save');
    const lost = engine.gapCount;
    setText(el, `${engine.storageKind === 'opfs' ? '0.5 秒ごとにファイルへ追記中' : '約2秒ごとに自動保存中'}` +
      (engine.mirror ? '・フォルダにも書き込み中' : '') + `・落ちた音 ${lost} 回・保存失敗 ${dropped}`);
    el.classList.toggle('warn', dropped > 0 || lost > 0);
  } else if (engine.isPlaying) {
    const t = engine.playbackSeconds;
    setTime(t);
    for (const lane of state.lanes) lane.setPlayhead(t, true);
    engine.refreshGains(state.session, M.effectiveGain);
    refreshMiniVerdict();

    if (t > M.sessionLength(state.session) + 0.3) {
      engine.stopPlayback();
      for (const lane of state.lanes) lane.setPlayhead(0, false);
      refreshMiniVerdict();
      updateTransport();
    }
  }
}

export function setTime(seconds) {
  const text = Meter.hmsT(seconds);
  setText($('#txt-time'), text);
  setText($('#txt-big-time'), text);
}

export function updateMeters() {
  updateOutputMeter();

  if (!engine.isOpen) {
    setLevel(0);
    setVerdict('unknown');
    return;
  }

  // 目盛りはサンプルの間も含めた True Peak で動かす。サンプル値だけ見ると「割れていない」と嘘をつく。
  const peaks = engine.readPeaks();
  const truePeaks = engine.readTruePeaks();
  let peak = 0;
  for (let c = 0; c < peaks.length; c++) peak = Math.max(peak, peaks[c], truePeaks[c] || 0);

  const now = performance.now();
  if (peak >= state.hold || now - state.holdAt > 1500) { state.hold = peak; state.holdAt = now; }
  if (engine.isRecording && peak > state.recPeak) state.recPeak = peak;

  const db = Meter.toDb(state.hold);
  setLevel(Meter.ratio(db));
  pushLive(peak);
  gradeTick(db);
  if ((performance.now() | 0) % 20000 < 40) rememberDrift();

  // 「いま割れているか」を見たいので、読むたびに戻す。
  // 戻さないと一度でも割れた時点で判定が張り付き、つまみを下げても直らない。
  const clipped = engine.readClipCounts().some(c => c > 0);
  if (clipped) engine.resetClips();
  // 0 dBFS に届かないまま頭が平らになった波＝プリアンプや ADC の手前で歪んでいる
  const flats = engine.readFlatCounts().reduce((a, c) => a + c, 0);
  if (flats > 0) { engine.resetFlats(); if (engine.isRecording) state.recFlats += flats; }

  // ほぼ無音のときに「小さすぎます」と言うと、まだ何も鳴らしていない人を叱ることになる
  const verdict = (clipped || flats > 0 || db >= -0.3) ? 'clipping'
    : db > Meter.GoodToDb ? 'tooLoud'
    : db >= Meter.GoodFromDb ? 'good'
    : db > -55 ? 'tooQuiet'
    : 'silent';
  setVerdict(verdict);

  if (engine.isRecording) {
    const el = $('#txt-live-level');
    setText(el, ({
      good: `音量は問題ありません（ピーク ${db.toFixed(1)}）`,
      tooQuiet: `少し小さめです（ピーク ${db.toFixed(1)}）`,
      tooLoud: `やや大きめです（ピーク ${db.toFixed(1)}）`,
      clipping: flats > 0 ? '波の頭が平らです。機材側で歪んでいます。入力つまみを下げてください。' : '音が割れています。止めて音量を下げてください。',
    })[verdict] || '音がまだ入っていません');
    el.className = 'gold' + (verdict === 'clipping' ? ' bad' : (verdict === 'tooLoud' || verdict === 'tooQuiet') ? ' warn' : '');
  }
}

/**
 * 再生中は、トランスポート帯の目盛りを「入力の大きさ」から
 * 「実際に出ている音の大きさ」に切り替える。
 * これが動いていれば、聞こえない原因はアプリの外（機器の音量）だと分かる。
 */
export function updateOutputMeter() {
  if (!engine.isPlaying) { state.outHold = 0; state.silentSince = 0; state.outputPeakDb = -Infinity; return; }

  const peak = engine.readOutputPeak();
  const now = performance.now();
  if (peak >= state.outHold || now - state.outHoldAt > 1000) { state.outHold = peak; state.outHoldAt = now; }

  const db = Meter.toDb(state.outHold);
  setMiniLevel(Meter.ratio(db));

  // 出ていない状態が 1.5 秒続いたときだけ「出ていない」と言う（頭出しの無音で騒がない）
  if (db < -70) { if (!state.silentSince) state.silentSince = now; }
  else state.silentSince = 0;
  state.outputPeakDb = db;
}

export const outputLooksSilent = () => state.silentSince && performance.now() - state.silentSince > 1500;

export function setLevel(ratio) {
  const well = $('#meter-level').parentElement;
  const w = well.clientWidth;
  if (w > 1) {
    const good = $('#meter-good');
    good.style.left = (w * Meter.GoodFrom) + 'px';
    good.style.width = Math.max(1, w * (Meter.GoodTo - Meter.GoodFrom)) + 'px';
    $('#meter-level').style.width = (w * ratio) + 'px';

    // 「ちょうどよい」の文字は帯の真下に置く（真ん中に固定すると別の場所を指してしまう）
    const label = $('#txt-good-label');
    const center = w * (Meter.GoodFrom + Meter.GoodTo) / 2 - label.offsetWidth / 2;
    label.style.left = Math.max(0, center) + 'px';
  }
  if (!engine.isPlaying) setMiniLevel(ratio);
  drawRing(ratio);
}

export function setMiniLevel(ratio) {
  const well = $('#mini-level').parentElement;
  const w = well.clientWidth;
  if (w <= 1) return;
  const good = $('#mini-good');
  good.style.left = (w * Meter.GoodFrom) + 'px';
  good.style.width = Math.max(1, w * (Meter.GoodTo - Meter.GoodFrom)) + 'px';
  $('#mini-level').style.width = (w * ratio) + 'px';
}

/** 判定文は 500ms 落ち着いてから切り替える（チラつき防止）。 */
export function setVerdict(verdict, force = false) {
  if (!force) {
    if (verdict !== state.pending) { state.pending = verdict; state.pendingSince = performance.now(); return; }
    if (verdict === state.verdict) return;
    if (performance.now() - state.pendingSince < 500) return;
  }

  state.verdict = verdict;
  const el = $('#txt-verdict');
  setText(el, T(({
    good: 'いい音量です。楽器をいちばん強く鳴らしても金の帯に収まっています。',
    tooQuiet: '音が小さすぎます。機材側の入力つまみを上げてください。',
    tooLoud: '音が大きすぎて割れます。機材側の入力つまみを下げてください。',
    clipping: '音が大きすぎて割れます。機材側の入力つまみを下げてください。',
    silent: '楽器を鳴らしてみてください。いちばん強く鳴らしたときに金の帯へ入るのが目安です。',
  })[verdict] || 'マイクを選んでください。'));
  el.className = 'verdict' + (verdict === 'unknown' || verdict === 'silent' ? ' quiet' : '');

  refreshMiniVerdict();
  updateSteps();
}

export function refreshMiniVerdict() {
  const el = $('#txt-mini-verdict');
  if (engine.isPlaying) {
    if (outputLooksSilent()) { setText(el, T('音が出ていません')); el.className = 'small'; el.style.color = 'var(--warn)'; }
    else {
      setText(el, isFinite(state.outputPeakDb) ? `音は出ています（${state.outputPeakDb.toFixed(1)}）` : '再生中');
      el.className = 'gold small'; el.style.color = '';
    }
    return;
  }
  setText(el, T(({ good: 'ちょうどいい', tooQuiet: '小さすぎ', tooLoud: '大きすぎ', clipping: '割れています' })[state.verdict] || ''));
  el.className = 'small';
  el.style.color = state.verdict === 'good' ? 'var(--good)'
    : state.verdict === 'clipping' ? 'var(--rec-bright)'
    : (state.verdict === 'tooLoud' || state.verdict === 'tooQuiet') ? 'var(--warn)' : 'var(--fg-dim)';
}

/**
 * いま何をする番かを1つだけ光らせる。
 * 順に見ていけば録れる、という道筋を画面に置いておく。
 */
export function updateSteps() {
  // まだ1本も録っていない人にだけ出す。慣れた人の邪魔をしない。
  const showSteps = state.session.tracks.length === 0;
  show($('#pnl-steps'), showSteps);
  if (!showSteps) return;

  const active = !engine.isOpen ? 1 : state.verdict === 'good' ? 3 : 2;
  $$('#pnl-steps .step').forEach(el => {
    const n = +el.dataset.step;
    el.classList.toggle('active', n === active);
    el.classList.toggle('done', n < active);
  });
}


/* ================= 彫金の飾り ================= */
/*
   唐草の地紋と、足の花形。どちらも19世紀の版彫り（紙幣・銘板・時計の文字盤）で
   使われた、旋盤で引く連続曲線。図像だけで時代を出したいので紋章には頼らない。
*/

export function buildOrnaments() {
  drawGuilloche();
  drawRosette();
  drawScale();
}

export function drawGuilloche() {
  const cv = $('#guilloche');
  const ctx = cv.getContext('2d');
  const cx = 260, cy = 260;
  ctx.clearRect(0, 0, 520, 520);
  ctx.strokeStyle = '#C9A227';
  ctx.lineWidth = 0.6;

  // 半径のわずかに違う輪を重ねると、彫金の唐草のような編み目になる
  for (let ring = 0; ring < 5; ring++) {
    const baseR = 150 + ring * 22;
    const petal = 26 + ring * 3;
    const lobes = 11 + ring;
    ctx.globalAlpha = 0.085 - ring * 0.012;
    ctx.beginPath();
    for (let i = 0; i <= 720; i++) {
      const t = i * Math.PI / 360;
      const r = baseR + petal * Math.cos(lobes * t);
      const x = cx + r * Math.cos(t), y = cy + r * Math.sin(t);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawRosette() {
  const ctx = $('#rosette').getContext('2d');
  const c = 11;
  ctx.clearRect(0, 0, 22, 22);
  ctx.strokeStyle = '#C9A227';
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {          // 8枚の花弁を放射に置く
    const a = k * Math.PI / 4;
    ctx.moveTo(c, c);
    ctx.lineTo(c + 8 * Math.cos(a), c + 8 * Math.sin(a));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#C9A227';
  ctx.beginPath();
  ctx.arc(c, c, 3, 0, Math.PI * 2);
  ctx.fill();
}

export const RING_START = 135, RING_SWEEP = 270;

export function drawRing(ratio) {
  const cv = $('#ring');
  if (!cv || cv.offsetParent === null) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 290, 290);
  const cx = 145, cy = 145, r = (290 - 13) / 2;
  const arc = (fromDeg, sweepDeg, color, width) => {
    if (sweepDeg <= 0.05) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, r, fromDeg * Math.PI / 180, (fromDeg + sweepDeg) * Math.PI / 180);
    ctx.stroke();
  };
  arc(RING_START, RING_SWEEP, '#4A4130', 13);
  // 「ちょうどいい」帯は固定表示。ここに収めるのが目標だと目で分かるようにする。
  arc(RING_START + RING_SWEEP * Meter.GoodFrom, RING_SWEEP * (Meter.GoodTo - Meter.GoodFrom), 'rgba(201,162,39,.6)', 13);

  if (ratio > 0.001) {
    const grad = ctx.createLinearGradient(0, 0, 290, 0);
    grad.addColorStop(0, '#7A6119');
    grad.addColorStop(1, '#C9A227');
    arc(RING_START, RING_SWEEP * ratio, grad, 13);
  }
}

/**
 * 目盛りを彫る。
 * 「−18〜−8 に入れる」と文字で言われても、初めての人にはどこを狙うのか分からない。
 * 計器と同じように、数字の付いた刻みを目盛りの下に並べて、狙う場所を目で示す。
 */
export function drawScale() {
  const cv = $('#scale');
  if (!cv) return;
  const { ctx, w } = Wave.fitCanvas(cv);
  if (w < 20) return;
  ctx.font = '10px Consolas, monospace';
  ctx.textBaseline = 'top';

  for (const db of [-60, -40, -30, -18, -8, 0]) {
    const target = db === Meter.GoodFromDb || db === Meter.GoodToDb;
    const x = w * Meter.ratio(db);
    ctx.strokeStyle = target ? '#C9A227' : '#9E937A';
    ctx.lineWidth = target ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, target ? 7 : 4);
    ctx.stroke();

    const label = String(db);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = target ? '#C9A227' : '#9E937A';
    ctx.fillText(label, Math.min(Math.max(0, x - tw / 2), w - tw), 7);
  }
}


/* ================= 録音中の走る波形 ================= */

export function pushLive(peak) {
  if (!engine.isRecording) {
    if (state.live.length) { state.live.length = 0; drawLiveWave(); }
    return;
  }
  state.live.push(peak);
  if (state.live.length > LIVE_CAPACITY) state.live.splice(0, state.live.length - LIVE_CAPACITY);
  drawLiveWave();
}

export function drawLiveWave() {
  const cv = $('#live-wave');
  if (!cv || cv.offsetParent === null) return;
  const { ctx, w, h } = Wave.fitCanvas(cv);
  const mid = h / 2;

  ctx.strokeStyle = 'rgba(160,58,46,.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  // 直近ぶんを右詰めで描く。左へ流れていくので「録れている」が動きで分かる。
  for (let i = 0; i < state.live.length; i++) {
    const x = w - (state.live.length - i) * (w / LIVE_CAPACITY);
    if (x < 0) continue;
    let half = Math.min(1, Math.max(0, state.live[i])) * mid * 0.95;
    if (half < 0.5) half = 0.5;
    ctx.moveTo(x, mid - half);
    ctx.lineTo(x, mid + half);
  }
  ctx.stroke();

  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(w - 1, 0); ctx.lineTo(w - 1, h);
  ctx.stroke();
}


/* ================= トランスポート ================= */

export function updateTransport() {
  const busy = engine.isRecording || engine.isPlaying;
  const open = engine.isOpen;
  const has = state.session.tracks.length > 0;

  $('#btn-record-big').disabled = !open || busy;
  $('#btn-record-small').disabled = !open || busy;
  $('#btn-add-layer').disabled = !open || busy;
  $('#btn-play').disabled = busy || !has || !open;
  $('#btn-stop').disabled = !busy;
  $('#btn-export').disabled = busy || !has;
  $('#btn-export-2').disabled = busy || !has;
  $('#cmb-target').disabled = busy;
  $('#btn-align').disabled = busy;
  $('#btn-edit-track').disabled = busy;
  $('#btn-remove-track').disabled = busy;
  $('#btn-list').disabled = busy;
  $('#btn-settings').disabled = busy;
  for (const lane of state.lanes) lane.setBusy(busy);
}

export async function startRecording(forceTarget) {
  if (engine.isRecording || engine.isPlaying) return;

  const error = await ensureOpen();
  if (error) { showError(error); return; }

  if (state.session.sampleRate > 0 && state.session.sampleRate !== engine.recordRate) {
    showError(`この録音は ${(state.session.sampleRate / 1000).toFixed(1)} kHz で始まっています。\n` +
      `いまの入り口は ${(engine.recordRate / 1000).toFixed(1)} kHz です。揃えてください。`);
    return;
  }

  const target = forceTarget !== undefined ? forceTarget : selectedRecordTarget();
  const rate = engine.recordRate;

  let playing = false;
  try {
    playing = await engine.startPlayback(state.session, {
      exclude: target, startSeconds: 0, loadTake, driftPpm: driftForOverdub(),
    });
  } catch (e) { showError(e.message); return; }

  // 再生が始まる瞬間が録音の基準点。そこまでの助走と、往復の遅れぶんを頭から捨てる。
  const lead = playing ? Math.max(0, engine.playStartAt - engine.ctx.currentTime) : 0;
  const trim = playing ? state.settings.latencyFrames + Math.round(lead * rate) : 0;

  try {
    engine.startRecording(trim);
  } catch (e) {
    engine.stopPlayback();
    showError(e.message);
    return;
  }
  acquireWakeLock();

  setText($('#txt-rec-target'),
    target ? `「${target.name}」に録り足しています`
      : playing ? `新しいトラック（${state.session.tracks.length + 1}本目）に録っています`
        : '1本目を録っています');

  state.live.length = 0;
  state.recPeak = 0;
  state.recFlats = 0;
  state.pendingMarkers = [];
  hideNotice();
  showAlignToast(playing);
  updatePanes();
  updateTransport();
}

/**
 * ズレ合わせ未測定のまま重ね録りを始めたときの一度きりの注意。
 * 止めはしない（測らなくても録れることに変わりはない）。
 */
export function showAlignToast(overdub) {
  const on = overdub && !state.settings.latencyMeasured && !state.alignToastShown;
  show($('#align-toast'), on);
  if (on) state.alignToastShown = true;
}

export async function startPlayback() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  try {
    const ok = await engine.startPlayback(state.session, { loadTake, effectiveGain: M.effectiveGain });
    if (!ok) { showError('鳴らせるトラックがありません。'); return; }
  } catch (e) { showError(e.message); }
  finally { updateTransport(); }
}

export async function stopAll() {
  const wasRecording = engine.isRecording;
  const punch = state.punch;
  const target = wasRecording && !punch ? selectedRecordTarget() : null;

  const recorded = wasRecording ? await engine.stopRecording() : null;
  engine.stopPlayback();
  state.punch = null;

  for (const lane of state.lanes) lane.setPlayhead(0, false);

  releaseWakeLock();
  if (wasRecording) {
    show($('#align-toast'), false);
    updatePanes();
    if (punch) await finishPunch(punch, recorded);
    else if (recorded && recorded.frames > 0) await addRecordedTakes(recorded, target);
  }

  refreshMiniVerdict();
  updateTransport();
}

/**
 * 録れた音をテイクにする入口。
 *   ・長時間で切り替わった部分は、続きのトラック（startSeconds 付き）として並べる
 *   ・多入力の「別トラックに」は、チャンネルごとにトラックを作る
 *   ・「保険」は、本線が割れたところだけ保険で直したテイクを足す
 *   ・落ちた音の場所はテイクに残し、波形に印を打つ
 */
export async function addRecordedTakes(recorded, target) {
  snapshot('録音');
  const mode = state.settings.recordMode;
  const parts = recorded.parts && recorded.parts.length ? recorded.parts : [recorded];
  let offset = 0;
  let firstTrack = null;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    const suffix = parts.length > 1 ? `（${i + 1}/${parts.length}）` : '';
    const dest = i === 0 ? target : null;
    const startSeconds = i === 0 ? 0 : offset;
    const contName = i > 0 && firstTrack ? `${firstTrack.name}（続き ${i + 1}）` : null;
    if (mode === 'split' && a.channels > 1 && !target) {
      const monos = Edit.splitChannels(a);
      const base = contName || M.nextTrackName(state.session);
      for (let c = 0; c < monos.length; c++) {
        const tr = await addRecordedTake(monos[c], null, `${suffix}`, { startSeconds, trackName: `${base}（ch ${c + 1}）`, gaps: a.gaps, quiet: c > 0 || i > 0 });
        if (!firstTrack) firstTrack = tr;
      }
    } else if (mode === 'safety' && a.channels >= 2 && !target) {
      const tr = await addRecordedTake(a, null, `${suffix}（本線＋保険）`, { startSeconds, gaps: a.gaps, trackName: contName, quiet: i > 0 });
      if (!firstTrack) firstTrack = tr;
      const fix = Edit.repairWithSafety(a, 0, 1);
      if (fix) {
        await addRecordedTake(fix.audio, tr, `（保険で修復 ${fix.regions.length} か所）`, { gaps: a.gaps, quiet: true });
        showNotice(`本線が ${fix.regions.length} か所（計 ${fix.clippedSeconds.toFixed(1)} 秒）割れていたので、保険（${fix.gainDb >= 0 ? '+' : ''}${fix.gainDb.toFixed(1)} dB の差）で差し替えた録りを足して選びました。元の録りも残っています。`, true);
      } else {
        const main = Edit.extractChannel(a, 0);
        await addRecordedTake(main, tr, '（本線のみ）', { gaps: a.gaps, quiet: true });
      }
    } else {
      const tr = await addRecordedTake(a, dest, suffix, { startSeconds, gaps: a.gaps, trackName: contName, quiet: i > 0 });
      if (!firstTrack) firstTrack = tr;
    }
    offset += a.seconds;
  }
  state.pendingMarkers = [];
  if (recorded.prerollSeconds > 0.05) {
    showNotice(T('押す前の {sec} 秒も含めて残しました。', { sec: recorded.prerollSeconds.toFixed(1) }), false);
  }
  if (recorded.lostFrames > 0) {
    showNotice(`録音中に音が ${recorded.gaps.length} 回落ちました（合計 ${(recorded.lostFrames / recorded.sampleRate * 1000).toFixed(0)} ms）。落ちたところは無音で埋め、波形に赤い印を打っています。PC が重いか、機器のバッファが小さすぎます。`, true);
  }
  if (recorded.mirrorFiles && recorded.mirrorFiles.length) {
    showNotice(`フォルダにも書きました：${recorded.mirrorFiles.join('、')}`, false);
  }
}

export async function addRecordedTake(recorded, target, suffix = '', { startSeconds = 0, trackName: forcedName = null, gaps = null, quiet = false } = {}) {
  if (!recorded || recorded.seconds <= 0.01) return null;  // 中身が無いテイクは残さない

  const save = state.settings.saveFormat;
  const audioId = await saveTakeAudio(recorded, save);
  const name = (target ? `${target.takes.length + 1}回目の録り` : '1回目の録り') + suffix;
  const take = M.newTake(name, audioId, recorded);
  take.bytes = state.lastSavedBytes || 0;
  if (gaps && gaps.length) take.gaps = gaps.map(g => ({ at: g.at, seconds: g.seconds }));
  take.provenance = provenanceNow(recorded);
  if (state.pendingMarkers.length) take.markers = state.pendingMarkers.map(at => ({ at }));
  // クリック（1 サンプルの飛び）を探して印を残す。落ちた穴とは別の、機材トラブルの前触れ
  try {
    const clicks = Analysis.findClicks(recorded.samples, recorded.frames, recorded.channels, recorded.sampleRate);
    if (clicks.length) {
      take.clicks = clicks.slice(0, 200).map(c => ({ at: c.at, channel: c.channel, jump: c.jump }));
      showNotice(`「${name}」に 1 サンプルの飛び（クリック）が ${clicks.length} か所あります。USB ケーブル・ポート・ドライバのバッファを疑ってください。波形に印を打ちました。`, true);
    }
  } catch { }
  audioCache.set(take.id, recorded);

  if (state.session.sampleRate <= 0) state.session.sampleRate = recorded.sampleRate;

  const wasEmpty = state.session.tracks.length === 0;
  let trackName, track;
  if (target) {
    target.takes.push(take);
    target.activeTakeIndex = target.takes.length - 1;
    trackName = target.name;
    track = target;
  } else {
    track = M.newTrack(forcedName || M.nextTrackName(state.session), startSeconds);
    track.takes.push(take);
    state.session.tracks.push(track);
    trackName = track.name;
  }

  await saveSession(state.session);
  updateSessionUi();
  rebuildLanes();
  if (!quiet) noticeAfterTake(trackName);

  // タブは勝手に切り替えない。バッジだけ光らせて次の行き先を示す。
  if (wasEmpty) { const b = $('#tab-badge'); b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
  return track;
}

/**
 * 録り終わったときの一言。
 * メーターの判定は録っている最中しか出ないので、止めたあとにもう一度言う。
 * 気づかないまま小さすぎる録りを重ねるのを防ぐのが目的。
 */
export function noticeAfterTake(trackName) {
  const db = Meter.toDb(state.recPeak);
  const t = !isFinite(db) ? '無音' : `${db.toFixed(1)} dBTP`;

  if (state.recFlats > 0) {
    showNotice(T('「{name}」は波の頭が {n} 回平らになっています。0 dBFS には届いていなくても、機材側（プリアンプ）で歪んでいます。入力つまみを下げて録り直してください。', { name: trackName, n: state.recFlats }), true);
  } else if (!isFinite(db) || db < -55) {
    showNotice(T('「{name}」に音がほとんど入っていません（いちばん大きいところ {peak}）。マイクが拾えているか確かめてください。', { name: trackName, peak: t }),
      true, T('音のチェック'), openDiagnostics);
  } else if (db < Meter.GoodFromDb - 6) {
    showNotice(T('「{name}」は小さすぎます（いちばん大きいところ {peak}）。目安は −18〜−8 です。機材側の入力つまみを上げて録り直すと、あとが楽になります。', { name: trackName, peak: t }), true);
  } else if (db >= -0.5) {
    showNotice(T('「{name}」は音が割れています（{peak}）。つまみを下げて録り直してください。割れた音はあとから直せません。', { name: trackName, peak: t }), true);
  } else {
    showNotice(T('「{name}」を録りました（いちばん大きいところ {peak}）。いい音量です。', { name: trackName, peak: t }), false);
  }
}


/* ================= 録る場所 ================= */

export function selectedRecordTarget() {
  const v = $('#cmb-target').value;
  return v ? state.session.tracks.find(t => t.id === v) || null : null;
}

export function refreshRecordTargets() {
  const sel = $('#cmb-target');
  const previous = sel.value;
  sel.innerHTML = '';
  const first = new Option(T('新しいトラックに録る'), '');
  sel.add(first);
  for (const t of state.session.tracks) sel.add(new Option(T('{name} に録り足す', { name: t.name }), t.id));
  sel.value = [...sel.options].some(o => o.value === previous) ? previous : '';
}


/* ================= ズレ合わせ ================= */

export function updateAlignPill() {
  const measured = state.settings.latencyMeasured && state.settings.latencyFrames > 0;
  const btn = $('#btn-align');
  setText(btn, T(measured ? 'ズレ合わせ 済' : 'ズレ合わせ 未測定'));
  btn.className = 'btn btn-small align-pill ' + (measured ? 'measured' : 'unmeasured');
  show(btn, !measured);   // 揃っているのが普通なので、済んでいれば黙っている
  const ms = engine.sampleRate ? state.settings.latencyFrames / engine.sampleRate * 1000 : 0;
  btn.title = measured
    ? `往復 ${ms.toFixed(0)} ms ぶん詰めて録ります。押すと測り直します。`
    : '押すと、重ね録りのズレを測ります。';
}

export async function measureLatency() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }

  busy('テスト音を鳴らして、返ってくるまでを測っています…（3回）');
  let result;
  try { result = await engine.measureRoundTrip(3, 1200); }
  catch (e) { unbusy(); showError(e.message); return; }
  unbusy();

  const rate = engine.recordRate;
  if (result.ok) {
    state.settings.latencyFrames = result.frames;
    state.settings.latencyMeasured = true;
    await store.setSettings(state.settings);
    showNotice(`ズレ合わせを測りました。往復 ${(result.frames / rate * 1000).toFixed(0)} ms（${result.frames} サンプル）。${result.detail}`, false);
  } else {
    showNotice(`測れませんでした。${result.detail}\n出力の音量を上げるか、ヘッドホンの片方をマイクに近づけて、もう一度試してください。`, true);
  }
  updateAlignPill();
  updateSettingsDialog();
}


/* ================= モニター ================= */

export async function toggleMonitor() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }

  if (!engine.monitorEnabled && !state.monitorWarned) {
    const ok = await ask('自分の音を聞く',
      '自分の音をヘッドホンに返します。\n\n' +
      '⚠ 必ずヘッドホンを使ってください。\n' +
      'スピーカーだとマイク→スピーカー→マイクの輪ができて、\nピーという大きな音（ハウリング）になります。\n\n続けますか？');
    if (!ok) return;
    state.monitorWarned = true;
  }
  engine.setMonitor(!engine.monitorEnabled, 1);
  updateMonitorInfo();
}

export function updateMonitorInfo() {
  const on = engine.isOpen && engine.monitorEnabled;
  setText($('#btn-monitor'), on ? '自分の音を聞くのをやめる' : 'ヘッドホンで自分の音を聞く');
  const info = $('#txt-monitor-info');

  if (!engine.isOpen) { setText(info, ''); return; }
  if (!on) {
    setText(info, 'ブラウザ経由なので音が遅れて返ります。弾きながら聞くには向きません。');
    return;
  }
  const ms = engine.sampleRate ? state.settings.latencyFrames / engine.sampleRate * 1000 : 0;
  setText(info, ms > 0
    ? `聞こえるまでの遅れはおよそ ${ms.toFixed(0)} ms（実測）`
    : '遅れはまだ測っていません');
}


/* ================= 置き場所の残り ================= */

/** あと何分録れるか。OPFS も IndexedDB も同じ quota を使う。 */
export async function updateStorageLeft() {
  const e = await store.estimate();
  if (!e || !e.quota) { setText($('#txt-storage'), ''); return; }
  const free = Math.max(0, e.quota - e.usage);
  const rate = engine.recordRate || 48000, ch = engine.recordChannels || 2;
  const perSec = rate * ch * 4;
  const minutes = free / perSec / 60;
  const gb = (free / 1024 / 1024 / 1024).toFixed(1);
  const el = $('#txt-storage');
  const text = minutes >= 120 ? `あと約 ${Math.floor(minutes / 60)} 時間 ${Math.round(minutes % 60)} 分 録れます（空き ${gb} GB）`
    : minutes >= 1 ? `あと約 ${Math.round(minutes)} 分 録れます（空き ${gb} GB）` : `⚠ 置き場所がほぼいっぱいです（空き ${gb} GB）`;
  setText(el, text);
  el.classList.toggle('warn', minutes < 10);
  show(el, minutes < 30);   // 余裕があるときは黙っている
  state.storageMinutes = minutes;
  if (minutes < 10 && !state.storageWarned) {
    state.storageWarned = true;
    showNotice(T('置き場所の空きが少なく、あと約 {min} 分しか録れません。古い録音を「録音一覧」で消すか、丸ごと書き出して外へ移してください。', { min: Math.max(0, Math.round(minutes)) }), true, T('録音一覧'), openSessions);
  }
}


/* ================= 印と移動 ================= */

/** 「ここ良かった」の印。録音中はいまの位置、再生中は聞いている位置に。音は変えない。 */
export async function addMarker() {
  let take = null, at = 0, trackName = '';
  if (engine.isRecording) {
    state.pendingMarkers.push(engine.recordedSeconds);
    showNotice(`印を打ちました（${Meter.mmss(engine.recordedSeconds)}）。止めたときに録りに残ります。`, false);
    return;
  }
  if (engine.isPlaying) {
    const lane = state.selectedLane || state.lanes[0];
    if (!lane) return;
    take = M.activeTake(lane.track);
    at = engine.playbackSeconds - lane.offset();
    trackName = lane.track.name;
  } else return;
  if (!take || at < 0) return;
  (take.markers || (take.markers = [])).push({ at });
  await saveSession(state.session);
  redrawLanes();
  showNotice(`「${trackName}」の ${Meter.mmss(at)} に印を打ちました。`, false);
}

export async function seekBy(seconds) {
  if (!engine.isPlaying) return;
  const at = Math.max(0, Math.min(M.sessionLength(state.session) - 0.1, engine.playbackSeconds + seconds));
  engine.stopPlayback();
  try { await engine.startPlayback(state.session, { startSeconds: at, loadTake }); } catch (e) { showError(e.message); }
  updateTransport();
}


/* ================= 録音証明 ================= */

/** いまの経路の証拠。テイクに残し、書き出す WAV の bext と証明書に載せる。 */
export function provenanceNow(recorded) {
  const st = engine.status() || {};
  const g = state.grade;
  const v = state.verify;
  return {
    at: new Date().toISOString(),
    device: st.device || '', path: st.rawPath ? 'raw' : 'audiocontext', captureRate: st.captureRate || st.contextRate || 0,
    channels: recorded ? recorded.channels : st.channels, resampled: !!st.resampled,
    processing: st.clean ? 'off' : st.unknown ? 'unknown' : 'on',
    bits: g ? g.bits : 0, floorDb: g && g.floorDb != null ? g.floorDb : null,
    verify: v ? (v.identical ? 'identical' : v.ok ? `gain ${v.gainDb.toFixed(2)} dB / residual ${v.residualDb.toFixed(0)} dB` : 'n/a') : null,
    gaps: recorded && recorded.gaps ? recorded.gaps.length : 0, lostFrames: recorded ? recorded.lostFrames || 0 : 0,
    prerollSeconds: recorded ? recorded.prerollSeconds || 0 : 0,
    driftPpm: (() => { const d = engine.drift(); return d.ready && d.relativePpm != null ? Math.round(d.relativePpm) : null; })(),
    storage: engine.storageKind, mirror: !!engine.mirror,
  };
}

/** BWF の CodingHistory 行。EBU の A=…,F=…,W=…,M=…,T=… の形に、経路の証拠を足す。 */
export function codingHistory(prov, channels, rate, bits) {
  const m = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels}ch`;
  const t = [
    `Tonmeister web`,
    prov ? `path=${prov.path}` : null,
    prov && prov.bits ? `arrived=${prov.bits === 32 ? 'float' : prov.bits + 'bit'}` : null,
    prov ? `processing=${prov.processing}` : null,
    prov && prov.verify ? `verify=${prov.verify}` : null,
    prov && prov.floorDb != null ? `floor=${prov.floorDb.toFixed(1)}dBFS` : null,
    prov ? `gaps=${prov.gaps}` : null,
    prov && prov.driftPpm != null ? `drift=${prov.driftPpm}ppm` : null,
  ].filter(Boolean).join(';');
  return `A=PCM,F=${rate},W=${bits},M=${m},T=${t}\r\n`;
}

/** 書き出す WAV に付ける bext。 */
export function bextFor(description, prov, channels, rate, format, timeReferenceSeconds = 0) {
  return {
    description: description.slice(0, 250),
    originator: 'Tonmeister',
    originatorReference: state.session.id.slice(0, 32),
    timeReference: Math.round(timeReferenceSeconds * rate),
    codingHistory: codingHistory(prov, channels, rate, format === SaveFormat.Pcm24 ? 24 : 32),
  };
}

/** 人が読む証明書。 */
export function provenanceText() {
  const s = state.session;
  const lines = [`${s.name} — 録音証明`, `Tonmeister ${new Date().toLocaleString('ja-JP')}`, '', 'この録音は、次の経路で録られました。素の WAV には録音後いっさい手を加えていません。', ''];
  for (const t of s.tracks) {
    for (const k of t.takes) {
      const p = k.provenance;
      lines.push(`■ ${t.name} / ${k.name}　${k.seconds.toFixed(1)} 秒・${(k.sampleRate / 1000).toFixed(1)} kHz・${k.channels}ch${t.startSeconds ? `・開始 ${t.startSeconds.toFixed(3)} 秒` : ''}`);
      if (!p) { lines.push('  （証拠なし：以前の版で録ったテイク）'); continue; }
      lines.push(`  録った時刻：${p.at}`);
      lines.push(`  入り口：${p.device}`);
      lines.push(`  道：${p.path === 'raw' ? '生フレーム取得（AudioContext を通らない。再標本化なし）' : 'AudioContext 経由' + (p.resampled ? '（⚠ 再標本化あり）' : '')}　${p.captureRate} Hz`);
      lines.push(`  ブラウザの加工：${p.processing === 'off' ? 'すべて切' : p.processing === 'unknown' ? '不明（ブラウザが答えない）' : '⚠ 残っている'}`);
      lines.push(`  届いたビット数：${p.bits === 16 ? '⚠ 16bit' : p.bits === 24 ? '24bit' : p.bits === 32 ? 'float（整数の刻みに乗っていない）' : '未確定'}`);
      if (p.verify) lines.push(`  経路の検証：${p.verify === 'identical' ? '2つの道で 1 サンプルも違わず一致' : p.verify}`);
      if (p.floorDb != null) lines.push(`  暗騒音：${p.floorDb.toFixed(1)} dBFS`);
      lines.push(`  落ちた音：${p.gaps} 回${p.lostFrames ? `（${p.lostFrames} フレームを無音で埋めて長さを保った）` : ''}`);
      if (p.prerollSeconds > 0.05) lines.push(`  押す前の音：${p.prerollSeconds.toFixed(1)} 秒を先頭に含む`);
      if (p.driftPpm != null) lines.push(`  クロックのずれ：${p.driftPpm >= 0 ? '+' : ''}${p.driftPpm} ppm`);
      if (k.gaps && k.gaps.length) lines.push(`  穴の位置：${k.gaps.map(g => g.at.toFixed(2) + 's').join(', ')}`);
      if (k.clicks && k.clicks.length) lines.push(`  クリック：${k.clicks.length} か所（${k.clicks.slice(0, 8).map(c => c.at.toFixed(2) + 's').join(', ')}${k.clicks.length > 8 ? '…' : ''}）`);
      lines.push(`  受け皿：${p.storage === 'opfs' ? 'OPFS へ同期追記' : 'IndexedDB'}${p.mirror ? '＋フォルダ直書き' : ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}


/* ================= 経路の格 ================= */

export function scheduleAssess(ms) { setTimeout(() => assessNow(), ms); }

/** 開いた瞬間（と測り直し）に、素のまま録れるかを測って1行にする。録音・再生中は測らない。 */
export async function assessNow() {
  if (!engine.isOpen || engine.isRecording || engine.isPlaying || state.grading) return;
  state.grading = true;
  try {
    const r = await Quality.assessPath(engine, { seconds: 1.5, previous: state.grade });
    if (r) { state.grade = r; state.gradeAt = performance.now(); renderGrade(); }
  } catch { }
  finally { state.grading = false; }
}

export function renderGrade() {
  const r = state.grade;
  const box = $('#path-grade');
  const pill = $('#pill-grade');
  if (!r) { show(box, false); show(pill, false); return; }
  // 印はいつも状態ピルに。詳しい箱は「手当てが要る」ときだけ自動で開く（それ以外は印を押したとき）
  show(pill, true);
  show($('#status-dot'), false);   // 格の印が丸の代わりになる
  setText(pill, r.grade);
  pill.className = 'pill-grade ' + (r.grade === '◎' ? '' : r.grade === '○' ? 'soft' : 'bad');
  if (r.grade === '△' && !state.gradeDismissed) show(box, true);
  else if (state.gradeAuto !== false && r.grade !== '△') show(box, false);
  const mark = $('#txt-grade-mark');
  setText(mark, r.grade);
  mark.className = 'grade-mark ' + (r.grade === '◎' ? '' : r.grade === '○' ? 'soft' : 'bad');
  setText($('#txt-grade-title'), T(r.title));
  setText($('#txt-grade-summary'), r.summary);
  const d = $('#pnl-grade-detail');
  d.innerHTML = '';
  for (const line of r.lines) {
    const p = document.createElement('p');
    p.className = line.kind;
    p.textContent = line.text;
    d.appendChild(p);
  }
  for (const a of r.actions) {
    const p = document.createElement('p');
    p.className = 'act';
    p.textContent = '→ ' + a;
    d.appendChild(p);
  }
}

/** ビット数が分からなかったら、音が出たときにもう一度測る。ずれは 30 秒ごとに更新。 */
export function gradeTick(db) {
  const r = state.grade;
  if (!r || state.grading || engine.isRecording || engine.isPlaying || !engine.isOpen) return;
  const since = performance.now() - state.gradeAt;
  if (r.bits === 0 && db > -40 && since > 3000) { assessNow(); return; }
  if (r.sounding && db < -50 && since > 5000) { assessNow(); return; }   // 静かになったので暗騒音を測る
  if (since > 30000) {
    const dr = engine.drift();
    const wasReady = r.drift && r.drift.ready;
    if (dr.ready && (!wasReady || Math.abs((dr.relativePpm || 0) - (r.drift.relativePpm || 0)) > 3)) assessNow();
    else state.gradeAt = performance.now();
  }
}


/* ================= 試し弾き ================= */

export async function trialGain() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  if (engine.isRecording || engine.isPlaying || state.trial) return;
  state.trial = true;
  const el = $('#txt-trial');
  show(el, true);
  el.className = 'trial center';
  try {
    // 6 秒取り込みながら、残り秒数を見せる
    const capture = engine.captureForAnalysis(6);
    for (let i = 6; i > 0; i--) { setText(el, `楽器をいちばん強く鳴らしてください… ${i}`); await delay(1000); }
    setText(el, '測っています…');
    const cap = await capture;
    const info = Edit.truePeakInfo(cap);
    const adv = Quality.adviseGain(info);
    setText(el, adv.text);
    el.className = 'trial center' + (adv.verdict === 'distorted' || adv.verdict === 'hot' ? ' bad' : adv.verdict === 'low' || adv.verdict === 'silent' ? ' warn' : '');
  } catch (e) { setText(el, '測れませんでした: ' + e.message); }
  finally { state.trial = false; }
}


/* ================= ドリフト補正 ================= */

export function driftKey() { return `${state.settings.deviceId || 'auto'}|${state.settings.outputDeviceId || 'auto'}`; }

/** 重ね録りのときに再生側で相殺する ppm。いま測れていればそれ、無ければこの機器の組で前に測った値。 */
export function driftForOverdub() {
  if (!state.settings.driftCompensate) return 0;
  const dr = engine.drift();
  if (dr.ready && dr.relativePpm != null && dr.seconds >= 30) return dr.relativePpm;
  const mem = state.settings.driftMemory || {};
  return mem[driftKey()] || 0;
}

/** 測れたずれを、機器の組ごとに覚えておく（次に開いてすぐ重ね録りしても使えるように）。 */
export async function rememberDrift() {
  const dr = engine.drift();
  if (!dr.ready || dr.relativePpm == null || dr.seconds < 60) return;
  const mem = state.settings.driftMemory || (state.settings.driftMemory = {});
  const key = driftKey();
  if (mem[key] != null && Math.abs(mem[key] - dr.relativePpm) < 1) return;
  mem[key] = Math.round(dr.relativePpm * 10) / 10;
  await store.setSettings(state.settings);
}


/* ================= 録音を守る ================= */

/**
 * 画面を眠らせない・裏に回っても止めない・うっかり閉じさせない。
 * 録音そのものは Worker と AudioWorklet で続くが、ノート PC のスリープだけは止められないので wakeLock で頼む。
 */
export function guardRecording() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      document.title = 'Tonmeister — 録音';
      if (engine.isRecording) {
        await acquireWakeLock();
        showNotice(T('裏に回っていた間も録れています（落ちた音 {n} 回）。', { n: engine.gapCount }), engine.gapCount > 0);
      }
    } else if (engine.isRecording) {
      document.title = '● 録音中 — Tonmeister';
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (engine.isRecording && !engine._recToMemory) { e.preventDefault(); e.returnValue = '録音中です。閉じると止まります。'; }
  });
  engine.onGap = (m) => {
    if (engine.isRecording) return;   // 録音中は録音中バーの数で見せる
    // 録っていないときに落ちたら、状態ピルで静かに知らせる（機器や PC が詰まっているサイン）
    if (m.gapCount === 1 || m.gapCount % 10 === 0) showNotice(T('入力の音が {n} 回落ちています（合計 {ms} ms）。PC が重いか、機器のバッファが小さすぎます。', { n: m.gapCount, ms: (m.lostFrames / engine.recordRate * 1000).toFixed(0) }), true);
  };
  engine.onRollover = (n) => showNotice(T('長くなったので次の受け皿に切り替えました（{n} 本目）。音は1つも落としていません。止めると続きのトラックとして並びます。', { n: n + 1 }), false);
}

export async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    if (state.wakeLock && !state.wakeLock.released) return;
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch { state.wakeLock = null; }
}

export function releaseWakeLock() {
  if (state.wakeLock) { try { state.wakeLock.release(); } catch { } state.wakeLock = null; }
}

/** 開いたとき（と機器を変えたとき）に一度だけ、ズレ合わせを自動で測る。 */
export async function autoMeasureLatency() {
  const s = state.settings;
  if (!s.autoLatency || state.latencyAutoDone || state.fake || !engine.isOpen) return;
  if (s.latencyMeasured && s.latencyFrames > 0) { state.latencyAutoDone = true; return; }
  state.latencyAutoDone = true;
  if (engine.isRecording || engine.isPlaying) return;
  try {
    const result = await engine.measureRoundTrip(3, 1200);
    if (result.ok) {
      s.latencyFrames = result.frames;
      s.latencyMeasured = true;
      await store.setSettings(s);
      showNotice(T('ズレ合わせを自動で測りました：往復 {ms} ms。', { ms: (result.frames / engine.recordRate * 1000).toFixed(0) }), false);
    } else {
      showNotice('ズレ合わせを自動で測れませんでした（テスト音がマイクに届いていません）。重ねて録るときは「ズレ合わせ」を押して測ってください。', false);
    }
  } catch { }
  updateAlignPill();
}

