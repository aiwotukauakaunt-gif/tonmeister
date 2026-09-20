/*
  Tonmeister — 脇の録り（side take）。

  keyboard の中で開かれたとき、鍵盤・メトロノーム・伴奏ループ・ドローンの音（アプリ音バス）を
  マイクの録りと同じ合図で、別のトラックとして並行して録る。
  マイクの経路には一切触らない。マイクの素は素のまま、クリックや伴奏だけが別に残る。

  音の受け方は 2 通り。engine が経路に合わせて選ぶ。
    ・worker：生フレーム取得のとき。capture-worker.js がマイクと同じ Worker の中で受け、
              AudioData.timestamp（同じ時計）でマイクの開始・停止と同じ時刻に切る。標本の単位で揃う
    ・worklet：AudioContext 経由のとき。同じ AudioContext の中の worklet で受ける（本線と同じ量子で動く）
  ここは受け皿（store：OPFS / IndexedDB）への書き込みと、止めたときの読み戻しだけを持つ。

  ・モノラルで録る（アプリ音は中央に置かれた合成音。左右を分けて残す意味が薄く、容量が半分で済む）
  ・1 GB（48 kHz モノで約 90 分）を超えたら脇の録りだけ静かに打ち止め。本線は続く
*/

import * as store from './store.js';
import { concat } from './engine.js';

const FLUSH_MS = 2000;
const CAP_BYTES = 1024 * 1024 * 1024;

export class SideRecorder {
  /**
   * @param ctx    Tonmeister の AudioContext（worklet のときは worklets.js が読み込み済みであること）
   * @param stream 親アプリの音の MediaStream
   * @param mode   'worker' | 'worklet'
   */
  constructor(ctx, stream, mode = 'worklet') {
    this.ctx = ctx;
    this.stream = stream;
    this.mode = mode;
    this.node = null;
    if (mode === 'worklet') {
      this.src = ctx.createMediaStreamSource(stream);
      // 左右をひとつに畳む（Web Audio の既定の畳み方：0.5×(L+R)）
      this.mono = ctx.createGain();
      this.mono.channelCount = 1;
      this.mono.channelCountMode = 'explicit';
      this.mono.channelInterpretation = 'speakers';
      this.node = new AudioWorkletNode(ctx, 'tm-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { channels: 1 },
      });
      this.node.port.onmessage = (e) => this.onData(e.data);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      this.src.connect(this.mono).connect(this.node).connect(sink).connect(ctx.destination);
    }

    this.recording = false;
    this.capped = false;
    this.rate = ctx.sampleRate;
    this._id = null;
    this._sink = null;
    this._sinkReady = null;
    this._pending = [];
    this._pendingFrames = 0;
    this._frames = 0;
    this._bytes = 0;
    this._timer = null;
    this._flushing = null;
    this._resolve = null;
    this.onError = null;
  }

  get sampleRate() { return this.rate; }
  get recordedSeconds() { return this._frames / this.rate; }

  /**
   * 本線の startRecording と同じ瞬間に呼ぶ。
   * worklet のとき：trimFrames は頭から捨てるフレーム（重ね録りの助走ぶん）。
   * worker のとき：切る時刻は Worker が本線の合図から決めるので、ここでは受け皿を開くだけ。
   */
  start(trimFrames = 0) {
    if (this.recording) return;
    this._id = 'side_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this._pending = []; this._pendingFrames = 0; this._frames = 0; this._bytes = 0;
    this.capped = false;
    this.recording = true;
    if (this.node) this.node.port.postMessage({ cmd: 'record', on: true, trimFrames: Math.max(0, trimFrames | 0), preroll: false });
    this._sinkReady = store.openRecordingSink(this._id, 1, this.rate)
      .then(s => { this._sink = s; return s; })
      .catch(e => { if (this.onError) this.onError('脇の録りの受け皿を開けませんでした: ' + e.message); return null; });
    this._timer = setInterval(() => this._flush(), FLUSH_MS);
  }

  /** 止めて、録れた音（モノラル）を返す。何も録れていなければ null。 */
  async stop() {
    if (!this.recording) return null;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const done = new Promise(r => { this._resolve = r; });
    if (this.node) this.node.port.postMessage({ cmd: 'record', on: false });
    // worker のときは、本線の合図で Worker が止めて end を送ってくる。少し長めに待つ（脇の札はマイクより後に届くことがある）
    await Promise.race([done, new Promise(r => setTimeout(r, this.node ? 1500 : 2500))]);
    this._resolve = null;
    this.recording = false;

    while (this._pending.length) await this._flush();
    if (this._flushing) await this._flushing;
    const sink = this._sink || await this._sinkReady;
    if (sink) { try { await sink.end(); } catch { } }
    const stored = await store.readRecording(this._id);
    await store.clearRecording(this._id);
    this._sink = null;
    const samples = stored ? stored.samples : new Float32Array(0);
    const rate = this.rate;
    if (!samples.length) return null;
    return { samples, frames: samples.length, channels: 1, sampleRate: rate, seconds: samples.length / rate, capped: this.capped, mode: this.mode };
  }

  close() {
    if (this.recording && this.node) { try { this.node.port.postMessage({ cmd: 'record', on: false }); } catch { } }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.node) { try { this.src.disconnect(); this.mono.disconnect(); this.node.disconnect(); } catch { } }
    this.recording = false;
  }

  /** 音の札（worklet の port か、Worker からの side-data）。 */
  onData(m) {
    if (m.type !== 'data' && m.type !== 'side-data') return;
    if (m.sampleRate && m.sampleRate !== this.rate && this.mode === 'worker') this.rate = m.sampleRate;
    if (m.samples && this.recording && !this.capped) {
      this._frames += m.frames;
      this._pending.push(m.samples);
      this._pendingFrames += m.frames;
    }
    if (m.end && this._resolve) { const r = this._resolve; this._resolve = null; r(); }
  }

  async _flush() {
    if (this._flushing) return this._flushing;
    if (this._pending.length === 0) return 0;
    const sink = this._sink || await this._sinkReady;
    if (!sink) return 0;
    const chunks = this._pending; const frames = this._pendingFrames;
    this._pending = []; this._pendingFrames = 0;
    const merged = concat(chunks);
    const bytes = merged.byteLength;
    this._flushing = (async () => {
      try { await sink.append(merged); }
      catch (e) { if (this.onError) this.onError('脇の録りの書き込みに失敗: ' + e.message); }
      finally { this._flushing = null; }
    })();
    await this._flushing;
    this._bytes += bytes;
    if (this._bytes >= CAP_BYTES && !this.capped) {
      this.capped = true;   // ここから先は本線だけ。止めたときに知らせる
    }
    return frames;
  }
}
