/*
  Tonmeister — 音のチェック・スイープで測る・マイク位置の録り比べ。
  app.js から動きを変えずに分けたもの。共有の状態は context.js。
*/

import { P, alpha } from '../palette.js';
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
import { $, $$, busy, engine, loadTake, saveSession, setText, show, showError, showNotice, state, unbusy } from './context.js';
import { ensureOpen } from './record.js';
import { history } from './sessions.js';

/* ================= 音のチェック ================= */

export async function openDiagnostics() {
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

export function setDiagVerdict(mark, cls, title, body) {
  const m = $('#verdict-mark');
  m.textContent = mark;
  m.className = 'verdict-mark ' + cls;
  setText($('#txt-verdict-title'), title);
  setText($('#txt-verdict-body'), body);
}

export function renderStats(reports, rate, label, stereo = null) {
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

export function drawSpectrum(bands) {
  const cv = $('#spectrum');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  if (!bands.length) return;
  const bw = w / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const db = Math.max(-120, Math.min(0, bands[i].db));
    const y = (1 - (db + 120) / 120) * h;
    ctx.fillStyle = bands[i].centerHz >= 45 && bands[i].centerHz <= 65 ? P.copper() : P.good();
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 1, y, Math.max(1, bw - 2), h - y);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = alpha(P.waveLine(), .6);
  ctx.beginPath(); ctx.moveTo(0, h - .5); ctx.lineTo(w, h - .5); ctx.stroke();
}

export function renderAdvice(notes) {
  const host = $('#pnl-diag-steps');
  host.innerHTML = '';
  for (const n of notes) {
    const p = document.createElement('p');
    p.className = 'advice';
    p.textContent = n;
    host.appendChild(p);
  }
}

export async function measureSilence(playing) {
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

export async function checkProcessing() {
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
export async function verifyPath() {
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

export async function analyzeTrack() {
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


/* ================= スイープで測る ================= */

export function openMeasure() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  updateMeasureUi();
  $('#dlg-measure').showModal();
}

export function updateMeasureUi() {
  const loop = state.measureMode === 'loopback';
  $$('#measure-mode-chips .chip').forEach(c => c.classList.toggle('on', c.dataset.mode === state.measureMode));
  setText($('#txt-measure-howto'), loop
    ? 'インターフェースの出力（ヘッドホン端子か LINE OUT）から入力（LINE IN）へケーブルで繋いでください。出力の音量は真ん中くらい。マイクは外れていて構いません。往復の周波数特性と THD+N（歪みと雑音）を測り、Windows の隠れた EQ もここで露見します。'
    : 'スピーカー（PC のでも可）を楽器の位置に置き、マイクはいつも録る位置に。5 秒のスイープが鳴ります。帯域ごとの響きの長さ、近い面からの初期反射（何 cm 先か）、フラッターエコーを出します。');
  show($('#btn-measure-tone'), loop);
}

export async function measureSweep() {
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

export async function measureTone() {
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

export function setMeasureResult(title, notes) {
  show($('#card-measure'), true);
  setText($('#txt-measure-title'), title);
  const host = $('#pnl-measure-notes');
  host.innerHTML = '';
  for (const n of notes) { const p = document.createElement('p'); p.className = 'advice'; p.textContent = n; host.appendChild(p); }
}

export function drawResponse(resp) {
  show($('#card-response'), true);
  const cv = $('#response-canvas');
  const { ctx, w, h } = Wave.fitCanvas(cv);
  if (!resp || !resp.length) return;
  const x = (hz) => (Math.log10(hz) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * w;
  const y = (db) => h / 2 - Math.max(-12, Math.min(12, db)) / 12 * (h / 2 - 4);
  ctx.strokeStyle = alpha(P.waveLine(), .6);
  for (const d of [-6, 0, 6]) { ctx.beginPath(); ctx.moveTo(0, y(d) + .5); ctx.lineTo(w, y(d) + .5); ctx.stroke(); }
  for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(x(f) + .5, 0); ctx.lineTo(x(f) + .5, h); ctx.stroke(); }
  ctx.strokeStyle = P.good(); ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (const o of resp) { if (o.db < -100) continue; const px = x(o.hz), py = y(o.db); if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py); }
  ctx.stroke();
  ctx.fillStyle = P.faint(); ctx.font = '10px Consolas, monospace';
  ctx.fillText('+6', 2, y(6) - 2); ctx.fillText('0', 2, y(0) - 2); ctx.fillText('-6', 2, y(-6) - 2);
}

export function renderRoom(room, dec) {
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
  ctx.strokeStyle = P.good(); ctx.lineWidth = 1;
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
  ctx.fillStyle = P.rec();
  for (const r of room.reflections) { const px = r.ms / 50 * w; ctx.fillRect(px - 1, 0, 2, 6); }
}


/* ================= マイク位置を録り比べる ================= */

export function openCompare() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  renderCompare();
  $('#dlg-compare').showModal();
}

export async function compareRecord(slot) {
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

export function renderCompare() {
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
  const colors = [P.good(), P.blue(), P.copper()];
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

