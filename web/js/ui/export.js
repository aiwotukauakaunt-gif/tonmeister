/*
  Tonmeister — 書き出し（素／仕上げ・BWF・FLAC・録音証明・セッション丸ごと）。
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
import { $, busy, engine, loadTake, saveSession, setText, show, showError, showNotice, state, unbusy } from './context.js';
import { updateFinishUi } from './overdub.js';
import { bextFor, provenanceText } from './record.js';

/* ================= 書き出す ================= */
/*
   書き出しは必ず「素」を出す。仕上げ（盛り）が入っているときは「仕上げ」も並べて出す。
   仕上げだけ、は選べない。素が消えると戻れなくなるため。
*/

export async function openExport() {
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

export function finishSummary() { return Finish.summarize(state.session).join('・'); }

/** 仕上げの WAV に添える覚え書き。何をどれだけ盛ったかを、聞く人にも分かる形で残す。 */
export function finishSidecar() {
  const s = state.session;
  const f = s.finish;
  const m = f.measured;
  const en = currentLang() === 'en';
  const lines = [
    `${s.name} — ${T('仕上げの覚え書き')}`,
    `Tonmeister ${new Date().toLocaleString(en ? 'en-US' : 'ja-JP')}`,
    '',
    T('素（_素.wav）には何も足していません。この仕上げは、素に次のものを通した音です。'),
    '',
  ];
  if (f.rumbleCut) lines.push(T('・風音カット：30 Hz 以下をハイパス（Q 0.707）'));
  for (const t of s.tracks) {
    const p = t.processing;
    if (p.humEnabled) lines.push(`・${t.name}：` + T('電源ハム除去 {hz} Hz とその倍音 ×{n}（ノッチ Q 30）', { hz: p.humFrequency, n: p.humHarmonics }));
    if (p.gateEnabled) lines.push(`・${t.name}：` + T('ノイズゲート しきい値 {db} dBFS', { db: p.gateThresholdDb }));
    if (f.reverb.enabled && p.reverbSend != null && p.reverbSend !== 1) lines.push(`・${t.name}：` + T('響きの量 {pct}%', { pct: Math.round(p.reverbSend * 100) }));
  }
  if (f.reverb.enabled && f.reverb.amount > 0) {
    lines.push(T('・ホールの響き：{hall}（鏡像法の初期反射＋3帯域の後部残響）／響きの長さ {sec} 秒／量 {pct}%／直接音から響きまで {ms} ms',
      { hall: T(hallName(f.reverb.hall)), sec: (+f.reverb.seconds).toFixed(1), pct: Math.round(f.reverb.amount * 100), ms: Math.round(f.reverb.preDelayMs) }));
    lines.push('  ' + T('直接音には触っていません。響きだけを足しています。'));
  }
  if (f.normalizeEnabled) lines.push(T('・音量そろえ：いちばん大きいところ（True Peak）を {db} dBTP に', { db: f.normalizeTargetDb }) + (m && isFinite(m.normalizeGainDb) ? `（${m.normalizeGainDb >= 0 ? '+' : ''}${m.normalizeGainDb.toFixed(1)} dB）` : ''));
  lines.push('');
  if (m) {
    lines.push(T('盛り度：') + T(m.grade));
    lines.push(`  ${Finish.describeMeasure(m)}`);
    lines.push('  ' + T('（音の変化＝音量を合わせたあとに残る差。−30 dB より下なら耳ではほぼ分からない）'));
  }
  return lines.join('\n');
}

/** 割れるかどうかは True Peak（サンプルの間も含めた最大）で見る。 */
export function updateExportPeak() {
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

export function updateExportCards() {
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

export async function doExport() {
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
    files.push([`${name}${T('_素')}.${ext}`, make(a, `${name} ${T('素（加工ゼロのミックス）')}`)]);
    files.push([`${name}${T('_録音証明')}.txt`, new Blob([provenanceText()], { type: 'text/plain;charset=utf-8' })]);
    if ($('#chk-exp-finished').checked && state.exportFinished) {
      const f = state.exportFinished;
      files.push([`${name}${T('_仕上げ')}.${ext}`, make(f, `${name} ${T('仕上げ')}（${Finish.summarize(state.session).join('・')}）`)]);
      files.push([`${name}${T('_仕上げ')}.txt`, new Blob([finishSidecar()], { type: 'text/plain;charset=utf-8' })]);
    }
  } finally { if (flac) unbusy(); }
  for (const [fn, blob] of files) { downloadBlob(blob, fn); await delay(250); }
  $('#dlg-export').close();
  showNotice(`${files.map(f => '「' + f[0] + '」').join('と')}を書き出しました（${flac ? 'FLAC 24bit 可逆' : formatLabel(state.exportFormat)}）。`, false);
}

export function downloadBlob(blob, filename) {
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
export function sessionMeta() {
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

export async function exportSessionFolder() {
  show($('#list-popup'), false);
  const s = state.session;
  if (!s.tracks.length) { showError('まだ書き出すものがありません。'); return; }
  const meta = sessionMeta();

  const files = [['session.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' })],
    [T('録音証明') + '.txt', new Blob([provenanceText()], { type: 'text/plain;charset=utf-8' })]];
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

