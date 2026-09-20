/*
  入力デバイス →（加工なし）→ 置き場所 の流れと、重ね録り用の再生を管理する。
  デスクトップ版の RecorderEngine にあたる。

  ブラウザ版で最も大事なのは、ここで **ブラウザの加工を全部切る** こと。
  エコーキャンセル・ノイズ抑制・自動ゲイン補正（と、新しい「声だけ抽出」）は既定で入っていて、
  入っていると録れるのは「実際に鳴っている音」ではなくなる。

  音の入り口は2つの道がある。
    生フレーム取得 … MediaStreamTrackProcessor でトラックから直接読む（Chrome / Edge）。
                     AudioContext を通らないので、機器のレート・チャンネル数のまま届く。
    AudioContext   … それが無いブラウザの受け皿。AudioWorklet で取る。
  どちらでも CaptureCore が同じ測り方・渡し方をする。

  録音中の音は、OPFS が使えれば storage-worker.js がファイルへ同期追記し、
  使えなければ IndexedDB に塊で入れる（store.js）。
*/

import * as store from './store.js';
import * as Finish from './finish.js';

const CLICK_FREQUENCY = 1000;

/** 録音中に受け皿へ落とす間隔。OPFS は同期追記なので細かく、IndexedDB は塊で。 */
const FLUSH_MS = { opfs: 500, idb: 2000 };

export class Engine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.srcNode = null;
    this.recNode = null;
    this.monitorGain = null;
    this.masterGain = null;
    this.analyser = null;
    this._analyserBuf = null;

    this.captureWorker = null;      // 生フレーム取得の Worker（使えるときだけ）
    this.rawPath = false;
    this.captureRate = 0;           // 実際に届いているレート（生フレーム取得のとき）
    this.fake = false;

    this.isRecording = false;
    this.isPlaying = false;

    this._peaks = [];
    this._truePeaks = [];
    this._clips = [];
    this._clipBase = [];
    this._flats = [];
    this._flatBase = [];
    this._outPeak = 0;

    this._recId = null;
    this._recSink = null;
    this._recPending = [];
    this._recPendingFrames = 0;
    this._recFrames = 0;
    this._recChannels = 1;
    this._recToMemory = false;
    this._recMemory = [];
    this._recFlushTimer = null;
    this._recFlushing = null;
    this._recResolve = null;
    this._recStartTotal = 0;        // 録音開始時点の取り込み累計フレーム（落ちた位置の換算用）
    this._recPrerolled = 0;         // 押す前の音として先頭に付いたフレーム
    this._recTrim = 0;
    this._recGaps = [];             // この録音の中で落ちた場所 [{atFrame, frames}]
    this._recParts = [];            // 長時間で切り替えた前の部分 [{recId, frames}]
    this._recPartBytes = 0;
    this._recMap = null;            // 録るチャンネル（入力の番号）
    this.prerollSeconds = 0;
    this.rolloverBytes = 1024 * 1024 * 1024;   // 1 GB ごとに次の受け皿へ（サンプルは落とさない）
    this.lostFrames = 0;            // 入り口を開いてから落ちたフレームの合計
    this.gapCount = 0;
    this.mirror = null;             // フォルダ直書き（disk-writer.js）。無ければ null

    this._tapChunks = null;
    this._tapWant = 0;
    this._tapResolve = null;

    this._playNodes = [];
    this._playGains = [];
    this._playStartCtx = 0;
    this._playOffset = 0;
    this._toneNode = null;

    // クロックのずれ（ドリフト）を見るための時計
    this._captureClock = [];        // [秒, フレーム]
    this._outputClock = [];         // [秒, ctx.currentTime]
    this._clockTimer = null;
    this._clockT0 = 0;

    this.actualSettings = null;   // track.getSettings() の結果
    this.requestedProcessing = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    this.deviceLabel = '';
    this.deviceId = '';
    this.storageKind = 'idb';
    this.droppedBuffers = 0;
    this.onError = null;
  }

  get isOpen() { return !!this.srcNode; }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 0; }
  get channels() { return this._recChannels; }
  get monitorEnabled() { return !!this.monitorGain && this.monitorGain.gain.value > 0; }
  get playbackSeconds() {
    if (!this.isPlaying) return 0;
    return this.ctx.currentTime - this._playStartCtx + this._playOffset;
  }

  static get canRawCapture() { return typeof MediaStreamTrackProcessor === 'function'; }

  /* ---------------- 入力の開閉 ---------------- */

  /**
   * 音の入り口を開く。ブラウザの加工は明示的に切って頼む。
   * 実際にどう開いたかは actualSettings に入る（頼んだ通りとは限らないため）。
   *
   * @param raw   生フレーム取得を使うか（使えるブラウザでは既定 true）
   * @param fake  マイクの代わりに合成音（検証用。?fake=1）
   */
  async open({ deviceId, sampleRate, channelCount, processing, raw = true, fake = false } = {}) {
    this.close();
    this.fake = !!fake;

    const proc = Object.assign({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }, processing || {});
    this.requestedProcessing = proc;

    const audio = {
      echoCancellation: { ideal: proc.echoCancellation },
      noiseSuppression: { ideal: proc.noiseSuppression },
      autoGainControl: { ideal: proc.autoGainControl },
      // 「声だけ抽出」。楽器録音では致命的なので切る（対応ブラウザだけが見る）
      voiceIsolation: { ideal: false },
      // 取り込みのバッファは最短で
      latency: { ideal: 0 },
      // Chrome 系の別名。上の標準名を無視する版があるので両方渡す。
      googEchoCancellation: { ideal: proc.echoCancellation },
      googNoiseSuppression: { ideal: proc.noiseSuppression },
      googAutoGainControl: { ideal: proc.autoGainControl },
      googHighpassFilter: { ideal: false },
      googAudioMirroring: { ideal: false },
      googTypingNoiseDetection: { ideal: false },
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    if (sampleRate) audio.sampleRate = { ideal: sampleRate };
    // 何も指定がなければ 2ch を頼む。Chrome はそのままだとモノラルに畳んでしまう。
    audio.channelCount = { ideal: channelCount || 2 };

    let stream;
    if (fake) {
      stream = this._makeFakeStream(sampleRate || 48000);
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (e) {
        if (deviceId) {
          // その機器が使えないなら、既定の入り口で開き直す
          delete audio.deviceId;
          stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        } else {
          throw new Error(describeGumError(e));
        }
      }
    }

    const track = stream.getAudioTracks()[0];
    this.actualSettings = track.getSettings ? track.getSettings() : {};
    this.deviceLabel = fake ? '検証用の合成音' : (track.label || '（名前の分からない機器）');
    this.deviceId = this.actualSettings.deviceId || deviceId || '';
    this.stream = stream;
    this.storageKind = await store.storageKind();

    // ---- 生フレーム取得（使えれば） ----
    let format = null;
    if (raw && Engine.canRawCapture) {
      try { format = await this._startRawCapture(track); }
      catch (e) { console.warn('生フレーム取得に失敗。AudioContext 経由に切り替えます:', e); this._stopRawCapture(); }
    }
    this.rawPath = !!format;
    this.captureRate = format ? format.sampleRate : (this.actualSettings.sampleRate || 0);

    // 入り口の実レートに合わせて開く。合わないとブラウザが黙って再標本化する。
    // 生フレーム取得のときは、届いている実レートそのものにする（設定より優先）。
    const wanted = format ? format.sampleRate : (sampleRate || this.actualSettings.sampleRate || 48000);
    this.ctx = new AudioContext({ sampleRate: wanted, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    await this.ctx.audioWorklet.addModule('js/worklets.js');

    this.srcNode = this.ctx.createMediaStreamSource(stream);
    const ch = format ? format.channels : (this.srcNode.channelCount || this.actualSettings.channelCount || 1);
    this._resetMeters(ch);

    if (!format) {
      this.recNode = new AudioWorkletNode(this.ctx, 'tm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: ch,
        channelCountMode: 'explicit',
        processorOptions: { channels: ch },
      });
      this.recNode.port.onmessage = (e) => this._onCaptureMessage(e.data);

      // 出力へは流さない。process() を回すためだけに無音の袋小路へ繋ぐ。
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.srcNode.connect(this.recNode);
      this.recNode.connect(sink).connect(this.ctx.destination);
    }

    // モニター（録音される信号とは完全に別経路）
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.srcNode.connect(this.monitorGain).connect(this.ctx.destination);

    // 再生とテスト音をまとめる。出力へ流す直前にピークを控える。
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this._analyserBuf = new Float32Array(this.analyser.fftSize);
    this.masterGain.connect(this.analyser).connect(this.ctx.destination);

    this._startClock();
    this.lostFrames = 0; this.gapCount = 0;
    this.setPreroll(this.prerollSeconds);
    this.setRecordChannels(this._recMap);
    return this.status();
  }

  /** 押す前の音を何秒残すか（輪っかの大きさ）。 */
  setPreroll(seconds) {
    this.prerollSeconds = Math.max(0, +seconds || 0);
    if (!this.isOpen) return;
    try { this._sendCapture({ cmd: 'preroll', frames: Math.round(this.prerollSeconds * this.recordRate) }); } catch { }
  }

  /** 録るチャンネル（入力の番号の配列）。null なら全部。 */
  setRecordChannels(map) {
    this._recMap = Array.isArray(map) && map.length ? map.slice() : null;
    if (!this.isOpen) return;
    try { this._sendCapture({ cmd: 'channels-map', map: this._recMap || [] }); } catch { }
  }

  /** 実際に録音に入るチャンネル数。 */
  get recordChannels() {
    if (this._recMap) return this._recMap.filter(i => i >= 0 && i < this._recChannels).length || this._recChannels;
    return this._recChannels;
  }

  _resetMeters(ch) {
    this._recChannels = ch;
    this._peaks = new Array(ch).fill(0);
    this._truePeaks = new Array(ch).fill(0);
    this._clips = new Array(ch).fill(0);
    this._clipBase = new Array(ch).fill(0);
    this._flats = new Array(ch).fill(0);
    this._flatBase = new Array(ch).fill(0);
  }

  /** トラックを Worker に渡し、最初のフレームの形（レート・ch）が分かるまで待つ。 */
  _startRawCapture(track) {
    return new Promise((resolve, reject) => {
      const processor = new MediaStreamTrackProcessor({ track });
      const worker = new Worker('js/capture-worker.js', { type: 'module' });
      this.captureWorker = worker;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('最初のフレームが届きません')); } }, 2500);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'format' && !settled) {
          settled = true; clearTimeout(timer);
          resolve({ sampleRate: m.sampleRate, channels: m.channels });
        }
        this._onCaptureMessage(m);
      };
      worker.onerror = (e) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(e.message || 'worker error')); }
      };
      worker.postMessage({ cmd: 'start', readable: processor.readable, channels: 2 }, [processor.readable]);
    });
  }

  _stopRawCapture() {
    if (this.captureWorker) {
      try { this.captureWorker.postMessage({ cmd: 'stop' }); } catch { }
      const w = this.captureWorker;
      setTimeout(() => { try { w.terminate(); } catch { } }, 300);
    }
    this.captureWorker = null;
    this.rawPath = false;
  }

  /** 検証用：マイクの代わりに 440Hz ＋ 薄い雑音を鳴らす MediaStream。 */
  _makeFakeStream(rate) {
    const ctx = new AudioContext({ sampleRate: rate });
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    const noise = ctx.createBufferSource();
    const nb = ctx.createBuffer(1, rate * 2, rate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.002;
    noise.buffer = nb; noise.loop = true;
    osc.connect(g).connect(dest);
    noise.connect(dest);
    osc.start(); noise.start();
    this._fakeCtx = ctx;
    return dest.stream;
  }

  /** 送り側（capture）と鳴らす側（ctx）の進み方を1秒ごとに控える。 */
  _startClock() {
    this._captureClock = [];
    this._outputClock = [];
    this._clockT0 = performance.now();
    this._clockTimer = setInterval(() => {
      if (!this.ctx) return;
      const t = (performance.now() - this._clockT0) / 1000;
      this._outputClock.push([t, this.ctx.currentTime]);
      if (this._outputClock.length > 600) this._outputClock.shift();
    }, 1000);
  }

  /** 送り側のクロックが、鳴らす側に対して速いか遅いか（ppm）。重ね録りが後半でずれる原因。 */
  drift() {
    const slope = (pts) => {
      if (pts.length < 20) return null;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const n = pts.length;
      for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
      const d = n * sxx - sx * sx;
      return d > 0 ? (n * sxy - sx * sy) / d : null;
    };
    const out = slope(this._outputClock);          // ctx 秒 / 実秒
    if (out == null) return { ready: false };
    const rate = this.captureRate || this.sampleRate;
    const cap = this.rawPath && rate ? slope(this._captureClock.map(([t, f]) => [t, f / rate])) : null;
    const outPpm = (out - 1) * 1e6;
    const capPpm = cap == null ? null : (cap - 1) * 1e6;
    const relPpm = cap == null ? null : (cap - out) * 1e6;
    const seconds = this._outputClock[this._outputClock.length - 1][0];
    return {
      ready: true, seconds, outputPpm: outPpm, capturePpm: capPpm, relativePpm: relPpm,
      msPer10min: relPpm == null ? null : relPpm * 600 / 1000,   // ppm × 600 秒 = µs → ms
    };
  }

  close() {
    this.stopPlayback();
    if (this.isRecording) { try { this._sendCapture({ cmd: 'record', on: false }); } catch { } }
    this.isRecording = false;
    if (this._recFlushTimer) { clearInterval(this._recFlushTimer); this._recFlushTimer = null; }
    if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }

    this._stopRawCapture();
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    if (this.ctx) { try { this.ctx.close(); } catch { } }
    if (this._fakeCtx) { try { this._fakeCtx.close(); } catch { } this._fakeCtx = null; }
    this.stream = null; this.ctx = null; this.srcNode = null; this.recNode = null;
    this.monitorGain = null; this.masterGain = null; this.analyser = null;
    this.captureRate = 0;
  }

  _sendCapture(m) {
    if (this.captureWorker) this.captureWorker.postMessage(m);
    else if (this.recNode) this.recNode.port.postMessage(m);
    else throw new Error('先に音の入り口を開いてください。');
  }

  /** いま何につながっているか（状態ピル1行のもと）。 */
  status() {
    if (!this.isOpen) return null;
    const s = this.actualSettings || {};
    const streamRate = this.rawPath ? this.captureRate : (s.sampleRate || 0);
    const procs = [s.echoCancellation, s.noiseSuppression, s.autoGainControl];
    if (s.voiceIsolation !== undefined) procs.push(s.voiceIsolation);
    return {
      device: this.deviceLabel,
      contextRate: this.ctx.sampleRate,
      streamRate,
      captureRate: this.captureRate,
      channels: this._recChannels,
      rawPath: this.rawPath,
      storage: this.storageKind,
      fake: this.fake,
      // ブラウザが再標本化しているか（していれば ADC の出力そのままではない）。
      // 生フレーム取得なら録音は再標本化されない（鳴らす側のレートと違っても、録れる音は素のまま）。
      resampled: !this.rawPath && streamRate > 0 && streamRate !== this.ctx.sampleRate,
      processing: {
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
        voiceIsolation: s.voiceIsolation,
      },
      // 加工がすべて切れているか。undefined（報告しないブラウザ）は「不明」扱い。
      clean: procs.every(v => v === false),
      unknown: [s.echoCancellation, s.noiseSuppression, s.autoGainControl].some(v => v === undefined),
      latencyMs: typeof s.latency === 'number' ? s.latency * 1000 : null,
      baseLatency: this.ctx.baseLatency || 0,
      outputLatency: this.ctx.outputLatency || 0,
    };
  }

  static async listInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  }

  static async listOutputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audiooutput');
  }

  get canChooseOutput() { return !!(this.ctx && typeof this.ctx.setSinkId === 'function'); }

  async setOutputDevice(id) {
    if (!this.canChooseOutput) return false;
    try { await this.ctx.setSinkId(id || ''); return true; } catch { return false; }
  }

  /* ---------------- 取り込み側からの便り ---------------- */

  _onCaptureMessage(m) {
    if (m.type === 'peaks') {
      if (m.peaks.length !== this._peaks.length) this._resetMeters(m.peaks.length);
      for (let c = 0; c < m.peaks.length; c++) {
        if (m.peaks[c] > (this._peaks[c] || 0)) this._peaks[c] = m.peaks[c];
        if (m.truePeaks && m.truePeaks[c] > (this._truePeaks[c] || 0)) this._truePeaks[c] = m.truePeaks[c];
        this._clips[c] = m.clips[c];
        if (m.flats) this._flats[c] = m.flats[c];
      }
      return;
    }
    if (m.type === 'started') {
      this._recPrerolled = m.prerolledFrames | 0;
      this._recStartTotal = m.totalFrames | 0;
      return;
    }
    if (m.type === 'gap') {
      this.lostFrames = m.lostFrames; this.gapCount = m.gapCount;
      if (this.isRecording && m.recording) {
        // 録音の中での位置：取り込み累計 − 開始時点 − 捨てた頭 ＋ 押す前の音
        const at = m.atFrame - this._recStartTotal - this._recTrim + this._recPrerolled;
        this._recGaps.push({ atFrame: Math.max(0, at), frames: m.frames, filled: m.filled });
      }
      if (this.onGap) this.onGap(m);
      return;
    }
    if (m.type === 'clock') {
      this._captureClock.push([m.t / 1000, m.frames]);
      if (this._captureClock.length > 600) this._captureClock.shift();
      return;
    }
    if (m.type === 'format') {
      if (this.rawPath && m.sampleRate !== this.captureRate && this.captureRate) {
        // 途中でレートが変わった（機器が差し替わった）。録音中なら止めるしかない。
        if (this.onError) this.onError(`機器のレートが ${m.sampleRate} Hz に変わりました。音の入り口を開き直してください。`);
      }
      if (this.rawPath) this.captureRate = m.sampleRate;
      return;
    }
    if (m.type === 'error') {
      if (this.onError) this.onError('生フレーム取得が止まりました: ' + m.message);
      return;
    }
    if (m.type === 'tap') {
      if (!this._tapChunks) return;
      this._tapChunks.push(m.frames);
      let total = 0;
      for (const c of this._tapChunks) total += c.length;
      if (this._tapWant > 0 && total >= this._tapWant && this._tapResolve) {
        const r = this._tapResolve; this._tapResolve = null; r();
      }
      return;
    }
    if (m.type === 'data') {
      if (m.samples) {
        this._recFrames += m.frames;
        if (this._recToMemory) {
          this._recMemory.push(m.samples);
        } else {
          this._recPending.push(m.samples);
          this._recPendingFrames += m.frames;
        }
      }
      if (m.end && this._recResolve) {
        const r = this._recResolve; this._recResolve = null; r();
      }
    }
  }

  /* ---------------- メーター ---------------- */

  /** 前回呼び出し以降のピーク（0..1+）を返し、内部値をリセットする。 */
  readPeaks() {
    const out = this._peaks.slice();
    this._peaks.fill(0);
    return out;
  }

  /** 前回呼び出し以降の True Peak（サンプルの間も含めた最大）。 */
  readTruePeaks() {
    const out = this._truePeaks.slice();
    this._truePeaks.fill(0);
    return out;
  }

  readClipCounts() { return this._clips.map((c, i) => c - this._clipBase[i]); }
  resetClips() { this._clipBase = this._clips.slice(); }

  /** 0 dBFS に届かないまま頭が平らになった回数（プリアンプ側の歪み）。 */
  readFlatCounts() { return this._flats.map((c, i) => c - this._flatBase[i]); }
  resetFlats() { this._flatBase = this._flats.slice(); }

  /**
   * 実際に出力へ流れた音のピーク。
   * 「再生したのに聞こえない」とき、音が出ていないのか、
   * 出ているが機器側で絞られているのかを切り分けるために使う。
   */
  readOutputPeak() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._analyserBuf);
    let peak = 0;
    for (let i = 0; i < this._analyserBuf.length; i++) {
      const a = Math.abs(this._analyserBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  /* ---------------- モニター ---------------- */

  setMonitor(on, volume = 1) {
    if (!this.monitorGain) return;
    this.monitorGain.gain.value = on ? volume : 0;
  }

  /* ---------------- 録音 ---------------- */

  /** 録音に使うレート。生フレーム取得なら届いている実レート、そうでなければ AudioContext のもの。 */
  get recordRate() { return this.rawPath && this.captureRate ? this.captureRate : this.sampleRate; }

  /**
   * @param trimFrames 録音の頭から捨てるフレーム数。重ね録りでは「出力遅延＋入力遅延」の
   *                   ぶんだけ演奏が後ろにズレて記録されるため、ここで削って既存トラックと揃える。
   */
  startRecording(trimFrames = 0, { toMemory = false, preroll = true } = {}) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) return null;

    this._recId = 'rec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this._recSink = null;
    this._recPending = [];
    this._recPendingFrames = 0;
    this._recMemory = [];
    this._recFrames = 0;
    this._recToMemory = toMemory;
    this._recTrim = Math.max(0, trimFrames | 0);
    this._recPrerolled = 0;
    this._recGaps = [];
    this._recParts = [];
    this._recPartBytes = 0;
    this.droppedBuffers = 0;
    this.isRecording = true;

    const usePreroll = preroll && !toMemory && this.prerollSeconds > 0 && this._recTrim === 0;
    this._sendCapture({
      cmd: 'record', on: true, trimFrames: this._recTrim,
      preroll: usePreroll, prerollFrames: Math.round(this.prerollSeconds * this.recordRate),
    });

    if (!toMemory) this._openSink();
    return this._recId;
  }

  /** 受け皿を開いて、こまめに落とす。途中で閉じても、録れた音はそこに残る。 */
  _openSink() {
    const channels = this.recordChannels, rate = this.recordRate, id = this._recId;
    this._recSinkReady = store.openRecordingSink(id, channels, rate)
      .then(sink => { this._recSink = sink; return sink; })
      .catch(e => { this.droppedBuffers++; if (this.onError) this.onError('受け皿を開けませんでした: ' + e.message); return null; });
    if (this.mirror) { try { this.mirror.begin(id, channels, rate); } catch (e) { if (this.onError) this.onError('フォルダへの書き込みを始められません: ' + e.message); } }
    if (!this._recFlushTimer) {
      const every = FLUSH_MS[this.storageKind] || 2000;
      this._recFlushTimer = setInterval(() => this._flushRecording(), every);
    }
  }

  /**
   * 受け皿が大きくなりすぎたら、次の受け皿へ切り替える。境目はブロックの境目なので
   * サンプルは1つも落ちない。前の部分は _recParts に控え、止めたときに順に読む。
   */
  async _rollover() {
    const sink = this._recSink || await this._recSinkReady;
    if (sink) { try { await sink.end(); } catch { } }
    if (this.mirror) { try { await this.mirror.end(); } catch { } }
    this._recParts.push({ recId: this._recId, frames: this._recFrames - this._recParts.reduce((a, p) => a + p.frames, 0) });
    this._recId = 'rec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this._recSink = null;
    this._recPartBytes = 0;
    this._openSink();
    if (this.onRollover) this.onRollover(this._recParts.length);
  }

  async _flushRecording() {
    if (this._recFlushing) return this._recFlushing;   // 前の書き込みが終わるまで重ねない
    if (this._recPending.length === 0) return 0;
    const sink = this._recSink || await this._recSinkReady;
    if (!sink) { return 0; }

    const chunks = this._recPending;
    const frames = this._recPendingFrames;
    this._recPending = [];
    this._recPendingFrames = 0;

    const merged = concat(chunks);
    const mergedBytes = merged.byteLength;                     // 転送すると 0 になるので先に控える
    const mirrorCopy = this.mirror ? merged.slice() : null;   // 受け皿へは転送するので、鏡には写しを渡す
    this._recFlushing = (async () => {
      try { await sink.append(merged); }
      catch (e) {
        this.droppedBuffers++;
        if (this.onError) this.onError('書き込みに失敗しました: ' + e.message);
      } finally { this._recFlushing = null; }
    })();
    await this._recFlushing;
    if (mirrorCopy) { try { await this.mirror.append(mirrorCopy); } catch (e) { if (this.onError) this.onError('フォルダへの書き込みに失敗: ' + e.message); } }
    this._recPartBytes += mergedBytes;
    if (this.isRecording && this._recPartBytes >= this.rolloverBytes) await this._rollover();
    return frames;
  }

  get recordedSeconds() {
    if (!this.ctx || !this._recChannels) return 0;
    return this._recFrames / this.recordRate;
  }

  /** 録音を止め、録れた音（インターリーブ）を返す。 */
  async stopRecording() {
    if (!this.isRecording) return null;
    this.isRecording = false;
    if (this._recFlushTimer) { clearInterval(this._recFlushTimer); this._recFlushTimer = null; }

    // 残りを全部渡してもらってから閉じる
    const done = new Promise(resolve => { this._recResolve = resolve; });
    this._sendCapture({ cmd: 'record', on: false });
    await Promise.race([done, delay(1500)]);
    this._recResolve = null;

    const channels = this.recordChannels;
    const sampleRate = this.recordRate;
    let samples;
    const parts = [];

    if (this._recToMemory) {
      samples = concat(this._recMemory);
      this._recMemory = [];
    } else {
      while (this._recPending.length) await this._flushRecording();
      if (this._recFlushing) await this._recFlushing;
      const sink = this._recSink || await this._recSinkReady;
      if (sink) { try { await sink.end(); } catch { } }
      if (this.mirror) { try { await this.mirror.end(); } catch { } }
      // 長時間で切り替えた前の部分は、別々に返す（一度に全部をメモリへ載せない）
      for (const part of this._recParts) {
        const st = await store.readRecording(part.recId);
        if (st && st.samples.length) parts.push({ samples: st.samples, frames: Math.floor(st.samples.length / channels), channels, sampleRate, seconds: st.samples.length / channels / sampleRate });
        await store.clearRecording(part.recId);
      }
      const stored = await store.readRecording(this._recId);
      samples = stored ? stored.samples : new Float32Array(0);
      await store.clearRecording(this._recId);
      this._recSink = null;
      this._recParts = [];
    }

    const frames = channels > 0 ? Math.floor(samples.length / channels) : 0;
    const gaps = this._recGaps.map(g => ({ at: g.atFrame / sampleRate, frames: g.frames, seconds: g.frames / sampleRate }));
    const result = { samples, frames, channels, sampleRate, seconds: frames / sampleRate,
      prerollSeconds: this._recPrerolled / sampleRate, gaps, lostFrames: gaps.reduce((a, g) => a + g.frames, 0) };
    if (parts.length) { parts.push({ ...result, gaps: [], prerollSeconds: 0 }); result.parts = parts; }
    if (this.mirror && this.mirror.finish) { try { result.mirrorFiles = await this.mirror.finish(result); } catch (e) { if (this.onError) this.onError('フォルダへの書き出しに失敗: ' + e.message); } }
    return result;
  }

  /** 途中で閉じてしまった録音を拾い上げる。 */
  static async listOrphanRecordings() { return store.listOrphanRecordings(); }
  static async takeOrphanRecording(recId) {
    const stored = await store.readRecording(recId);
    if (!stored || !stored.samples.length) return null;
    const { samples, channels, sampleRate } = stored;
    const frames = Math.floor(samples.length / channels);
    return { samples, frames, channels, sampleRate, seconds: frames / sampleRate };
  }
  static async dropOrphanRecording(recId) { await store.clearRecording(recId); }

  /* ---------------- 再生 ---------------- */

  /**
   * セッションを鳴らす。鳴らせるトラックが無ければ false。
   * 素の経路と仕上げの経路を両方作り、最後のゲインで切り替える（finish.js）。
   * だから再生中でも瞬時に「素」へ戻せる（B キーを押している間だけ素、なども）。
   * @param loadTake take → {samples, channels, sampleRate} を返す関数
   */
  /**
   * @param driftPpm 重ね録りのとき、送り側と鳴らす側のクロックのずれ（ppm）を再生側で相殺する。
   *                 録音経路には触らない。既存の音を ppm 単位でわずかに速く／遅く鳴らすだけ。
   */
  async startPlayback(session, { exclude = null, startSeconds = 0, loadTake, driftPpm = 0 } = {}) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    this.stopPlayback();

    const playable = session.tracks.filter(t => t !== exclude && t.takes.length > 0);
    if (playable.length === 0) return false;

    const rate = this.ctx.sampleRate;
    let added = 0;

    const buses = Finish.createBuses(this.ctx, session, this.masterGain, { live: true });
    this._buses = buses;
    this._playSession = session;
    this._applyListen(session, true);

    for (const track of playable) {
      const take = track.takes[Math.min(track.activeTakeIndex, track.takes.length - 1)];
      if (!take) continue;
      const audio = await loadTake(take);
      if (!audio) continue;
      if (audio.sampleRate !== rate) {
        this.stopPlayback();
        throw new Error(
          `このセッションは ${(audio.sampleRate / 1000).toFixed(1)} kHz ですが、` +
          `いまの入り口は ${(rate / 1000).toFixed(1)} kHz です。
同じ細かさで開き直すか、新しく始めてください。`);
      }
      const offset = track.startSeconds || 0;
      if (startSeconds >= offset + audio.frames / rate) continue;

      const buffer = this.ctx.createBuffer(audio.channels, audio.frames, rate);
      for (let c = 0; c < audio.channels; c++) {
        const dst = buffer.getChannelData(c);
        for (let i = 0; i < audio.frames; i++) dst[i] = audio.samples[i * audio.channels + c];
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      if (driftPpm && Math.abs(driftPpm) >= 1 && Math.abs(driftPpm) < 5000) src.playbackRate.value = 1 + driftPpm / 1e6;
      const wires = Finish.wireTrack(this.ctx, session, track, src, buses);

      this._playNodes.push(src);
      this._playGains.push({ track, wires, offset });
      added++;
    }

    if (added === 0) return false;

    // 全トラックを同じ瞬間から始める。重ね録りではこの瞬間が録音の基準点になるので、
    // 呼び出し側が playStartAt を見て「捨てる量」を決められるようにしておく。
    // 途中から始まるトラック（長時間録音の続き）は、その位置まで待ってから鳴らす。
    const at = this.ctx.currentTime + 0.15;
    for (let i = 0; i < this._playNodes.length; i++) {
      const off = this._playGains[i].offset;
      if (startSeconds >= off) this._playNodes[i].start(at, startSeconds - off);
      else this._playNodes[i].start(at + (off - startSeconds), 0);
    }
    this._playStartCtx = at;
    this.playStartAt = at;
    this._playOffset = startSeconds;
    this.isPlaying = true;
    return true;
  }

  /** 素／仕上げの切り替えを、再生し直さずにゲインで行う。 */
  _applyListen(session, immediate = false) {
    const b = this._buses;
    if (!b) return;
    const pure = this._holdPure || (session.listen || 'pure') === 'pure';
    const t = this.ctx.currentTime;
    const set = (param, v) => {
      if (immediate) { param.setValueAtTime(v, t); return; }
      param.cancelScheduledValues(t);
      param.setTargetAtTime(v, t, 0.008);   // 8ms で入れ替える。ブツッと切れない
    };
    set(b.pureOut.gain, pure ? 1 : 0);
    set(b.finOut.gain, pure ? 0 : 1);
  }

  /** 聞く側を切り替える（再生中でも即時）。 */
  setListen(session) { this._applyListen(session); }

  /** 押している間だけ素で聞く。 */
  holdPure(on) {
    this._holdPure = !!on;
    if (this._playSession) this._applyListen(this._playSession);
  }
  get isHoldingPure() { return !!this._holdPure; }

  /** 響きの量とトラックごとの送り量を、再生中でもそのまま反映する。 */
  refreshFinish(session) {
    const b = this._buses;
    if (!b) return;
    const f = session.finish;
    if (b.reverb) b.reverb.wet.gain.value = f.reverb.enabled ? f.reverb.amount : 0;
    for (const { track, wires } of this._playGains) {
      if (wires.send) wires.send.gain.value = track.processing.reverbSend == null ? 1 : track.processing.reverbSend;
    }
    const measured = f.measured && isFinite(f.measured.normalizeGainDb) ? f.measured.normalizeGainDb : 0;
    b.finTrim.gain.value = f.normalizeEnabled ? Math.pow(10, measured / 20) : 1;
  }

  /** 音量・ミュート・ソロを再生中でもそのまま反映する。 */
  refreshGains(session, effectiveGain) {
    for (const { track, wires } of this._playGains) {
      const g = effectiveGain(session, track);
      wires.pureGain.gain.value = g;
      wires.finGain.gain.value = g;
    }
  }

  stopPlayback() {
    for (const src of this._playNodes) { try { src.stop(); } catch { } try { src.disconnect(); } catch { } }
    this._playNodes = [];
    this._playGains = [];
    if (this._buses) {
      for (const n of [this._buses.pureOut, this._buses.finOut]) { try { n.disconnect(); } catch { } }
      this._buses = null;
    }
    this._playSession = null;
    this.isPlaying = false;
  }

  /* ---------------- 解析用の取り込み ---------------- */

  /**
   * 解析用に生の入力を指定秒数ぶん取り込む。録音経路には一切手を加えないので、
   * ここで得られる値がそのまま「このデバイスで録れる音」の素性になる。
   */
  async captureForAnalysis(seconds) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) throw new Error('録音中は測定できません。');
    this.startRecording(0, { toMemory: true });
    await delay(seconds * 1000);
    return this.stopRecording();
  }

  /**
   * 経路の自己検証。生フレーム取得の道と AudioContext の道で **同時に** 数秒録り、
   * 揃えて比べる。一致すれば、ブラウザが途中でゲインもリサンプルも掛けていない証明になる。
   * 一致しなければ、その差（音量差・残差）を返す。生フレーム取得でないときは比べる相手が無い。
   */
  async verifyPath(seconds = 2) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) throw new Error('録音中は検証できません。');
    if (!this.rawPath) return { available: false, reason: '生フレーム取得ではないので、比べる相手がありません。' };

    // AudioContext 側の一時的な取り込み口
    const ch = this._recChannels;
    const node = new AudioWorkletNode(this.ctx, 'tm-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: ch, channelCountMode: 'explicit', processorOptions: { channels: ch },
    });
    const chunks = [];
    let endResolve = null;
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'data') { if (m.samples) chunks.push(m.samples); if (m.end && endResolve) endResolve(); }
    };
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    this.srcNode.connect(node); node.connect(sink).connect(this.ctx.destination);

    try {
      node.port.postMessage({ cmd: 'record', on: true, trimFrames: 0 });
      this.startRecording(0, { toMemory: true, preroll: false });
      await delay(seconds * 1000);
      const raw = await this.stopRecording();
      const done = new Promise(r => { endResolve = r; });
      node.port.postMessage({ cmd: 'record', on: false });
      await Promise.race([done, delay(1000)]);
      const graph = concat(chunks);
      return comparePaths(raw.samples, graph, raw.channels, this.ctx.sampleRate);
    } finally {
      try { node.disconnect(); } catch { }
      try { sink.disconnect(); } catch { }
    }
  }

  /**
   * 測定用：モノの信号を出力へ流し、その間の入力を取り込む（スイープ・テスト音）。
   * モニターは切る（ハウリングと二重取りを避ける）。返すのは取り込み（インターリーブ）。
   */
  async playAndCapture(signal, { extraSeconds = 1.5, amp = 1 } = {}) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) throw new Error('録音中は測定できません。');
    this.stopPlayback();
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, signal.length, rate);
    buffer.getChannelData(0).set(signal);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain(); g.gain.value = amp;
    src.connect(g).connect(this.masterGain);
    const monitorWas = this.monitorEnabled;
    this.setMonitor(false);
    try {
      const capture = this.captureForAnalysis(signal.length / rate + extraSeconds);
      src.start(this.ctx.currentTime + 0.1);
      const cap = await capture;
      return cap;
    } finally {
      try { src.stop(); } catch { }
      try { src.disconnect(); } catch { }
      this.setMonitor(monitorWas);
    }
  }

  /* ---------------- ズレ合わせ（レイテンシ測定） ---------------- */

  _startTap() {
    this._tapChunks = [];
    this._tapWant = 0;
    this._sendCapture({ cmd: 'tap', on: true }); // ここで受け皿も 0 に戻る
  }

  _stopTap() {
    this._sendCapture({ cmd: 'tap', on: false });
    const frames = concat(this._tapChunks || []);
    this._tapChunks = null;
    return frames;
  }

  _makeClick(continuous) {
    const rate = this.ctx.sampleRate;
    const burst = Math.round(rate / 100); // 10ms
    const len = continuous ? rate * 6 : burst;
    const buffer = this.ctx.createBuffer(1, len, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (continuous) {
        data[i] = 0.5 * Math.sin(2 * Math.PI * CLICK_FREQUENCY * i / rate);
      } else {
        // 端で切れるとブツッというノイズになるので窓をかける
        const env = Math.sin(Math.PI * i / burst);
        data[i] = 0.9 * env * Math.sin(2 * Math.PI * CLICK_FREQUENCY * i / rate);
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!continuous;
    return src;
  }

  /**
   * テスト音を出して、それが録音側に返ってくるまでのフレーム数を測る。
   * 出力遅延＋空気/ケーブル＋入力遅延の合計＝重ね録りで削るべき量そのもの。
   *
   * 単純なピーク検出だと物音を誤検出するので、
   *   (1) テスト音と同じ 1kHz の成分だけを見る整合フィルタ
   *   (2) 複数回測って値が一致したときだけ採用する
   * の二段構えにしている。一致しなければ「測れなかった」と正直に返す。
   */
  async measureRoundTrip(trials = 3, timeoutMs = 1200) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) throw new Error('録音中は測定できません。');

    const rate = this.recordRate;
    const results = [];
    const detail = [];
    let bestPeak = 0, bestNoise = 0;

    const monitorWas = this.monitorEnabled;
    this.setMonitor(false);

    try {
      for (let t = 0; t < trials; t++) {
        const one = await this._measureOnce(timeoutMs);
        bestPeak = Math.max(bestPeak, one.peak);
        bestNoise = Math.max(bestNoise, one.noise);
        detail.push(one.frames >= 0 ? `${(1000 * one.frames / rate).toFixed(1)}ms` : '検出なし');
        if (one.frames >= 0) results.push(one.frames);
        await delay(120);
      }
    } finally {
      this.setMonitor(monitorWas);
    }

    const detailText = '各回: ' + detail.join(' / ');
    // 2回以上が 10ms 以内で一致していれば本物とみなす
    const tolerance = rate / 100;
    for (const candidate of results.slice().sort((a, b) => a - b)) {
      const agree = results.filter(x => Math.abs(x - candidate) <= tolerance).sort((a, b) => a - b);
      if (agree.length >= 2) {
        return { frames: agree[agree.length >> 1], peak: bestPeak, noise: bestNoise, detail: detailText, ok: true };
      }
    }
    return { frames: -1, peak: bestPeak, noise: bestNoise, detail: detailText, ok: false };
  }

  async _measureOnce(timeoutMs) {
    this.stopPlayback();
    const rate = this.recordRate;

    this._startTap();
    const click = this._makeClick(false);
    click.connect(this.masterGain);
    // 基準点を揃える：受け皿を 0 に戻した直後に鳴らす
    click.start();

    await delay(timeoutMs);
    const frames = this._stopTap();
    try { click.disconnect(); } catch { }

    return findClick(frames, rate);
  }

  /**
   * ブラウザの音声補正（ノイズ抑制）が入力を加工していないかを調べる。
   *
   * 音を鳴らしている間と、静かにしてしばらく経ったあとのレベルを比べる。
   * 素の入力なら、暗騒音は鳴らしていた音より 20〜40 dB 低い程度に収まる。
   * 60 dB 以上も落ちるなら、静かな間だけ潰す仕組みが働いている。
   */
  async checkInputProcessing(onStep) {
    if (!this.isOpen) throw new Error('先に音の入り口を開いてください。');
    if (this.isRecording) throw new Error('録音中は検査できません。');

    const monitorWas = this.monitorEnabled;
    this.setMonitor(false);

    let loud = 0, quiet = 0;
    const tone = this._makeClick(true);
    try {
      onStep && onStep('テスト音を鳴らしています…');
      tone.connect(this.masterGain);
      tone.start();
      await delay(700);                             // 補正が開くのを待つ
      loud = rms((await this.captureForAnalysis(1.5)).samples);
      try { tone.stop(); } catch { }
      try { tone.disconnect(); } catch { }

      onStep && onStep('静かにしたあとを測っています…');
      await delay(2500);
      quiet = rms((await this.captureForAnalysis(2.0)).samples);
    } finally {
      try { tone.stop(); } catch { }
      try { tone.disconnect(); } catch { }
      this.setMonitor(monitorWas);
    }

    const loudDb = loud > 0 ? 20 * Math.log10(loud) : -200;
    const quietDb = quiet > 0 ? 20 * Math.log10(quiet) : -200;
    const drop = loudDb - quietDb;

    // 判定は「鳴らしたときと静かなときの差」で行う。
    // 出力の音量が小さくてもテスト音が届いていれば差ははっきり出るので、
    // 絶対レベルでテスト音の有無を決めてはいけない。
    if (drop > 60) {
      return { verdict: 'gated', loudDb, quietDb, drop,
        detail: `音を止めると ${drop.toFixed(0)} dB も落ちます。静かな間だけ入力を潰す処理が入っています。` };
    }
    if (drop < 10 && loudDb < -90) {
      return { verdict: 'undetermined', loudDb, quietDb, drop,
        detail: 'テスト音を拾えませんでした。出力の音量を上げるか、マイクに近づけてもう一度試してください。' };
    }
    return { verdict: 'clean', loudDb, quietDb, drop,
      detail: `音を止めたときの差は ${drop.toFixed(0)} dB。素の入力が届いていると考えられます。` };
  }
}

/* ---------------- 1kHz 成分の立ち上がりを探す ---------------- */
/*
   物音は帯域が広いので、この帯域だけ見ると誤検出が大きく減る。
   デスクトップ版 FindClick と同じ（ゲルツェル法の整合フィルタ）。
*/
function findClick(frames, rate) {
  const window = Math.round(rate / 100);            // 10ms（テスト音の長さと同じ）
  const step = Math.max(1, Math.round(rate / 6000)); // 約0.17ms刻み
  const skip = Math.min(Math.max(0, frames.length - 1), Math.round(rate / 500));

  if (frames.length < skip + window + step) return { frames: -1, peak: 0, noise: 0 };

  const w = 2 * Math.PI * CLICK_FREQUENCY / rate;
  const coeff = 2 * Math.cos(w);
  const count = Math.floor((frames.length - window - skip) / step);
  const env = new Float64Array(count);

  for (let k = 0; k < count; k++) {
    const start = skip + k * step;
    let s1 = 0, s2 = 0;
    for (let n = 0; n < window; n++) {
      const s0 = frames[start + n] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    env[k] = 2 * Math.sqrt(Math.max(0, power)) / window;
  }

  const sorted = Array.from(env).sort((a, b) => a - b);
  const noise = sorted[sorted.length >> 1];

  let peak = 0, peakIndex = -1;
  for (let k = 0; k < count; k++) if (env[k] > peak) { peak = env[k]; peakIndex = k; }

  // 判定の主軸は「1kHz 帯で暗騒音より桁違いに大きいか」。
  // 誤検出は複数回の一致判定でふるい落とす。
  if (peakIndex < 0 || peak < 0.0003 || peak < noise * 10) return { frames: -1, peak, noise };

  const threshold = Math.max(peak * 0.35, noise * 5);
  for (let k = 0; k <= peakIndex; k++) {
    if (env[k] >= threshold) return { frames: skip + k * step, peak, noise };
  }
  return { frames: skip + peakIndex * step, peak, noise };
}

/* ---------------- 2つの道を揃えて比べる ---------------- */
/*
   2つの取り込みは同じ音を見ているが、始めた瞬間が少し違う。
   モノラルに畳んで相互相関で時間差を探し（±0.5 秒）、揃えてから
   最小二乗で音量差を出し、残った差を dB で出す。
*/
function comparePaths(a, b, channels, rate) {
  const mono = (x) => {
    const n = Math.floor(x.length / channels);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < channels; c++) v += x[i * channels + c]; m[i] = v / channels; }
    return m;
  };
  const A = mono(a), B = mono(b);
  const n = Math.min(A.length, B.length);
  if (n < rate * 0.5) return { available: true, ok: false, reason: '比べるには短すぎます。' };
  let ea = 0, eb = 0;
  for (let i = 0; i < n; i++) { ea += A[i] * A[i]; eb += B[i] * B[i]; }
  if (ea < 1e-9 || eb < 1e-9) return { available: true, ok: false, reason: '音が入っていません。音を出しながら検証してください。' };

  // 粗く（8 サンプル刻み）探してから、細かく詰める。
  // 楽音は周期的なので相関の山が周期ごとに並ぶ。山の高さだけで選ばず、
  // 高い山の候補それぞれで「揃えたあとの残差」を出し、いちばん小さいものを採る
  // （本当に同じ音なら、正しいずれで残差は 0 になる）。
  const maxLag = Math.round(rate * 0.15);
  const win = Math.min(n - maxLag, rate);          // 比べる長さ 1 秒
  const from = maxLag;
  const score = (lag, step) => {
    let acc = 0;
    for (let i = from; i < from + win; i += step) acc += A[i] * B[i + lag];
    return acc;
  };
  const coarse = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 8) coarse.push([lag, score(lag, 16)]);
  const top = Math.max(...coarse.map(c => c[1]));
  const cands = new Set();
  for (const [lag, v] of coarse) if (v >= top * 0.97) for (let l = lag - 8; l <= lag + 8; l++) if (l >= -maxLag && l <= maxLag) cands.add(l);
  const residualAt = (lag) => {
    let ab = 0, bb = 0;
    for (let i = from; i < from + win; i++) { ab += A[i] * B[i + lag]; bb += B[i + lag] * B[i + lag]; }
    const g = bb > 0 ? ab / bb : 0;
    let rr = 0;
    for (let i = from; i < from + win; i++) { const d = A[i] - g * B[i + lag]; rr += d * d; }
    return rr;
  };
  let fine = 0, bestRr = Infinity;
  for (const lag of cands) { const rr = residualAt(lag); if (rr < bestRr || (rr === bestRr && Math.abs(lag) < Math.abs(fine))) { bestRr = rr; fine = lag; } }

  // 揃えて、A ≒ g·B の g と残差
  let ab = 0, bb = 0;
  for (let i = from; i < from + win; i++) { ab += A[i] * B[i + fine]; bb += B[i + fine] * B[i + fine]; }
  const g = bb > 0 ? ab / bb : 0;
  let rr = 0, aa = 0, maxDiff = 0;
  for (let i = from; i < from + win; i++) {
    const d = A[i] - g * B[i + fine];
    rr += d * d; aa += A[i] * A[i];
    if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
  }
  const residualDb = aa > 0 && rr > 0 ? 10 * Math.log10(rr / aa) : -Infinity;
  const gainDb = g > 0 ? 20 * Math.log10(g) : NaN;
  const identical = maxDiff < 1e-6 && Math.abs(gainDb) < 0.001;
  return {
    available: true, ok: true, identical, lagFrames: fine, lagMs: fine / rate * 1000,
    gainDb, residualDb, maxDiff,
  };
}

/* ---------------- 小物 ---------------- */

export function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export const delay = (ms) => new Promise(r => setTimeout(r, ms));

function rms(x) {
  if (!x || x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

function describeGumError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError') return 'マイクの使用が許可されていません。アドレスバーの錠前から許可してください。';
  if (n === 'NotFoundError') return '音の入り口が見つかりません。マイクを挿してから「機器を探し直す」を押してください。';
  if (n === 'NotReadableError') return 'その機器を他のアプリが使っています。閉じてからもう一度試してください。';
  if (n === 'OverconstrainedError') return 'その細かさ（サンプルレート・チャンネル数）では開けませんでした。別の値を選んでください。';
  if (location.protocol === 'file:') return 'file:// では音の入り口を開けません。付属の serve.js で開いてください。';
  return 'マイクを開けませんでした: ' + (e && e.message ? e.message : String(e));
}
