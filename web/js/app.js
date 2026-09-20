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

/* ================= 小物 ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const show = (el, on = true) => { if (el) el.hidden = !on; };
const setText = (el, t) => { if (el) el.textContent = T(String(t)); };   // 辞書に載っている文はそのまま英語になる

/** 録り直しの前に何秒ぶん聴かせるか（助走）。 */
const PREROLL_SECONDS = 2.0;

/* ================= 状態 ================= */

const engine = new Engine();

const state = {
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

const LIVE_CAPACITY = 450;        // 33ms × 450 ≒ 15 秒
const audioCache = new Map();     // takeId → 復号した音

/* ================= 音の読み書き ================= */

async function loadTake(take) {
  if (!take) return null;
  if (audioCache.has(take.id)) return audioCache.get(take.id);
  const blob = await store.getAudio(take.audioId);
  if (!blob) return null;
  const audio = decodeWav(await blob.arrayBuffer());
  audioCache.set(take.id, audio);
  return audio;
}

async function saveTakeAudio(audio, format) {
  const id = M.uid();
  const blob = encodeWav(audio.samples, audio.channels, audio.sampleRate, format);
  await store.putAudio(id, blob);
  state.lastSavedBytes = blob.size;
  return id;
}

/** セッションの保存。フォルダを選んであれば、少し待ってから session.json の写しも書く（自動バックアップ）。 */
async function saveSession(session) {
  const r = await store.saveSession(session);
  scheduleBackup();
  return r;
}

let backupTimer = null;
function scheduleBackup() {
  if (!state.mirrorDir || !engine.mirror) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backupSessionJson, 5000);
}

async function backupSessionJson() {
  if (!state.mirrorDir || !engine.mirror) return;
  try {
    const sub = await state.mirrorDir.getDirectoryHandle(state.session.name.replace(/[\\/:*?"<>|]/g, '_'), { create: true });
    const fh = await sub.getFileHandle('session.json', { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(JSON.stringify(sessionMeta(), null, 2));
    await w.close();
  } catch { }
}

/* ================= 起動 ================= */

async function init() {
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

async function loadLatestOrNewSession() {
  const list = await store.listSessions();
  let session = null;
  if (state.settings.lastSessionId) session = list.find(s => s.id === state.settings.lastSessionId) || null;
  if (!session) session = list[0] || null;
  await setSession(session || M.newSession());
  if (!list.length) await saveSession(state.session);
}

async function setSession(session) {
  state.session = M.upgradeSession(session);
  if (engine.mirror && state.mirrorDir) engine.mirror = new DiskMirror(state.mirrorDir, session.name);
  state.settings.lastSessionId = session.id;
  await store.setSettings(state.settings);
  audioCache.clear();
  Wave.clearCache();
  rebuildLanes();
  updateSessionUi();
}

function autoSave() {
  if (!state.dirty || engine.isRecording) return;
  state.dirty = false;
  saveSession(state.session).catch(() => { state.dirty = true; });
}

const touch = () => { state.dirty = true; };

/**
 * 前回、録音の途中で閉じてしまった音を拾う。
 * デスクトップ版の「壊れた WAV ヘッダの自動修復」にあたる。
 */
async function recoverOrphans() {
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

/* ================= 入力（音の入り口） ================= */

async function openInput() {
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

async function ensureOpen() {
  if (engine.isOpen) return null;
  try { await openInput(); return null; }
  catch (e) { return e.message; }
}

/** 「いま何につながっているか」を1行で。 */
function updateInputStatus() {
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

function setMode(mode) {
  state.mode = mode;
  updateTabs();
  updatePanes();
  if (mode === 'overdub') { drawRuler(); redrawLanes(); }
}

function updateTabs() {
  const rec = state.mode === 'record';
  $('#tab-record').classList.toggle('is-active', rec);
  $('#tab-overdub').classList.toggle('is-active', !rec);

  const n = state.session.tracks.length;
  const badge = $('#tab-badge');
  setText(badge, n === 0 ? T('まだ0本') : T('{n}本', { n }));
  badge.classList.toggle('has', n > 0);

  show($('#btn-check'), !rec);
  show($('#btn-export'), !rec);
}

function updatePanes() {
  const recording = engine.isRecording;
  show($('#tabbar'), !recording);
  show($('#recbar'), recording);
  show($('#pane-recording'), recording);
  show($('#pane-record'), !recording && state.mode === 'record');
  show($('#pane-overdub'), !recording && state.mode === 'overdub');
  if (!recording && state.mode === 'record') { drawScale(); drawRing(0); }
}

/* ================= 画面更新（33ms ごと） ================= */

function uiTick() {
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

function setTime(seconds) {
  const text = Meter.hmsT(seconds);
  setText($('#txt-time'), text);
  setText($('#txt-big-time'), text);
}

function updateMeters() {
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
function updateOutputMeter() {
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

const outputLooksSilent = () => state.silentSince && performance.now() - state.silentSince > 1500;

function setLevel(ratio) {
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

function setMiniLevel(ratio) {
  const well = $('#mini-level').parentElement;
  const w = well.clientWidth;
  if (w <= 1) return;
  const good = $('#mini-good');
  good.style.left = (w * Meter.GoodFrom) + 'px';
  good.style.width = Math.max(1, w * (Meter.GoodTo - Meter.GoodFrom)) + 'px';
  $('#mini-level').style.width = (w * ratio) + 'px';
}

/** 判定文は 500ms 落ち着いてから切り替える（チラつき防止）。 */
function setVerdict(verdict, force = false) {
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

function refreshMiniVerdict() {
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
function updateSteps() {
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

function buildOrnaments() {
  drawGuilloche();
  drawRosette();
  drawScale();
}

function drawGuilloche() {
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

function drawRosette() {
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

const RING_START = 135, RING_SWEEP = 270;

function drawRing(ratio) {
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
function drawScale() {
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

function pushLive(peak) {
  if (!engine.isRecording) {
    if (state.live.length) { state.live.length = 0; drawLiveWave(); }
    return;
  }
  state.live.push(peak);
  if (state.live.length > LIVE_CAPACITY) state.live.splice(0, state.live.length - LIVE_CAPACITY);
  drawLiveWave();
}

function drawLiveWave() {
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

function updateTransport() {
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

async function startRecording(forceTarget) {
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
function showAlignToast(overdub) {
  const on = overdub && !state.settings.latencyMeasured && !state.alignToastShown;
  show($('#align-toast'), on);
  if (on) state.alignToastShown = true;
}

async function startPlayback() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  try {
    const ok = await engine.startPlayback(state.session, { loadTake, effectiveGain: M.effectiveGain });
    if (!ok) { showError('鳴らせるトラックがありません。'); return; }
  } catch (e) { showError(e.message); }
  finally { updateTransport(); }
}

async function stopAll() {
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
async function addRecordedTakes(recorded, target) {
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

async function addRecordedTake(recorded, target, suffix = '', { startSeconds = 0, trackName: forcedName = null, gaps = null, quiet = false } = {}) {
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
function noticeAfterTake(trackName) {
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

function selectedRecordTarget() {
  const v = $('#cmb-target').value;
  return v ? state.session.tracks.find(t => t.id === v) || null : null;
}

function refreshRecordTargets() {
  const sel = $('#cmb-target');
  const previous = sel.value;
  sel.innerHTML = '';
  const first = new Option(T('新しいトラックに録る'), '');
  sel.add(first);
  for (const t of state.session.tracks) sel.add(new Option(T('{name} に録り足す', { name: t.name }), t.id));
  sel.value = [...sel.options].some(o => o.value === previous) ? previous : '';
}

/* ================= ズレ合わせ ================= */

function updateAlignPill() {
  const measured = state.settings.latencyMeasured && state.settings.latencyFrames > 0;
  const btn = $('#btn-align');
  setText(btn, T(measured ? 'ズレ合わせ 済' : 'ズレ合わせ 未測定'));
  btn.className = 'btn btn-small align-pill ' + (measured ? 'measured' : 'unmeasured');
  const ms = engine.sampleRate ? state.settings.latencyFrames / engine.sampleRate * 1000 : 0;
  btn.title = measured
    ? `往復 ${ms.toFixed(0)} ms ぶん詰めて録ります。押すと測り直します。`
    : '押すと、重ね録りのズレを測ります。';
}

async function measureLatency() {
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

async function toggleMonitor() {
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

function updateMonitorInfo() {
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

/* ================= セッションの見出し ================= */

function updateSessionUi() {
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
function updateFinishUi() {
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
async function changeFinish(mutate, rebuild = false) {
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

async function setDial(level) {
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

async function restartPlaybackInPlace() {
  const at = engine.playbackSeconds;
  engine.stopPlayback();
  try { await engine.startPlayback(state.session, { startSeconds: at, loadTake }); }
  catch (e) { showError(e.message); }
  updateTransport();
}

async function setListen(mode) {
  if (state.session.listen === mode) return;
  state.session.listen = mode;
  await saveSession(state.session);
  updateFinishUi();
  engine.setListen(state.session);   // 再生中でも瞬時に切り替わる（組み直さない）
}

/** 素と仕上げを実際に作って比べる。長いセッションでは少し待つ。 */
async function measureFinishNow() {
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

function setHoldPure(on) {
  engine.holdPure(on);
  $('#btn-hold-pure').classList.toggle('holding', on);
}

/* ================= レーン（重ねるモード） ================= */

function rebuildLanes() {
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

function redrawLanes() { for (const lane of state.lanes) lane.redraw(); }

const WAVE_COLORS = ['#C9A227', '#4E7CB5', '#B3A98F', '#B06A2C']; // 金／ベルリン藍／象牙／赤銅

/**
 * 「重ねる」モードの1トラック分のレーン。
 * 波形・テイクの選び直し・部分録り直し・切り出しを、その行の中だけで完結させる。
 */
function createLane(track, colorIndex) {
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

function selectLane(lane) {
  for (const other of state.lanes) {
    if (other !== lane) { other.selStart = other.selEnd = null; other.updateBottomRow(); other.redraw(); }
    other.el.classList.toggle('selected', other === lane);
  }
  state.selectedLane = lane;
  updateInspector();
}

/* ================= インスペクタ ================= */

function updateInspector() {
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

function setSwitch(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); }
const switchOn = (el) => el.getAttribute('aria-checked') === 'true';

/* ================= 切り出し・部分録り直し ================= */

async function requestCrop(lane) {
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

async function requestPunch(lane) {
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

async function finishPunch(punch, recorded) {
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

function drawRuler() {
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

/* ================= 報せの帯 ================= */

/**
 * 画面の上に短く出す一言。叱るためではなく、次にやることを示すために出す。
 * action を渡すと、その場で1つだけ操作を足せる（取り消しなど）。
 */
function showNotice(text, warn, actionLabel, action) {
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

function hideNotice() {
  clearTimeout(state.noticeTimer);
  show($('#notice'), false);
  state.noticeAction = null;
}

/* ================= 問いと注意 ================= */

function ask(title, body, okLabel = '続ける', cancelLabel = 'やめる') {
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

function showError(message) {
  const dlg = $('#dlg-ask');
  setText($('#ask-title'), 'Tonmeister');
  setText($('#ask-body'), message);
  setText($('#ask-ok'), T('分かりました'));
  show($('#ask-cancel'), false);
  dlg.showModal();
  $('#ask-ok').onclick = () => { dlg.close(); $('#ask-ok').onclick = null; };
}

function busy(text) { setText($('#busy-text'), text); show($('#busy'), true); }
function unbusy() { show($('#busy'), false); }

/* ================= 詳しい設定 ================= */

const RATES = [44100, 48000, 88200, 96000, 176400, 192000];

async function openSettings() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  await refreshDeviceList();
  updateSettingsDialog();
  $('#dlg-settings').showModal();
}

async function refreshDeviceList() {
  const host = $('#device-list');
  host.innerHTML = '';
  let devices = [];
  try { devices = await Engine.listInputDevices(); } catch { }
  show($('#txt-no-device'), devices.length === 0);

  const rows = [{ deviceId: '', label: '自動（ブラウザが選ぶ入り口）' }, ...devices];
  for (const d of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'device-row' + (d.deviceId === state.settings.deviceId ? ' on' : '');
    b.innerHTML = '<i class="ring"></i><span class="body"></span>';
    const body = $('.body', b);
    const name = document.createElement('b');
    name.textContent = d.label || '（許可すると名前が出ます）';
    const note = document.createElement('span');
    note.textContent = d.deviceId === '' ? 'いちばん確実。特に理由がなければこれで。' : `id ${d.deviceId.slice(0, 12)}…`;
    body.append(name, note);
    b.onclick = async () => {
      state.settings.deviceId = d.deviceId;
      await store.setSettings(state.settings);
      await reopenInput();
      await refreshDeviceList();
      updateSettingsDialog();
    };
    host.appendChild(b);
  }

  // 鳴らす機器
  const out = $('#cmb-output');
  out.innerHTML = '';
  out.add(new Option('自動（ブラウザがいま使っている機器）', ''));
  if (engine.canChooseOutput) {
    let outs = [];
    try { outs = await Engine.listOutputDevices(); } catch { }
    for (const d of outs) out.add(new Option(d.label || '（名前の分からない機器）', d.deviceId));
    out.disabled = false;
    setText($('#txt-output-note'),
      '既定は「自動」。ヘッドホンを挿せば、そのままヘッドホンへ移ります。' +
      '名指しで選ぶと以後そこへ固定されるので、他のアプリでは鳴るのにここだけ鳴らない、が起きることがあります。');
  } else {
    out.disabled = true;
    setText($('#txt-output-note'), 'このブラウザは出す先を選べません。OS 側の既定の機器へ出します。');
  }
  out.value = state.settings.outputDeviceId || '';
}

async function reopenInput() {
  engine.close();
  state.latencyAutoDone = false;
  state.grade = null;
  show($('#path-grade'), false);
  try { await openInput(); autoMeasureLatency(); scheduleAssess(1200); }
  catch (e) { showError(e.message); updateInputStatus(); }
}

/* ================= スマホ・PWA ================= */

const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function needsGesture(err) {
  const n = err && (err.name || '');
  const m = String(err && err.message || '');
  return isTouch || isIOS || /NotAllowed|gesture|user activation|許可されていません/i.test(n + ' ' + m);
}

function showTapStart() {
  show($('#tap-start'), true);
  $('#btn-tap-start').onclick = async () => {
    show($('#tap-start'), false);
    try {
      if (engine.ctx && engine.ctx.state === 'suspended') await engine.ctx.resume();
      if (!engine.isOpen) { await openInput(); autoMeasureLatency(); scheduleAssess(1200); }
    } catch (e) { showNotice(e.message, true, '詳しい設定', openSettings); }
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

/** この端末・ブラウザで何が使えて何が使えないかを、最初に一度だけ正直に言う。 */
function platformNotes() {
  const notes = [];
  if (!Engine.canRawCapture) notes.push('生フレーム取得が無いので AudioContext 経由で受けます（Chrome / Edge なら生取得）');
  if (!navigator.wakeLock) notes.push('画面を起こしておく wakeLock が無いので、長い録音中は画面が眠らないよう設定してください');
  if (isIOS) notes.push('iOS では、裏に回ると録音が止まることがあります。録音中はこの画面を表に');
  if (!window.showDirectoryPicker) notes.push('フォルダ直書き・フォルダ読み込みはこのブラウザでは使えません（ファイル選択で代わりに）');
  if (notes.length && (isTouch || isIOS || !Engine.canRawCapture)) {
    setTimeout(() => showNotice('この環境：' + notes.join('／') + '。', false), 2500);
  }
}

/* ================= 言語 ================= */

function updateLangButton() {
  const b = $('#btn-lang');
  if (!b) return;
  setText(b, currentLang() === 'en' ? '日本語' : 'EN');
  b.title = currentLang() === 'en' ? '日本語で表示' : 'Show in English';
}

function toggleLang() {
  setLang(currentLang() === 'en' ? 'ja' : 'en');
  updateLangButton();
  updateInputStatus();
  updateSessionUi();
  updateFinishUi();
  renderGrade();
  setVerdict(state.verdict, true);
}

/* ================= 置き場所の残り ================= */

/** あと何分録れるか。OPFS も IndexedDB も同じ quota を使う。 */
async function updateStorageLeft() {
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
  state.storageMinutes = minutes;
  if (minutes < 10 && !state.storageWarned) {
    state.storageWarned = true;
    showNotice(`置き場所の空きが少なく、あと約 ${Math.max(0, Math.round(minutes))} 分しか録れません。古い録音を「録音一覧」で消すか、丸ごと書き出して外へ移してください。`, true, '録音一覧', openSessions);
  }
}

/* ================= 印と移動 ================= */

/** 「ここ良かった」の印。録音中はいまの位置、再生中は聞いている位置に。音は変えない。 */
async function addMarker() {
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

async function seekBy(seconds) {
  if (!engine.isPlaying) return;
  const at = Math.max(0, Math.min(M.sessionLength(state.session) - 0.1, engine.playbackSeconds + seconds));
  engine.stopPlayback();
  try { await engine.startPlayback(state.session, { startSeconds: at, loadTake }); } catch (e) { showError(e.message); }
  updateTransport();
}

/* ================= 元に戻す ================= */
/*
   セッション（JSON）を丸ごと控える。音そのものは消さないので、控えを戻すだけでどの操作も戻せる。
   名前・テイクの選び直し・音量・消音・単独・仕上げ・外す・切り出し・録り直し・読み込み。
*/
const history = { undo: [], redo: [] };
const HISTORY_MAX = 50;

function snapshot(label) {
  history.undo.push({ label, json: JSON.stringify(state.session) });
  if (history.undo.length > HISTORY_MAX) history.undo.shift();
  history.redo.length = 0;
}

async function restoreSnapshot(json) {
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

async function undo() {
  if (engine.isRecording) return;
  const h = history.undo.pop();
  if (!h) { showNotice(T('戻すものがありません。'), false); return; }
  history.redo.push({ label: h.label, json: JSON.stringify(state.session) });
  if (await restoreSnapshot(h.json)) showNotice(T('戻しました：{label}', { label: h.label }), false, T('やり直す'), redo);
}

async function redo() {
  if (engine.isRecording) return;
  const h = history.redo.pop();
  if (!h) return;
  history.undo.push({ label: h.label, json: JSON.stringify(state.session) });
  if (await restoreSnapshot(h.json)) showNotice(T('やり直しました：{label}', { label: h.label }), false);
}

/* ================= 録音証明 ================= */

/** いまの経路の証拠。テイクに残し、書き出す WAV の bext と証明書に載せる。 */
function provenanceNow(recorded) {
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
function codingHistory(prov, channels, rate, bits) {
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
function bextFor(description, prov, channels, rate, format, timeReferenceSeconds = 0) {
  return {
    description: description.slice(0, 250),
    originator: 'Tonmeister',
    originatorReference: state.session.id.slice(0, 32),
    timeReference: Math.round(timeReferenceSeconds * rate),
    codingHistory: codingHistory(prov, channels, rate, format === SaveFormat.Pcm24 ? 24 : 32),
  };
}

/** 人が読む証明書。 */
function provenanceText() {
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

function scheduleAssess(ms) { setTimeout(() => assessNow(), ms); }

/** 開いた瞬間（と測り直し）に、素のまま録れるかを測って1行にする。録音・再生中は測らない。 */
async function assessNow() {
  if (!engine.isOpen || engine.isRecording || engine.isPlaying || state.grading) return;
  state.grading = true;
  try {
    const r = await Quality.assessPath(engine, { seconds: 1.5, previous: state.grade });
    if (r) { state.grade = r; state.gradeAt = performance.now(); renderGrade(); }
  } catch { }
  finally { state.grading = false; }
}

function renderGrade() {
  const r = state.grade;
  const box = $('#path-grade');
  if (!r) { show(box, false); return; }
  show(box, true);
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
function gradeTick(db) {
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

async function trialGain() {
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

function driftKey() { return `${state.settings.deviceId || 'auto'}|${state.settings.outputDeviceId || 'auto'}`; }

/** 重ね録りのときに再生側で相殺する ppm。いま測れていればそれ、無ければこの機器の組で前に測った値。 */
function driftForOverdub() {
  if (!state.settings.driftCompensate) return 0;
  const dr = engine.drift();
  if (dr.ready && dr.relativePpm != null && dr.seconds >= 30) return dr.relativePpm;
  const mem = state.settings.driftMemory || {};
  return mem[driftKey()] || 0;
}

/** 測れたずれを、機器の組ごとに覚えておく（次に開いてすぐ重ね録りしても使えるように）。 */
async function rememberDrift() {
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
function guardRecording() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      document.title = 'Tonmeister — 録音';
      if (engine.isRecording) {
        await acquireWakeLock();
        showNotice(`裏に回っていた間も録れています（落ちた音 ${engine.gapCount} 回）。`, engine.gapCount > 0);
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
    if (m.gapCount === 1 || m.gapCount % 10 === 0) showNotice(`入力の音が ${m.gapCount} 回落ちています（合計 ${(m.lostFrames / engine.recordRate * 1000).toFixed(0)} ms）。PC が重いか、機器のバッファが小さすぎます。`, true);
  };
  engine.onRollover = (n) => showNotice(`長くなったので次の受け皿に切り替えました（${n + 1} 本目）。音は1つも落としていません。止めると続きのトラックとして並びます。`, false);
}

async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    if (state.wakeLock && !state.wakeLock.released) return;
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch { state.wakeLock = null; }
}

function releaseWakeLock() {
  if (state.wakeLock) { try { state.wakeLock.release(); } catch { } state.wakeLock = null; }
}

/** 開いたとき（と機器を変えたとき）に一度だけ、ズレ合わせを自動で測る。 */
async function autoMeasureLatency() {
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
      showNotice(`ズレ合わせを自動で測りました：往復 ${(result.frames / engine.recordRate * 1000).toFixed(0)} ms。`, false);
    } else {
      showNotice('ズレ合わせを自動で測れませんでした（テスト音がマイクに届いていません）。重ねて録るときは「ズレ合わせ」を押して測ってください。', false);
    }
  } catch { }
  updateAlignPill();
}

/* ================= フォルダ直書き ================= */

/** 前に選んだフォルダを取り出し、許可が残っていれば鏡を用意する。途中のファイルがあれば繋ぐ。 */
async function setupMirror() {
  const s = state.settings;
  if (!s.mirrorEnabled || !window.showDirectoryPicker) { engine.mirror = null; return; }
  const dir = await store.getHandle('mirrorDir');
  if (!dir) { engine.mirror = null; return; }
  state.mirrorDir = dir;
  let perm = 'prompt';
  try { perm = await dir.queryPermission({ mode: 'readwrite' }); } catch { }
  if (perm !== 'granted') {
    // 許可の取り直しにはクリックが要る
    showNotice(`「${dir.name}」への書き込み許可が切れています。`, true, '許可する', async () => {
      try { if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') await setupMirror(); } catch { }
    });
    engine.mirror = null;
    return;
  }
  engine.mirror = new DiskMirror(dir, state.session.name);
  try {
    const joined = await DiskMirror.joinOrphans(dir);
    for (const j of joined) {
      const ok = await ask('フォルダに途中のファイルがありました',
        `「${j.folder}」に、まとめる前に途切れた録音（${j.seconds.toFixed(1)} 秒）がありました。\n1本に繋いで「${j.name}」にしました。\n\nいまのセッションにも足しますか？`, '足す', '足さない');
      if (ok) {
        state.recPeak = Edit.truePeakInfo(j).truePeak; state.recFlats = 0;
        await addRecordedTake({ samples: j.samples, frames: j.frames, channels: j.channels, sampleRate: j.sampleRate, seconds: j.seconds }, null, '（フォルダから復元）');
      }
    }
  } catch { }
}

async function chooseMirrorFolder() {
  if (!window.showDirectoryPicker) { showError('このブラウザではフォルダを選べません（Chrome / Edge で使えます）。'); return; }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tonmeister-mirror' });
    await store.setHandle('mirrorDir', dir);
    state.settings.mirrorEnabled = true;
    await store.setSettings(state.settings);
    await setupMirror();
    updateSettingsDialog();
  } catch (e) { if (e && e.name !== 'AbortError') showError('フォルダを選べませんでした: ' + e.message); }
}

async function clearMirrorFolder() {
  await store.setHandle('mirrorDir', null);
  state.settings.mirrorEnabled = false;
  state.mirrorDir = null;
  engine.mirror = null;
  await store.setSettings(state.settings);
  updateSettingsDialog();
}

function updateSettingsDialog() {
  const s = state.settings;
  const st = engine.status();

  // ブラウザの加工
  const procHost = $('#proc-chips');
  procHost.innerHTML = '';
  const procs = [
    ['echoCancellation', 'エコー消し', 'echoCancellation'],
    ['noiseSuppression', 'ノイズ抑制', 'noiseSuppression'],
    ['autoGainControl', '自動で音量調整', 'autoGainControl'],
  ];
  for (const [key, label, raw] of procs) {
    const on = !!s.processing[key];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (on ? '' : ' on');   // 「切」が正しい側なので、切のときに金
    chip.innerHTML = `<b>${label}：${on ? '入' : '切'}</b><small>${raw}</small>`;
    chip.onclick = async () => {
      s.processing[key] = !s.processing[key];
      await store.setSettings(s);
      await reopenInput();
      updateSettingsDialog();
    };
    procHost.appendChild(chip);
  }
  setText($('#txt-proc-actual'), st
    ? (st.unknown
      ? '実際にどうなったかをブラウザが答えません（Firefox など）。「音のチェック」の検査で確かめてください。'
      : `実際: エコー消し ${st.processing.echoCancellation ? '入' : '切'}／ノイズ抑制 ${st.processing.noiseSuppression ? '入' : '切'}／自動音量 ${st.processing.autoGainControl ? '入' : '切'}` +
        (st.processing.voiceIsolation === undefined ? '' : `／声だけ抽出 ${st.processing.voiceIsolation ? '入' : '切'}`))
    : 'まだ音の入り口を開いていません。');

  // 音の通り道
  const canRaw = Engine.canRawCapture;
  setSwitch($('#tgl-raw'), canRaw && s.rawCapture !== false);
  $('#tgl-raw').disabled = !canRaw;
  setText($('#txt-raw-note'), !canRaw
    ? 'このブラウザには MediaStreamTrackProcessor が無いので、AudioContext 経由で受けます（Chrome / Edge なら生フレーム取得が使えます）。'
    : st
      ? (st.rawPath
        ? `いま生フレーム取得で受けています。届いているのは ${st.captureRate} Hz / ${st.channels}ch。録音はこのレートのまま、再標本化は入りません。`
        : '生フレーム取得は切っています（または開けなかったので AudioContext 経由に戻りました）。')
      : '開くと、ここに実際の通り道が出ます。');

  // チャンネル数
  const chHost = $('#channel-chips');
  chHost.innerHTML = '';
  for (const [n, label, sub] of [[0, '自動', '2ch を頼む'], [1, '1', 'モノラル'], [2, '2', 'ステレオ'], [4, '4', '4ch'], [8, '8', '8ch']]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + ((s.channelCount || 0) === n ? ' on' : '');
    chip.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    chip.onclick = async () => {
      s.channelCount = n;
      await store.setSettings(s);
      await reopenInput();
      updateSettingsDialog();
    };
    chHost.appendChild(chip);
  }

  // 音の細かさ
  const fmtHost = $('#format-chips');
  fmtHost.innerHTML = '';
  for (const rate of RATES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (s.sampleRate === rate ? ' on' : '');
    chip.innerHTML = `<b>${(rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz</b><small>${rate} Hz</small>`;
    chip.disabled = state.session.tracks.length > 0;   // 途中で変えるとセッションが揃わない
    chip.onclick = async () => {
      s.sampleRate = rate;
      s.latencyMeasured = false;                       // 機材構成が変われば測り直し
      await store.setSettings(s);
      await reopenInput();
      updateSettingsDialog();
    };
    fmtHost.appendChild(chip);
  }
  setText($('#txt-format-original'), st ? `実際 ${st.rawPath ? st.captureRate : st.contextRate} Hz / ${st.channels}ch` : '');

  // 音の残し方
  const saveHost = $('#save-chips');
  saveHost.innerHTML = '';
  for (const [fmt, label, sub] of [
    [SaveFormat.Float32, '欠けない形', '32bit float WAV'],
    [SaveFormat.Pcm24, '小さめの形', '24bit PCM WAV'],
  ]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (s.saveFormat === fmt ? ' on' : '');
    chip.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    chip.onclick = async () => { s.saveFormat = fmt; await store.setSettings(s); updateSettingsDialog(); };
    saveHost.appendChild(chip);
  }

  // ズレ合わせ
  const measured = s.latencyMeasured && s.latencyFrames > 0;
  const lv = $('#txt-latency-value');
  const ms = engine.sampleRate ? s.latencyFrames / engine.sampleRate * 1000 : 0;
  setText(lv, measured ? `${ms.toFixed(0)} ms` : '未測定');
  lv.className = 'latency-value' + (measured ? ' ok' : '');
  setText($('#txt-latency-note'), measured
    ? `往復 ${s.latencyFrames} サンプル。録音の頭からこのぶんを捨てて、前の音と揃えます。機材構成を変えたら測り直してください。`
    : '測っておくと、重ねて録った音が前の音とぴったり揃います。ヘッドホンで測るときは、片方をマイクに近づけてください。');

  // 押す前の音
  const preHost = $('#preroll-chips');
  preHost.innerHTML = '';
  for (const [sec, label] of [[0, 'なし'], [3, '3 秒'], [5, '5 秒'], [10, '10 秒'], [20, '20 秒']]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + ((s.prerollSeconds || 0) === sec ? ' on' : '');
    chip.innerHTML = `<b>${label}</b>`;
    chip.onclick = async () => { s.prerollSeconds = sec; await store.setSettings(s); engine.setPreroll(sec); updateSettingsDialog(); };
    preHost.appendChild(chip);
  }

  // 録るチャンネル
  const rcHost = $('#record-channel-chips');
  rcHost.innerHTML = '';
  const nIn = st ? st.channels : 0;
  const options = [[null, 'すべて', nIn ? `${nIn}ch を1本に` : '機器の全部']];
  for (let c = 0; c + 1 < nIn; c += 2) options.push([[c, c + 1], `${c + 1}-${c + 2}`, 'この2つを1本に']);
  for (let c = 0; c < nIn && nIn > 2; c++) options.push([[c], `${c + 1}`, 'この1つだけ']);
  for (const [map, label, sub] of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const on = JSON.stringify(s.recordChannels || null) === JSON.stringify(map);
    chip.className = 'chip' + (on ? ' on' : '');
    chip.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    chip.onclick = async () => { s.recordChannels = map; await store.setSettings(s); engine.setRecordChannels(map); updateSettingsDialog(); };
    rcHost.appendChild(chip);
  }
  const modeHost = $('#record-mode-chips');
  modeHost.innerHTML = '';
  for (const [mode, label, sub] of [['mix', '1本に', 'チャンネルをまとめて1トラック'], ['split', '別トラックに', 'チャンネルごとにトラックを作る'], ['safety', '2ch を保険に', 'ch2 は ch1 を機材で −12 dB にした予備']]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + ((s.recordMode || 'mix') === mode ? ' on' : '');
    chip.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    chip.onclick = async () => { s.recordMode = mode; await store.setSettings(s); updateSettingsDialog(); };
    modeHost.appendChild(chip);
  }
  setText($('#txt-record-mode-note'), (s.recordMode === 'safety')
    ? '本線（ch1）が割れたところだけを、保険（ch2）で差し替えた録りを自動で足します。倍率は割れていない区間から実測するので、機材側で何 dB 下げたかは覚えなくて大丈夫です。元の 2ch の録りも残ります。'
    : (s.recordMode === 'split') ? '2本のマイクを別々に扱いたいとき。各トラックはセッションの同じ位置から始まります。'
    : '2本のマイクをステレオ1本として録ります。');

  // フォルダ直書き
  const mirrorOn = !!s.mirrorEnabled && !!state.mirrorDir;
  setText($('#txt-mirror-state'), !window.showDirectoryPicker
    ? 'このブラウザではフォルダを選べません（Chrome / Edge で使えます）。'
    : mirrorOn ? `「${state.mirrorDir.name}」に、録りながら 20 秒ごとの部分ファイルを書き、止めたら1本にまとめます。${engine.mirror ? '' : '（いまは許可待ち）'}`
    : '選ぶと、OPFS の受け皿に加えて自分のフォルダにも本物の WAV を書きます。ブラウザが落ちても、20 秒ごとに閉じた部分ファイルが残ります。');
  show($('#btn-mirror-clear'), mirrorOn);
  setSwitch($('#tgl-auto-latency'), s.autoLatency !== false);
  setSwitch($('#tgl-drift'), s.driftCompensate !== false);

  // マイクの較正ファイル
  setText($('#txt-miccal-state'), s.micCal
    ? `「${s.micCal.name}」（${s.micCal.points.length} 点、${s.micCal.points[0].hz.toFixed(0)}〜${s.micCal.points[s.micCal.points.length - 1].hz.toFixed(0)} Hz）。周波数分布はこの色を引いて表示します。仕上げの「マイクの色を戻す」でも使えます。`
    : '測定用マイク（UMIK-1 など）に付いてくる「周波数 dB」のテキストを読み込むと、周波数分布からマイクの色を引いて本当の分布を見られます。仕上げの「マイク補正（戻し）」にも使えます。');
  show($('#btn-miccal-clear'), !!s.micCal);

  // クロックのずれ
  const dr = engine.isOpen ? engine.drift() : { ready: false };
  setText($('#txt-drift'), !engine.isOpen ? ''
    : !dr.ready ? 'クロックのずれ：開いてから 20 秒ほど経つと出ます。'
    : dr.relativePpm == null
      ? `鳴らす側のクロックは実時間に対して ${dr.outputPpm >= 0 ? '+' : ''}${dr.outputPpm.toFixed(0)} ppm（生フレーム取得でないと送り側との差は測れません）。`
      : `クロックのずれ：送り側と鳴らす側の差 ${dr.relativePpm >= 0 ? '+' : ''}${dr.relativePpm.toFixed(0)} ppm ≒ 10 分で ${Math.abs(dr.msPer10min).toFixed(1)} ms` +
        (Math.abs(dr.msPer10min) > 5
          ? (s.driftCompensate !== false ? '。重ね録りのときは再生側でこのぶんを相殺します（録音経路には触りません）。' : '。⚠ 長い重ね録りは後半でずれます。相殺を入れるか、録る機器と鳴らす機器を同じにしてください。')
          : '。問題ありません。'));

  setSwitch($('#tgl-startup'), s.openInputOnStartup);
  store.estimate().then(e => {
    const used = e && e.usage ? `　いま ${(e.usage / 1024 / 1024).toFixed(1)} MB 使用` : '';
    const kind = engine.storageKind === 'opfs' ? 'OPFS（ファイルへ同期追記・0.5 秒ごと）' : 'IndexedDB（2 秒ごとに塊で保存）';
    setText($('#txt-folder'), `このブラウザの中：${kind}${used}\n書き出すと、選んだフォルダへ WAV が出ます。`);
  });

  // この選択が意味すること
  setText($('#txt-explain'), st
    ? ('いまは ' + st.device + ' から ' + st.contextRate + ' Hz / ' + st.channels + 'ch で受けています。\n\n' +
      (st.resampled
        ? '⚠ 機器の ' + st.streamRate + ' Hz を ' + st.contextRate + ' Hz へ変換しています。ADC の出力そのままではありません。上の「音の細かさ」を機器と同じ値にすると、変換が消えます。\n\n'
        : '機器のレートと同じなので、途中で変換は入っていません。\n\n') +
      (st.clean
        ? 'ブラウザの加工はすべて切れています。録れるのは実際に鳴っている音です。'
        : st.unknown
          ? 'ブラウザが加工の状態を答えないので、「音のチェック」で確かめてください。'
          : '⚠ ブラウザの加工が残っています。このままだと、録れるのは実際に鳴っている音ではありません。'))
    : 'まだ音の入り口を開いていません。上の一覧から機器を選ぶか、「音を聞く準備をする」を押してください。');
}

/* ================= 音のチェック ================= */

async function openDiagnostics() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  const error = await ensureOpen();
  if (error) showError(error);

  const sel = $('#cmb-diag-track');
  sel.innerHTML = '';
  for (const t of state.session.tracks) sel.add(new Option(t.name, t.id));
  $('#btn-diag-track').disabled = state.session.tracks.length === 0;
  sel.disabled = state.session.tracks.length === 0;

  $('#dlg-diag').showModal();
}

function setDiagVerdict(mark, cls, title, body) {
  const m = $('#verdict-mark');
  m.textContent = mark;
  m.className = 'verdict-mark ' + cls;
  setText($('#txt-verdict-title'), title);
  setText($('#txt-verdict-body'), body);
}

function renderStats(reports, rate, label, stereo = null) {
  const grid = $('#stats-grid');
  grid.innerHTML = '';
  const worst = reports.reduce((a, c) => (c.rmsDb > a.rmsDb ? c : a), reports[0]);
  const peak = Math.max(...reports.map(r => r.peakDb));
  const bits = Math.min(...reports.map(r => r.effectiveBits));
  const dc = Math.max(...reports.map(r => Math.abs(r.dcOffset)));
  const clips = reports.reduce((a, r) => a + r.clipCount, 0);

  const cell = (value, cls, name, note) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<b class="${cls}"></b><span></span><small></small>`;
    setText($('b', d), value); setText($('span', d), name); setText($('small', d), note);
    grid.appendChild(d);
  };

  cell(Meter.fmtDb(peak), peak >= -0.5 ? 'bad' : peak >= Meter.GoodFromDb && peak <= Meter.GoodToDb ? 'ok' : 'warn',
    'いちばん大きいところ', '目安は −18〜−8 dBFS。');
  cell(Meter.fmtDb(worst.rmsDb),
    worst.rmsDb < Analysis.IMPLAUSIBLY_QUIET_DB ? 'bad' : worst.rmsDb < -85 ? 'ok' : worst.rmsDb < -55 ? 'warn' : 'bad',
    'ノイズフロア（RMS）', '低いほど良い。−85 以下なら静か、−55 より上なら要改善。');
  cell(`${bits.toFixed(1)} bit`, bits > 20 ? 'bad' : bits < 12 ? 'warn' : 'ok',
    '実効ビット深度', 'この暗騒音の下で実際に使えているビット数。');
  cell(`${worst.humHz.toFixed(0)} Hz`, worst.humOverFloorDb > 12 ? 'warn' : 'ok',
    '電源ハム', `暗騒音より ${worst.humOverFloorDb.toFixed(0)} dB 高い。+12 dB 以上なら対策の価値あり。`);
  cell(dc.toFixed(5), dc > 0.001 ? 'warn' : 'ok', '直流オフセット', 'ヘッドルームを無駄に食う。');
  cell(String(clips), clips > 0 ? 'bad' : 'ok', 'クリップ', '1つでもあれば入力つまみを下げる。');

  const arrived = reports.map(r => r.arrivedBits).filter(b => b > 0);
  const ab = arrived.length ? Math.min(...arrived) : 0;
  cell(ab === 0 ? '—' : ab === 32 ? 'float' : `${ab} bit`, ab === 16 ? 'bad' : ab === 0 ? '' : 'ok',
    '届いているビット数', ab === 16 ? 'Windows の「既定の形式」を 24bit に。' : ab === 24 ? '24bit の刻みで届いている。' : ab === 32 ? '整数の刻みに乗っていない（途中で音量が掛かっているか float）。' : '判断できる量がない。');

  const us = reports.reduce((a, r) => Math.max(a, r.ultrasonicAvailable ? r.ultrasonicOverFloorDb : -Infinity), -Infinity);
  if (isFinite(us)) {
    cell(`${us >= 0 ? '+' : ''}${us.toFixed(0)} dB`, us > 12 ? 'warn' : 'ok', '20 kHz より上の雑音', us > 12 ? 'スイッチング電源・ディスプレイ・USB を離す。' : '床と同じ。問題なし。');
  }

  if (stereo && !stereo.silent) {
    const cm = stereo.distanceCm;
    cell(`${Math.abs(cm) < 0.5 ? '±0' : (cm > 0 ? 'R +' : 'L +') + Math.abs(cm).toFixed(1)} cm`, stereo.inverted ? 'bad' : Math.abs(cm) > 30 ? 'warn' : 'ok',
      'L/R のマイクの距離差', Analysis.describeStereo(stereo));
  }

  // 周波数の分布（較正ファイルがあれば、マイクの色を引いた本当の分布）
  show($('#card-spectrum'), true);
  const cal = state.settings.micCal;
  drawSpectrum(cal ? MicCal.correctBands(reports[0].bands, cal.points) : reports[0].bands);
  setText($('#diag-target'), `${label}　${(rate / 1000).toFixed(1)} kHz / ${reports.length}ch`);

  // これまでに測ったもの
  state.diagHistory.unshift({ at: new Date(), label, rms: worst.rmsDb, peak });
  state.diagHistory = state.diagHistory.slice(0, 6);
  const host = $('#history-list');
  host.innerHTML = '';
  for (const h of state.diagHistory) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = '<span></span><span class="mono"></span>';
    setText(row.children[0], `${String(h.at.getHours()).padStart(2, '0')}:${String(h.at.getMinutes()).padStart(2, '0')}　${h.label}`);
    setText(row.children[1], `ピーク ${Meter.fmtDb(h.peak)}／床 ${Meter.fmtDb(h.rms)}`);
    host.appendChild(row);
  }
  show($('#card-history'), state.diagHistory.length > 1);
}

function drawSpectrum(bands) {
  const cv = $('#spectrum');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  if (!bands.length) return;
  const bw = w / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const db = Math.max(-120, Math.min(0, bands[i].db));
    const y = (1 - (db + 120) / 120) * h;
    ctx.fillStyle = bands[i].centerHz >= 45 && bands[i].centerHz <= 65 ? '#B06A2C' : '#C9A227';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 1, y, Math.max(1, bw - 2), h - y);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(90,78,51,.6)';
  ctx.beginPath(); ctx.moveTo(0, h - .5); ctx.lineTo(w, h - .5); ctx.stroke();
}

function renderAdvice(notes) {
  const host = $('#pnl-diag-steps');
  host.innerHTML = '';
  for (const n of notes) {
    const p = document.createElement('p');
    p.className = 'advice';
    p.textContent = n;
    host.appendChild(p);
  }
}

async function measureSilence(playing) {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  busy(playing ? '弾きながら測っています…（5秒）' : '静かにして測っています…（5秒）');
  try {
    const cap = await engine.captureForAnalysis(5);
    const reports = Analysis.analyze(cap.samples, cap.frames, cap.channels, cap.sampleRate);
    const stereo = playing && cap.channels === 2 ? Analysis.stereoCheck(cap.samples, cap.frames, cap.sampleRate) : null;
    renderStats(reports, cap.sampleRate, playing ? '弾きながら' : '静かにして', stereo);
    const notes = Analysis.advise(reports, !playing);
    renderAdvice(notes);

    const worst = Math.max(...reports.map(r => r.rmsDb));
    const peak = Math.max(...reports.map(r => r.peakDb));
    if (worst < Analysis.IMPLAUSIBLY_QUIET_DB) {
      setDiagVerdict('!', 'bad', 'この数値は機材の性能ではありません',
        'あり得ない静けさです。静かな間だけ入力を潰す処理が働いている可能性が高いので、まず「ブラウザが加工していないか調べる」を押してください。');
    } else if (playing) {
      const inBand = peak >= Meter.GoodFromDb && peak <= Meter.GoodToDb;
      setDiagVerdict(peak >= -0.5 ? '!' : inBand ? '✓' : '△',
        peak >= -0.5 ? 'bad' : inBand ? 'ok' : 'warn',
        peak >= -0.5 ? '音が割れています' : inBand ? 'ちょうどいい音量です' : '音量が目安から外れています',
        `いちばん大きいところは ${Meter.fmtDb(peak)}。目安は −18〜−8 dBFS です。`);
    } else {
      setDiagVerdict(worst < -70 ? '✓' : '△', worst < -70 ? 'ok' : 'warn',
        worst < -70 ? '静かに録れる状態です' : '暗騒音がやや高めです',
        `ノイズフロアは ${Meter.fmtDb(worst)}。下の所見も見てください。`);
    }
  } catch (e) { showError(e.message); }
  finally { unbusy(); }
}

async function checkProcessing() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  busy('検査しています…（約7秒。静かにしていてください）');
  try {
    const r = await engine.checkInputProcessing(t => busy(t));
    const st = engine.status();
    if (r.verdict === 'gated') {
      setDiagVerdict('!', 'bad', 'ブラウザが入力を加工しています',
        `${r.detail}\n\n鳴らしている間 ${r.loudDb.toFixed(1)} dBFS ／ 静かにしたあと ${r.quietDb.toFixed(1)} dBFS。\n` +
        '録れているのは「実際に鳴っている音」ではありません。「詳しい設定 → ブラウザの加工」を全部「切」にして、開き直してください。' +
        (st && !st.clean ? '\n（いまブラウザ側は加工「入」のままです）' : ''));
    } else if (r.verdict === 'undetermined') {
      setDiagVerdict('?', 'warn', '判定できませんでした', r.detail);
    } else {
      setDiagVerdict('✓', 'ok', '素の入力が届いています',
        `${r.detail}\n\n鳴らしている間 ${r.loudDb.toFixed(1)} dBFS ／ 静かにしたあと ${r.quietDb.toFixed(1)} dBFS。`);
    }
    renderAdvice([]);
  } catch (e) { showError(e.message); }
  finally { unbusy(); }
}

/** 生フレーム取得の道と AudioContext の道を同時に録って比べる。一致すれば途中で何も掛かっていない。 */
async function verifyPath() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  busy('2つの道で同時に録って比べています…（2秒。音を出していてください）');
  try {
    const r = await engine.verifyPath(2);
    state.verify = r;
    renderAdvice([]);
    if (!r.available) { setDiagVerdict('?', 'warn', '比べる相手がありません', r.reason); return; }
    if (!r.ok) { setDiagVerdict('?', 'warn', '判定できませんでした', r.reason); return; }
    if (r.identical) {
      setDiagVerdict('✓', 'ok', '2つの道は完全に一致しました',
        `生フレーム取得と AudioContext 経由で同時に録った音は、揃えると 1 サンプルも違いません（時間差 ${r.lagMs.toFixed(2)} ms）。ブラウザは途中でゲインもリサンプルも掛けていません。`);
    } else if (Math.abs(r.gainDb) < 0.01 && r.residualDb < -90) {
      setDiagVerdict('✓', 'ok', '2つの道はほぼ一致（丸めの差だけ）',
        `音量差 ${r.gainDb.toFixed(3)} dB、残った差 ${r.residualDb.toFixed(0)} dB。実用上は同じ音です（時間差 ${r.lagMs.toFixed(2)} ms）。`);
    } else {
      setDiagVerdict('△', 'warn', '2つの道で音が違います',
        `音量差 ${isFinite(r.gainDb) ? r.gainDb.toFixed(2) : '?'} dB、音量を合わせたあとの残差 ${r.residualDb.toFixed(0)} dB（時間差 ${r.lagMs.toFixed(2)} ms）。` +
        'AudioContext 側で何かが掛かっています（レートの違いによる再標本化が多い）。録音は生フレーム取得の道なので影響しませんが、モニターと再生の音は素とは少し違います。');
    }
  } catch (e) { showError(e.message); }
  finally { unbusy(); }
}

async function analyzeTrack() {
  const id = $('#cmb-diag-track').value;
  const track = state.session.tracks.find(t => t.id === id);
  const take = track && M.activeTake(track);
  if (!take) return;
  busy('録った音を調べています…');
  try {
    const audio = await loadTake(take);
    const reports = Analysis.analyze(audio.samples, audio.frames, audio.channels, audio.sampleRate);
    const stereo = audio.channels === 2 ? Analysis.stereoCheck(audio.samples, audio.frames, audio.sampleRate) : null;
    renderStats(reports, audio.sampleRate, track.name, stereo);
    // ハムが見つかったら、そのトラックのハム除去の周波数を測った値（50 か 60）に合わせておく
    const hum = reports.slice().sort((a, b) => b.humOverFloorDb - a.humOverFloorDb)[0];
    if (hum && hum.humOverFloorDb > 12 && hum.humHz > 0) {
      const base = hum.humHz % 60 === 0 ? 60 : 50;
      if (track.processing.humFrequency !== base) {
        track.processing.humFrequency = base;
        await saveSession(state.session);
        showNotice(`「${track.name}」に ${hum.humHz.toFixed(0)} Hz のハムが見つかりました。仕上げのハム除去を ${base} Hz に合わせました（入れるかどうかはトラックの札で）。`, false);
      }
    }
    renderAdvice(Analysis.advise(reports, false));
    const peak = Math.max(...reports.map(r => r.peakDb));
    setDiagVerdict(peak >= -0.5 ? '!' : peak < -20 ? '△' : '✓',
      peak >= -0.5 ? 'bad' : peak < -20 ? 'warn' : 'ok',
      peak >= -0.5 ? 'この録りは割れています' : peak < -20 ? 'この録りは小さめです' : 'この録りの音量は妥当です',
      `いちばん大きいところは ${Meter.fmtDb(peak)}。目安は −18〜−8 dBFS です。`);
  } catch (e) { showError(e.message); }
  finally { unbusy(); }
}

/* ================= 書き出す ================= */
/*
   書き出しは必ず「素」を出す。仕上げ（盛り）が入っているときは「仕上げ」も並べて出す。
   仕上げだけ、は選べない。素が消えると戻れなくなるため。
*/

async function openExport() {
  if (state.session.tracks.length === 0) { showError('まだ書き出すものがありません。'); return; }
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから書き出してください。'); return; }

  const has = M.hasFinishing(state.session);
  state.exportFormat = state.settings.saveFormat;
  state.exportAudio = null;
  state.exportFinished = null;
  updateExportCards();
  const chkFin = $('#chk-exp-finished');
  chkFin.checked = has;
  chkFin.disabled = !has;
  setText($('#txt-exp-finished-note'), has ? '盛り（' + finishSummary() + '）を通した音' : '盛りが入っているときだけ');
  setText($('#txt-export-summary'),
    `${state.session.tracks.length} トラック／${Meter.mmss(M.sessionLength(state.session))}／${(state.session.sampleRate / 1000).toFixed(1)} kHz`);
  setText($('#txt-clip'), 'いちばん大きいところを調べています…');
  setText($('#txt-peak'), '');
  $('#peak-fill').style.width = '0px';
  $('#dlg-export').showModal();

  try {
    state.exportAudio = await Edit.mixdown(state.session, loadTake, { pure: true });
    if (has) {
      state.exportFinished = await Edit.mixdown(state.session, loadTake, { pure: false });
      // ついでに盛り度も測って控える（書き出す WAV の横に添える）
      const m = Finish.measureFinish(state.exportAudio, state.exportFinished);
      m.normalizeGainDb = state.exportFinished.normalizeGainDb == null ? 0 : state.exportFinished.normalizeGainDb;
      m.at = Date.now();
      state.session.finish.measured = m;
      await saveSession(state.session);
      updateFinishUi();
    }
    updateExportPeak();
  } catch (e) {
    setText($('#txt-clip'), 'まとめられませんでした: ' + e.message);
  }
}

function finishSummary() { return Finish.summarize(state.session).join('・'); }

/** 仕上げの WAV に添える覚え書き。何をどれだけ盛ったかを、聞く人にも分かる形で残す。 */
function finishSidecar() {
  const s = state.session;
  const f = s.finish;
  const m = f.measured;
  const lines = [
    `${s.name} — 仕上げの覚え書き`,
    `Tonmeister ${new Date().toLocaleString('ja-JP')}`,
    '',
    '素（_素.wav）には何も足していません。この仕上げは、素に次のものを通した音です。',
    '',
  ];
  if (f.rumbleCut) lines.push('・風音カット：30 Hz 以下をハイパス（Q 0.707）');
  for (const t of s.tracks) {
    const p = t.processing;
    if (p.humEnabled) lines.push(`・${t.name}：電源ハム除去 ${p.humFrequency} Hz とその倍音 ×${p.humHarmonics}（ノッチ Q 30）`);
    if (p.gateEnabled) lines.push(`・${t.name}：ノイズゲート しきい値 ${p.gateThresholdDb} dBFS`);
    if (f.reverb.enabled && p.reverbSend != null && p.reverbSend !== 1) lines.push(`・${t.name}：響きの量 ${Math.round(p.reverbSend * 100)}%`);
  }
  if (f.reverb.enabled && f.reverb.amount > 0) {
    lines.push(`・ホールの響き：${hallName(f.reverb.hall)}（鏡像法の初期反射＋3帯域の後部残響）／響きの長さ ${(+f.reverb.seconds).toFixed(1)} 秒／量 ${Math.round(f.reverb.amount * 100)}%／直接音から響きまで ${Math.round(f.reverb.preDelayMs)} ms`);
    lines.push('  直接音には触っていません。響きだけを足しています。');
  }
  if (f.normalizeEnabled) lines.push(`・音量そろえ：いちばん大きいところ（True Peak）を ${f.normalizeTargetDb} dBTP に${m && isFinite(m.normalizeGainDb) ? `（${m.normalizeGainDb >= 0 ? '+' : ''}${m.normalizeGainDb.toFixed(1)} dB）` : ''}`);
  lines.push('');
  if (m) {
    lines.push(`盛り度：${m.grade}`);
    lines.push(`  ${Finish.describeMeasure(m)}`);
    lines.push('  （音の変化＝音量を合わせたあとに残る差。−30 dB より下なら耳ではほぼ分からない）');
  }
  return lines.join('\n');
}

/** 割れるかどうかは True Peak（サンプルの間も含めた最大）で見る。 */
function updateExportPeak() {
  const which = $('#chk-exp-finished').checked && state.exportFinished ? state.exportFinished : state.exportAudio;
  if (!which) return;
  const info = Edit.truePeakInfo(which);
  const db = Meter.toDb(info.truePeak);
  const well = $('#peak-fill').parentElement;
  const w = well.clientWidth;
  $('#peak-danger').style.width = Math.max(1, w * (1 - Meter.ratio(0))) + 'px';
  $('#peak-fill').style.width = (w * Meter.ratio(db)) + 'px';
  const label = which === state.exportFinished ? '仕上げ' : '素';
  const tp = (v) => (isFinite(v) ? v.toFixed(1) : '-inf');
  setText($('#txt-peak'), `${label}のいちばん大きいところ ${tp(db)} dBTP（サンプル値 ${tp(Meter.toDb(info.samplePeak))} dBFS）` +
    (which.normalizeGainDb != null ? `　音量そろえ ${which.normalizeGainDb >= 0 ? '+' : ''}${which.normalizeGainDb.toFixed(1)} dB` : ''));

  const dot = $('#clip-dot');
  if (which.normalizeGainDb != null && info.truePeak <= 1) {
    dot.className = 'dot gold';
    setText($('#txt-clip'), `音量をそろえてあります（いちばん大きいところを ${(state.session.finish.normalizeTargetDb ?? -1).toFixed(0)} dBTP に）。割れません。`);
  } else if (info.truePeak > 1) {
    dot.className = 'dot warn';
    setText($('#txt-clip'), '合わせると 0 dBTP を超えます。「欠けない形（32bit float）」なら超えたぶんも保てますが、24bit では割れます。トラックの音量を下げるか、「音量をそろえる」を入れるのが確実です。');
  } else if (db > -1) {
    dot.className = 'dot warn';
    setText($('#txt-clip'), 'ぎりぎりです。少しだけトラックの音量を下げると安心です。');
  } else {
    dot.className = 'dot gold';
    setText($('#txt-clip'), '割れません。このまま書き出せます。');
  }
}

function updateExportCards() {
  $('#card-wav').classList.toggle('is-picked', state.exportFormat === SaveFormat.Float32);
  $('#card-24').classList.toggle('is-picked', state.exportFormat === SaveFormat.Pcm24);
  $('#card-flac').classList.toggle('is-picked', state.exportFormat === 'flac24');
  {
    const len = M.sessionLength(state.session), rate = state.session.sampleRate || 48000;
    setText($('#txt-flac-meta'), `FLAC 24bit / ${(rate / 1000).toFixed(1)}kHz / 2ch　約 ${(len * rate * 2 * 3 * 0.65 / 1024 / 1024).toFixed(1)} MB（音による）`);
  }
  const len = M.sessionLength(state.session);
  const rate = state.session.sampleRate || 48000;
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  setText($('#txt-wav-meta'), `32bit float / ${(rate / 1000).toFixed(1)}kHz / 2ch　約 ${mb(len * rate * 2 * 4)}`);
  setText($('#txt-24-meta'), `24bit PCM / ${(rate / 1000).toFixed(1)}kHz / 2ch　約 ${mb(len * rate * 2 * 3)}`);
}

async function doExport() {
  if (!state.exportAudio) { showError('まだまとめ終わっていません。'); return; }
  const name = state.session.name;
  const files = [];
  const a = state.exportAudio;
  const prov = (state.session.tracks[0] && state.session.tracks[0].takes[0] && state.session.tracks[0].takes[0].provenance) || null;
  const flac = state.exportFormat === 'flac24';
  const wavFmt = flac ? SaveFormat.Pcm24 : state.exportFormat;
  const make = (audio, desc) => flac
    ? encodeFlac(audio.samples, audio.channels, audio.sampleRate, 24)
    : encodeWav(audio.samples, audio.channels, audio.sampleRate, wavFmt, { bext: bextFor(desc, prov, audio.channels, audio.sampleRate, wavFmt) });
  const ext = flac ? 'flac' : 'wav';
  if (flac) busy('FLAC に圧縮しています…');
  try {
    files.push([`${name}_素.${ext}`, make(a, `${name} 素（加工ゼロのミックス）`)]);
    files.push([`${name}_録音証明.txt`, new Blob([provenanceText()], { type: 'text/plain;charset=utf-8' })]);
    if ($('#chk-exp-finished').checked && state.exportFinished) {
      const f = state.exportFinished;
      files.push([`${name}_仕上げ.${ext}`, make(f, `${name} 仕上げ（${Finish.summarize(state.session).join('・')}）`)]);
      files.push([`${name}_仕上げ.txt`, new Blob([finishSidecar()], { type: 'text/plain;charset=utf-8' })]);
    }
  } finally { if (flac) unbusy(); }
  for (const [fn, blob] of files) { downloadBlob(blob, fn); await delay(250); }
  $('#dlg-export').close();
  showNotice(`${files.map(f => '「' + f[0] + '」').join('と')}を書き出しました（${flac ? 'FLAC 24bit 可逆' : formatLabel(state.exportFormat)}）。`, false);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * セッションを丸ごと書き出す。
 * デスクトップ版の「フォルダごとコピーすれば持ち運べる」にあたる。
 * session.json と WAV がそのまま並ぶので、デスクトップ版でも開ける形にしてある。
 */
/** session.json の中身（書き出しと自動バックアップで同じ形）。 */
function sessionMeta() {
  const s = state.session;
  return {
    Name: s.name,
    SampleRate: s.sampleRate,
    Listen: s.listen || 'pure',
    Finish: {
      Level: s.finish.level, Mode: s.finish.mode, RumbleCut: !!s.finish.rumbleCut,
      NormalizeEnabled: !!s.finish.normalizeEnabled, NormalizeTargetDb: s.finish.normalizeTargetDb,
      Reverb: { Enabled: !!s.finish.reverb.enabled, Kind: s.finish.reverb.hall, DecaySeconds: s.finish.reverb.seconds,
                MixPercent: Math.round(s.finish.reverb.amount * 100), PreDelayMs: s.finish.reverb.preDelayMs },
      Measured: s.finish.measured || null,
    },
    Tracks: s.tracks.map((t, ti) => ({
      Name: t.name, Volume: t.volume, Muted: t.muted, Soloed: t.soloed,
      StartSeconds: t.startSeconds || 0,
      ActiveTakeIndex: t.activeTakeIndex,
      Processing: {
        HumEnabled: t.processing.humEnabled, HumFrequency: t.processing.humFrequency,
        HumHarmonics: t.processing.humHarmonics, GateEnabled: t.processing.gateEnabled,
        GateThresholdDb: t.processing.gateThresholdDb, ReverbSend: t.processing.reverbSend,
      },
      Takes: t.takes.map((tk, ki) => ({
        Name: tk.name,
        Files: [`track${String(ti + 1).padStart(2, '0')}_take${String(ki + 1).padStart(2, '0')}.wav`],
        Seconds: tk.seconds, SampleRate: tk.sampleRate, Channels: tk.channels,
        RecordedAt: new Date(tk.recordedAt).toISOString(),
        Gaps: tk.gaps || [],
        Clicks: tk.clicks || [],
        Markers: tk.markers || [],
        Provenance: tk.provenance || null,
      })),
    })),
  };
}

async function exportSessionFolder() {
  show($('#list-popup'), false);
  const s = state.session;
  if (!s.tracks.length) { showError('まだ書き出すものがありません。'); return; }
  const meta = sessionMeta();

  const files = [['session.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' })],
    ['録音証明.txt', new Blob([provenanceText()], { type: 'text/plain;charset=utf-8' })]];
  for (let ti = 0; ti < s.tracks.length; ti++) {
    const t = s.tracks[ti];
    for (let ki = 0; ki < t.takes.length; ki++) {
      const tk = t.takes[ki];
      // 置き場所の WAV は bext を持たないので、ここで付け直す（TimeReference に開始位置：DAW で正しい位置に並ぶ）
      let blob = null;
      try {
        const audio = await loadTake(tk);
        blob = encodeWav(audio.samples, audio.channels, audio.sampleRate, state.settings.saveFormat,
          { bext: bextFor(`${s.name} / ${t.name} / ${tk.name}`, tk.provenance, audio.channels, audio.sampleRate, state.settings.saveFormat, t.startSeconds || 0) });
      } catch { blob = await store.getAudio(tk.audioId); }
      if (blob) files.push([`track${String(ti + 1).padStart(2, '0')}_take${String(ki + 1).padStart(2, '0')}.wav`, blob]);
    }
  }

  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const sub = await dir.getDirectoryHandle(s.name.replace(/[\\/:*?"<>|]/g, '_'), { create: true });
      busy('フォルダへ書き出しています…');
      for (const [name, blob] of files) {
        const fh = await sub.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      }
      unbusy();
      showNotice(`「${s.name}」フォルダに ${files.length} 個のファイルを書き出しました。`, false);
      return;
    } catch (e) {
      unbusy();
      if (e && e.name === 'AbortError') return;
    }
  }

  for (const [name, blob] of files) { downloadBlob(blob, name); await delay(250); }
  showNotice(`${files.length} 個のファイルをダウンロードしました（session.json ＋ WAV）。`, false);
}

/* ================= 波形を見て直す ================= */

async function openEditor() {
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

function editorRange() {
  const e = state.editor;
  const total = e.audio.seconds;
  const span = total / e.zoomX;
  const from = Math.max(0, Math.min(total - span, e.scroll * (total - span)));
  return [from, from + span, total];
}

/** 縦倍率「自動」。暗騒音しかない録音でも波形が見えるようにする。 */
function autoGainY() {
  const e = state.editor;
  if (!e.wave || !e.wave.bucketCount) return 1;
  let peak = 0;
  for (let i = 0; i < e.wave.bucketCount; i++) {
    peak = Math.max(peak, Math.abs(e.wave.min[i]), Math.abs(e.wave.max[i]));
  }
  const scaled = Wave.toScale(peak);
  return scaled > 0.001 ? Math.min(8, 0.92 / scaled) : 1;
}

function drawEditor() {
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

function wireEditor() {
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

function stopEditorPlayback() {
  const e = state.editor;
  if (e && e.source) { try { e.source.stop(); } catch { } try { e.source.disconnect(); } catch { } e.source = null; }
}

/* ================= 録音一覧 ================= */

async function openSessions() {
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

async function importSessionFolder() {
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
async function importWavFiles(files) {
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

async function newSession() {
  show($('#list-popup'), false);
  await stopAll();
  await saveSession(state.session);
  await setSession(M.newSession());
  await saveSession(state.session);
  setMode('record');
  showNotice(T('新しく始めました。'), false);
}

/* ================= トラックを外す ================= */

async function removeTrack() {
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

async function undoRemove(sampleRate) {
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

/* ================= 配線 ================= */

function wireEvents() {
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

  $('#btn-check').onclick = openDiagnostics;
  $('#btn-check2').onclick = openDiagnostics;
  $('#btn-export').onclick = openExport;
  $('#btn-export-2').onclick = openExport;
  $('#btn-settings').onclick = openSettings;
  $('#btn-lang').onclick = toggleLang;
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

function onKeyDown(e) {
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

/* ================= スイープで測る ================= */

function openMeasure() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  updateMeasureUi();
  $('#dlg-measure').showModal();
}

function updateMeasureUi() {
  const loop = state.measureMode === 'loopback';
  $$('#measure-mode-chips .chip').forEach(c => c.classList.toggle('on', c.dataset.mode === state.measureMode));
  setText($('#txt-measure-howto'), loop
    ? 'インターフェースの出力（ヘッドホン端子か LINE OUT）から入力（LINE IN）へケーブルで繋いでください。出力の音量は真ん中くらい。マイクは外れていて構いません。往復の周波数特性と THD+N（歪みと雑音）を測り、Windows の隠れた EQ もここで露見します。'
    : 'スピーカー（PC のでも可）を楽器の位置に置き、マイクはいつも録る位置に。5 秒のスイープが鳴ります。帯域ごとの響きの長さ、近い面からの初期反射（何 cm 先か）、フラッターエコーを出します。');
  show($('#btn-measure-tone'), loop);
}

async function measureSweep() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  if (state.measureBusy) return;
  state.measureBusy = true;
  const loop = state.measureMode === 'loopback';
  busy(loop ? 'スイープを鳴らして録っています…（5秒）' : 'スイープを鳴らしています…静かにしていてください（5秒）');
  try {
    const rate = engine.sampleRate;
    const sw = Sweep.makeSweep(rate, 5, 20, null, loop ? 0.5 : 0.7);
    const cap = await engine.playAndCapture(sw.sweep, { extraSeconds: loop ? 1.0 : 2.0 });
    const mono = new Float32Array(cap.frames);
    for (let i = 0; i < cap.frames; i++) { let v = 0; for (let c = 0; c < cap.channels; c++) v += cap.samples[i * cap.channels + c]; mono[i] = v / cap.channels; }
    let peak = 0;
    for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
    if (peak < 0.001) { setMeasureResult('スイープが届いていません', ['入力にほとんど音が入っていません（' + Meter.fmtDb(Meter.toDb(peak)) + '）。ケーブルの接続、出力の音量、入力の選択を確かめてください。']); return; }
    const dec = Sweep.deconvolve(mono, sw, { tailSeconds: loop ? 0.5 : 2.0 });
    const notes = [];
    if (loop) {
      const resp = Sweep.normalizeResponse(Sweep.frequencyResponse(dec.ir, rate, { fromIndex: 0, windowMs: 100 }), Sweep.referenceResponse(sw, { windowMs: 100 }));
      state.lastResponse = resp;
      notes.push(...Sweep.adviseLoopback(resp, state.lastTone));
      notes.push(`往復の遅れ ${(dec.peakAtRecorded / rate * 1000).toFixed(1)} ms（出力バッファ＋入力バッファ）。`);
      setMeasureResult('ループバック：インターフェース＋Windows の往復', notes);
      drawResponse(resp);
      show($('#card-rt60'), false);
    } else {
      const room = Sweep.analyzeRoom(dec.ir, rate, dec.peakIndex);
      state.lastRoom = room;
      const resp = Sweep.normalizeResponse(Sweep.frequencyResponse(dec.ir, rate, { fromIndex: Math.max(0, dec.peakIndex - Math.round(rate * 0.002)), windowMs: 8 }), Sweep.referenceResponse(sw, { windowMs: 8 }));
      notes.push(...Sweep.adviseRoom(room));
      notes.push('周波数特性は直接音（最初の 8 ms）だけのもの。スピーカーの色も含むので、形ではなく凸凹の大きさを見てください。');
      setMeasureResult('部屋とマイク位置', notes);
      drawResponse(resp);
      renderRoom(room, dec);
    }
  } catch (e) { showError('測れませんでした: ' + e.message); }
  finally { unbusy(); state.measureBusy = false; }
}

async function measureTone() {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  if (state.measureBusy) return;
  state.measureBusy = true;
  busy('1 kHz を鳴らして測っています…（3秒）');
  try {
    const rate = engine.sampleRate;
    const n = rate * 3;
    const tone = new Float32Array(n);
    const amp = 0.5;   // −6 dBFS
    for (let i = 0; i < n; i++) tone[i] = amp * Math.sin(2 * Math.PI * 1000 * i / rate) * (i < 2400 ? i / 2400 : i > n - 2400 ? (n - i) / 2400 : 1);
    const cap = await engine.playAndCapture(tone, { extraSeconds: 0.5 });
    const mono = new Float32Array(cap.frames);
    for (let i = 0; i < cap.frames; i++) { let v = 0; for (let c = 0; c < cap.channels; c++) v += cap.samples[i * cap.channels + c]; mono[i] = v / cap.channels; }
    // 鳴っている真ん中の 2 秒だけ
    let peak = 0, peakAt = 0;
    for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > peak) { peak = Math.abs(mono[i]); peakAt = i; }
    if (peak < 0.001) { setMeasureResult('テスト音が届いていません', ['入力に音が入っていません。ケーブルと入力の選択を確かめてください。']); return; }
    const start = Math.max(0, Math.min(mono.length - Math.round(rate * 2.2), Math.round(rate * 0.6)));
    const seg = mono.subarray(start, start + Math.round(rate * 2.2));
    const t = Sweep.analyzeTone(seg, rate, 1000, { skipSeconds: 0.1 });
    if (!t) { setMeasureResult('短すぎました', ['もう一度試してください。']); return; }
    state.lastTone = t;
    const notes = Sweep.adviseLoopback(state.lastResponse || [], t);
    notes.push(`届いたレベル ${Meter.fmtDb(Meter.toDb(peak))}（出した音は −6 dBFS）。倍音：${t.harmonics.slice(0, 4).map(h => `${h.n}次 ${h.db.toFixed(0)} dB`).join('／')}。`);
    setMeasureResult('1 kHz：歪みと雑音', notes);
  } catch (e) { showError('測れませんでした: ' + e.message); }
  finally { unbusy(); state.measureBusy = false; }
}

function setMeasureResult(title, notes) {
  show($('#card-measure'), true);
  setText($('#txt-measure-title'), title);
  const host = $('#pnl-measure-notes');
  host.innerHTML = '';
  for (const n of notes) { const p = document.createElement('p'); p.className = 'advice'; p.textContent = n; host.appendChild(p); }
}

function drawResponse(resp) {
  show($('#card-response'), true);
  const cv = $('#response-canvas');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  if (!resp || !resp.length) return;
  const x = (hz) => (Math.log10(hz) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * w;
  const y = (db) => h / 2 - Math.max(-12, Math.min(12, db)) / 12 * (h / 2 - 4);
  ctx.strokeStyle = 'rgba(90,78,51,.6)';
  for (const d of [-6, 0, 6]) { ctx.beginPath(); ctx.moveTo(0, y(d) + .5); ctx.lineTo(w, y(d) + .5); ctx.stroke(); }
  for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(x(f) + .5, 0); ctx.lineTo(x(f) + .5, h); ctx.stroke(); }
  ctx.strokeStyle = '#C9A227'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (const o of resp) { if (o.db < -100) continue; const px = x(o.hz), py = y(o.db); if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py); }
  ctx.stroke();
  ctx.fillStyle = '#9E937A'; ctx.font = '10px Consolas, monospace';
  ctx.fillText('+6', 2, y(6) - 2); ctx.fillText('0', 2, y(0) - 2); ctx.fillText('-6', 2, y(-6) - 2);
}

function renderRoom(room, dec) {
  show($('#card-rt60'), true);
  const grid = $('#stats-rt60');
  grid.innerHTML = '';
  for (const b of room.rt60) {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<b class="${b.seconds > 1.2 ? 'warn' : 'ok'}"></b><span></span><small></small>`;
    setText($('b', d), b.seconds > 0 ? `${b.seconds.toFixed(2)} 秒` : '—'); setText($('span', d), `${b.hz >= 1000 ? (b.hz / 1000) + ' kHz' : b.hz + ' Hz'}`); setText($('small', d), 'RT60');
    grid.appendChild(d);
  }
  // IR の最初の 50 ms（dB）
  const cv = $('#ir-canvas');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  const rate = dec.rate, from = dec.peakIndex, n = Math.min(dec.ir.length - from, Math.round(rate * 0.05));
  const peak = Math.abs(dec.ir[from]) || 1e-9;
  ctx.strokeStyle = '#C9A227'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const i0 = from + Math.floor(px / w * n), i1 = from + Math.floor((px + 1) / w * n);
    let m = 0;
    for (let i = i0; i < Math.max(i0 + 1, i1); i++) m = Math.max(m, Math.abs(dec.ir[i] || 0));
    const db = Math.max(-60, 20 * Math.log10(m / peak));
    const y = (-db / 60) * h;
    ctx.moveTo(px + .5, h); ctx.lineTo(px + .5, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#A03A2E';
  for (const r of room.reflections) { const px = r.ms / 50 * w; ctx.fillRect(px - 1, 0, 2, 6); }
}

/* ================= マイク位置を録り比べる ================= */

function openCompare() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  renderCompare();
  $('#dlg-compare').showModal();
}

async function compareRecord(slot) {
  const error = await ensureOpen();
  if (error) { showError(error); return; }
  if (state.measureBusy) return;
  state.measureBusy = true;
  busy(`${'ABC'[slot]} を録っています…（5秒）同じフレーズを同じ強さで`);
  try {
    const cap = await engine.captureForAnalysis(5);
    const reports = Analysis.analyze(cap.samples, cap.frames, cap.channels, cap.sampleRate);
    const cal = state.settings.micCal;
    const bands = cal ? MicCal.correctBands(reports[0].bands, cal.points) : reports[0].bands;
    const bandDb = (lo, hi) => { const xs = bands.filter(b => b.centerHz >= lo && b.centerHz <= hi && b.db > -150); if (!xs.length) return -Infinity; return 10 * Math.log10(xs.reduce((a, b) => a + Math.pow(10, b.db / 10), 0)); };
    const stereo = cap.channels === 2 ? Analysis.stereoCheck(cap.samples, cap.frames, cap.sampleRate) : null;
    state.compare[slot] = {
      at: Date.now(), bands,
      peakDb: Math.max(...reports.map(r => r.peakDb)),
      rmsDb: Math.max(...reports.map(r => r.rmsDb)),
      low: bandDb(40, 200), mid: bandDb(500, 2000), high: bandDb(4000, 12000),
      hum: Math.max(...reports.map(r => r.humOverFloorDb)),
      stereo,
    };
    renderCompare();
  } catch (e) { showError('録れませんでした: ' + e.message); }
  finally { unbusy(); state.measureBusy = false; }
}

function renderCompare() {
  const slots = state.compare;
  const any = slots.some(Boolean);
  show($('#card-compare'), any);
  if (!any) return;
  const tbl = $('#tbl-compare');
  const names = ['A', 'B', 'C'];
  const rows = [
    ['いちばん大きいところ', (c) => c.peakDb, (v) => Meter.fmtDb(v), null],
    ['平均の大きさ（RMS）', (c) => c.rmsDb, (v) => Meter.fmtDb(v), null],
    ['低域の膨らみ（40〜200 Hz − 500〜2k）', (c) => c.low - c.mid, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`, 'near0'],
    ['明るさ（4〜12 kHz − 500〜2k）', (c) => c.high - c.mid, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`, null],
    ['電源ハム（床より）', (c) => c.hum, (v) => `+${v.toFixed(0)} dB`, 'min'],
    ['L/R の距離差', (c) => c.stereo && !c.stereo.silent ? Math.abs(c.stereo.distanceCm) : null, (v) => v == null ? '—' : `${v.toFixed(1)} cm`, 'min'],
  ];
  let html = '<thead><tr><th></th>' + names.map((n, i) => `<th class="cmp-${n.toLowerCase()}">${n}${slots[i] ? '' : '（未）'}</th>`).join('') + '</tr></thead><tbody>';
  for (const [label, get, fmt, best] of rows) {
    const vals = slots.map(c => c ? get(c) : null);
    let bestIdx = -1;
    if (best) {
      const cands = vals.map((v, i) => [v, i]).filter(([v]) => v != null && isFinite(v));
      if (cands.length > 1) {
        cands.sort((a, b) => best === 'min' ? a[0] - b[0] : Math.abs(a[0]) - Math.abs(b[0]));
        bestIdx = cands[0][1];
      }
    }
    html += `<tr><td>${label}</td>` + vals.map((v, i) => `<td class="${i === bestIdx ? 'best' : ''}">${v == null ? '—' : fmt(v)}</td>`).join('') + '</tr>';
  }
  html += '</tbody>';
  tbl.innerHTML = html;

  // 分布を重ねる
  const cv = $('#compare-canvas');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  const colors = ['#C9A227', '#4E7CB5', '#B06A2C'];
  slots.forEach((c, si) => {
    if (!c) return;
    ctx.strokeStyle = colors[si]; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    const bw = w / c.bands.length;
    c.bands.forEach((b, i) => {
      const db = Math.max(-120, Math.min(0, b.db));
      const y = (1 - (db + 120) / 120) * h;
      if (i === 0) ctx.moveTo(i * bw + bw / 2, y); else ctx.lineTo(i * bw + bw / 2, y);
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  setText($('#txt-compare-note'), '低域の膨らみは 0 に近いほど自然（近接効果が出ていない）。ハムと距離差は小さいほど良い。明るさは好み。金の文字がその行の良い方です。' + (state.settings.micCal ? '（較正ファイルでマイクの色を引いた値）' : ''));
}

/* ================= 出発 ================= */

// 開発時の覗き穴（コンソールから状態を見るため。画面には出ない）
window.__tonmeister = { engine, state };


init().catch(err => {
  console.error(err);
  showError('開けませんでした: ' + err.message);
});
