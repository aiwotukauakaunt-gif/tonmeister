/*
  経路の格。いまの音の入り口で「素のまま録れるか」を、開いた瞬間に測って1行にする。
  「音のチェック」を手で押さなくても、16bit で届いている・再標本化している・
  ブラウザの加工が残っている・ハムや超音波の雑音がある・音が落ちている、を録る前に知らせる。

  録音経路には触らない。測って言うだけ。
*/

import * as Analysis from './analysis.js';
import { fmtDb } from './meterscale.js';

/**
 * @param engine  Engine（開いていること）
 * @param opts    { seconds: 取り込む長さ, previous: 前回の結果（ビット数が分からなかった時に持ち越す） }
 */
export async function assessPath(engine, { seconds = 1.5, previous = null } = {}) {
  const st = engine.status();
  if (!st) return null;
  const r = { at: Date.now(), status: st, lines: [], actions: [], bits: 0, bitsSure: false, floorDb: null, humOverFloorDb: 0, ultrasonicOverFloorDb: 0, gaps: engine.gapCount, drift: engine.drift() };

  let reports = null;
  try {
    const cap = await engine.captureForAnalysis(seconds);
    reports = Analysis.analyze(cap.samples, cap.frames, cap.channels, cap.sampleRate);
  } catch { }

  if (reports && reports.length) {
    const worst = reports.reduce((a, c) => (c.rmsDb > a.rmsDb ? c : a), reports[0]);
    r.peakDb = Math.max(...reports.map(c => c.peakDb));
    // 音が鳴っている間は暗騒音は測れない（鳴っている音を床と間違えない）
    r.floorDb = r.peakDb > -40 ? null : worst.rmsDb;
    r.sounding = r.peakDb > -40;
    r.humOverFloorDb = Math.max(...reports.map(c => c.humOverFloorDb));
    r.ultrasonicOverFloorDb = Math.max(...reports.map(c => c.ultrasonicAvailable ? c.ultrasonicOverFloorDb : 0));
    const arrived = reports.map(c => c.arrivedBits).filter(b => b > 0);
    if (arrived.length) { r.bits = Math.min(...arrived); r.bitsSure = reports.some(c => c.arrivedBitsSure); }
      r.implausible = !r.sounding && worst.rmsDb < Analysis.IMPLAUSIBLY_QUIET_DB;
  }
  // 音が無くてビット数が分からなかったら、前回の答えを持ち越す
  if (r.bits === 0 && previous && previous.bits > 0) { r.bits = previous.bits; r.bitsSure = previous.bitsSure; r.bitsFromPrevious = true; }

  // ---- 判定 ----
  let bad = 0, soft = 0;
  const push = (kind, text, action) => { r.lines.push({ kind, text }); if (action) r.actions.push(action); if (kind === 'bad') bad++; else if (kind === 'soft') soft++; };

  if (st.fake) push('info', '検証用の合成音です。');

  if (st.rawPath) push('good', `生取得 ${(st.captureRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz / ${st.channels}ch。再標本化なし。`);
  else if (st.resampled) push('bad', `ブラウザが ${(st.streamRate / 1000).toFixed(1)}k → ${(st.contextRate / 1000).toFixed(1)}k に再標本化しています。`, '「詳しい設定 → 音の細かさ」を機器と同じ値に。Chrome / Edge なら生フレーム取得を入れる。');
  else push('soft', `AudioContext 経由 ${(st.contextRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz / ${st.channels}ch。`, 'Chrome / Edge なら生フレーム取得が使えます。');

  if (st.clean) push('good', 'ブラウザの加工はすべて切れています。');
  else if (st.unknown) push('soft', 'ブラウザが加工の状態を答えません。', '「音のチェック → ブラウザが加工していないか調べる」で確かめる。');
  else push('bad', 'ブラウザの加工が残っています（エコー消し／ノイズ抑制／自動音量のどれか）。', '「詳しい設定 → ブラウザの加工」を全部「切」にして開き直す。');

  if (r.implausible) push('bad', `暗騒音 ${fmtDb(r.floorDb)} は実在の機材では出ません。静かな間だけ入力を潰す処理が入っています。`, 'Windows のサウンド設定で「オーディオ拡張機能」「信号の強調」を切る。');
  else if (r.bits === 16) push('bad', '届いている値が 16bit の刻みに乗っています。24bit の機材でも 16bit しか届いていません。', 'Windows の「サウンド設定 → 録音 → 既定の形式」を 24bit・機器と同じレートに。');
  else if (r.bits === 24) push('good', '24bit の刻みで届いています。');
  else if (r.bits === 32) push('good', '整数の刻みに乗っていません（float のまま、または音量が掛かっています）。');
  else push('info', 'ビット数は、音を出すと分かります。');

  if (r.sounding) push('info', '音が鳴っていたので、暗騒音は静かなときに測り直します。');
  if (r.floorDb != null && !r.implausible) {
    if (r.floorDb > -55) push('bad', `暗騒音が高い（${fmtDb(r.floorDb)}）。`, '入力ゲインを下げる、PC のファンや空調から離す。');
    else if (r.floorDb > -70) push('soft', `暗騒音 ${fmtDb(r.floorDb)}。実用範囲。`);
    else push('good', `暗騒音 ${fmtDb(r.floorDb)}。静か。`);
  }
  if (r.humOverFloorDb > 12) push('soft', `電源ハムが床より ${r.humOverFloorDb.toFixed(0)} dB 高い。`, '電源アダプタやディスプレイからマイクを離す。USB ポートを変える。');
  if (r.ultrasonicOverFloorDb > 12) push('soft', `20 kHz より上に床より ${r.ultrasonicOverFloorDb.toFixed(0)} dB 高い雑音。`, 'スイッチング電源・ディスプレイ・USB ハブを離す。');
  if (r.gaps > 0) push('bad', `入力の音が ${r.gaps} 回落ちています。`, '他のタブやアプリを閉じる。機器のバッファを大きくする。');
  if (r.drift && r.drift.ready && r.drift.relativePpm != null && Math.abs(r.drift.msPer10min) > 5) {
    push('soft', `クロックのずれ ${r.drift.relativePpm >= 0 ? '+' : ''}${r.drift.relativePpm.toFixed(0)} ppm（10 分で ${Math.abs(r.drift.msPer10min).toFixed(1)} ms）。`, '重ね録りでは再生側で相殺します。録る機器と鳴らす機器を同じにすると消えます。');
  }

  r.grade = bad > 0 ? '△' : soft > 0 ? '○' : '◎';
  r.title = bad > 0 ? '手当てが要ります' : soft > 0 ? 'ほぼ素のまま録れます' : '素のまま録れます';
  r.summary = summarize(r);
  return r;
}

/** 1行の要約。 */
function summarize(r) {
  const st = r.status;
  const parts = [];
  parts.push(st.rawPath ? '生取得' : (st.resampled ? '再標本化あり' : 'AudioContext 経由'));
  parts.push(r.bits === 16 ? '16bit ⚠' : r.bits === 24 ? '24bit' : r.bits === 32 ? 'float' : 'ビット数 未定');
  parts.push(st.clean ? '無加工' : st.unknown ? '加工 不明' : '加工あり ⚠');
  if (r.floorDb != null) parts.push(`床 ${fmtDb(r.floorDb)}`);
  if (r.gaps > 0) parts.push(`落ち ${r.gaps}`);
  if (r.drift && r.drift.ready && r.drift.relativePpm != null) parts.push(`ずれ ${r.drift.relativePpm >= 0 ? '+' : ''}${r.drift.relativePpm.toFixed(0)} ppm`);
  return parts.join('・');
}

/* ---------------- 試し弾き ---------------- */

/**
 * 「いちばん強く鳴らして」の数秒から、入力つまみをどうすべきかを一言にする。
 * 目標は True Peak −12 dBTP（帯 −18〜−8 の真ん中）。float32 で録るなら熱くする意味は無く、
 * 機材の手前で歪むのが唯一の損失なので、余裕を取る。
 */
export function adviseGain({ truePeak, samplePeak, flats }, targetDb = -12) {
  const tp = truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity;
  const delta = targetDb - tp;
  if (flats > 0) {
    return { verdict: 'distorted', tpDb: tp, deltaDb: Math.min(delta, -6),
      text: `波の頭が ${flats} 回平らになりました。機材側（プリアンプ）で歪んでいます。入力つまみを 6 dB 以上下げて、もう一度。` };
  }
  if (!isFinite(tp) || tp < -60) return { verdict: 'silent', tpDb: tp, deltaDb: 0, text: '音が入っていません。楽器をいちばん強く鳴らしてください。' };
  if (tp > -8) return { verdict: 'hot', tpDb: tp, deltaDb: delta, text: `いちばん大きいところ ${tp.toFixed(1)} dBTP。${Math.abs(delta).toFixed(0)} dB 下げてください。ここより上は機材の手前で歪むところに近づくだけで、質は上がりません。` };
  if (tp < -18) return { verdict: 'low', tpDb: tp, deltaDb: delta, text: `いちばん大きいところ ${tp.toFixed(1)} dBTP。あと ${delta.toFixed(0)} dB 上げられます（上げなくても 32bit float なら音は欠けません。暗騒音との比が良くなります）。` };
  return { verdict: 'good', tpDb: tp, deltaDb: delta, text: `いちばん大きいところ ${tp.toFixed(1)} dBTP。いまの位置でいいです。` };
}
