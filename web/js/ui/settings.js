/*
  Tonmeister — 詳しい設定・フォルダ直書き・スマホと PWA・言語。
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
import { $, ask, engine, setText, show, showError, showNotice, state } from './context.js';
import { setSwitch, updateFinishUi, updateSessionUi } from './overdub.js';
import { addRecordedTake, autoMeasureLatency, openInput, renderGrade, scheduleAssess, setVerdict, updateInputStatus } from './record.js';

/* ================= 詳しい設定 ================= */

export const RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export async function openSettings() {
  if (engine.isRecording || engine.isPlaying) { showError('録音・再生を止めてから開いてください。'); return; }
  await refreshDeviceList();
  updateSettingsDialog();
  $('#dlg-settings').showModal();
}

export async function refreshDeviceList() {
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

export async function reopenInput() {
  engine.close();
  state.latencyAutoDone = false;
  state.grade = null;
  show($('#path-grade'), false);
  try { await openInput(); autoMeasureLatency(); scheduleAssess(1200); }
  catch (e) { showError(e.message); updateInputStatus(); }
}


/* ================= スマホ・PWA ================= */

export const isTouch = matchMedia('(pointer: coarse)').matches;
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function needsGesture(err) {
  const n = err && (err.name || '');
  const m = String(err && err.message || '');
  return isTouch || isIOS || /NotAllowed|gesture|user activation|許可されていません/i.test(n + ' ' + m);
}

export function showTapStart() {
  show($('#tap-start'), true);
  $('#btn-tap-start').onclick = async () => {
    show($('#tap-start'), false);
    try {
      if (engine.ctx && engine.ctx.state === 'suspended') await engine.ctx.resume();
      if (!engine.isOpen) { await openInput(); autoMeasureLatency(); scheduleAssess(1200); }
    } catch (e) { showNotice(e.message, true, '詳しい設定', openSettings); }
  };
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

/** この端末・ブラウザで何が使えて何が使えないかを、最初に一度だけ正直に言う。 */
export function platformNotes() {
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

export function updateLangButton() {
  const b = $('#btn-lang');
  if (!b) return;
  setText(b, currentLang() === 'en' ? '日本語' : 'English');
  b.title = currentLang() === 'en' ? '日本語で表示' : 'Show in English';
}

export function toggleLang() {
  setLang(currentLang() === 'en' ? 'ja' : 'en');
  updateLangButton();
  updateInputStatus();
  updateSessionUi();
  updateFinishUi();
  renderGrade();
  setVerdict(state.verdict, true);
}


/* ================= フォルダ直書き ================= */

/** 前に選んだフォルダを取り出し、許可が残っていれば鏡を用意する。途中のファイルがあれば繋ぐ。 */
export async function setupMirror() {
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

export async function chooseMirrorFolder() {
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

export async function clearMirrorFolder() {
  await store.setHandle('mirrorDir', null);
  state.settings.mirrorEnabled = false;
  state.mirrorDir = null;
  engine.mirror = null;
  await store.setSettings(state.settings);
  updateSettingsDialog();
}

export function updateSettingsDialog() {
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

