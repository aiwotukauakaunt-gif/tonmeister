/*
  オーディオスレッドで動く処理。
  デスクトップ版の RecorderEngine.OnBuffer と NoiseGate をここへ移した。

  この中では一切ファイルに触らない（描画も保存もしない）。
  録れた音は postMessage で外へ渡すだけにして、詰まりを作らない。
*/

import { CaptureCore } from './capture-core.js';

/* ============ 入力の取り込み ============
   AudioContext 経由の道。生フレーム取得（capture-worker.js）が使えないブラウザでの受け皿。
   測り方・渡し方は CaptureCore にまとめてあり、どちらの道でも同じ。
   ・メーター用のピークは常に更新する（録音していなくても）
   ・録音中は生のサンプルをそのまま外へ渡す。加工は一切しない。
*/
class TonmeisterRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = options.processorOptions || {};
    this.core = new CaptureCore((m, transfer) => this.port.postMessage(m, transfer || []), {
      channels: opt.channels || 1,
      blockFrames: 4096,   // 128 フレーム毎に投げると数が多すぎる
      tapFrames: 1024,     // 測定用は細かく渡す（ズレ合わせの基準点を鈍らせないため）
    });
    this.port.onmessage = (e) => this.core.command(e.data);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    this.core.push(input, input[0].length, null);
    return true;
  }
}

/* ============ ノイズゲート ============
   小さい音のときだけ音量を下げる。
   開くのは速く、閉じるのはゆっくり（音の入り口を削らないため）。
   検出用の包絡線と音量そのものの動きは別々の速さにしてある。
*/
class TonmeisterGate extends AudioWorkletProcessor {
  constructor(options) {
    const o = options.processorOptions || {};
    super();
    const rate = sampleRate;
    this.threshold = Math.pow(10, (o.thresholdDb ?? -60) / 20);
    this.detectorCoef = Math.exp(-1 / (rate * (o.detectorMs ?? 30) / 1000));
    this.attackCoef = Math.exp(-1 / (rate * (o.attackMs ?? 2) / 1000));
    this.releaseCoef = Math.exp(-1 / (rate * (o.releaseMs ?? 120) / 1000));
    this.holdSamples = Math.round(rate * (o.holdMs ?? 80) / 1000);
    this.envelope = 0;
    this.gain = 1;
    this.hold = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    const ch = Math.min(input.length, output.length);

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < ch; c++) {
        const a = Math.abs(input[c][i]);
        if (a > peak) peak = a;
      }

      this.envelope = peak > this.envelope
        ? peak
        : this.envelope * this.detectorCoef + peak * (1 - this.detectorCoef);

      let open;
      if (this.envelope >= this.threshold) {
        this.hold = this.holdSamples;
        open = true;
      } else {
        if (this.hold > 0) this.hold--;
        open = this.hold > 0;
      }

      const target = open ? 1 : 0;
      const coef = target > this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = this.gain * coef + target * (1 - coef);

      for (let c = 0; c < ch; c++) output[c][i] = input[c][i] * this.gain;
    }
    return true;
  }
}

registerProcessor('tm-recorder', TonmeisterRecorder);
registerProcessor('tm-gate', TonmeisterGate);
