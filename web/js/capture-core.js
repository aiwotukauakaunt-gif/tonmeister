/*
  入力の取り込みの芯。オーディオスレッド（AudioWorklet）と、生フレーム取得の Worker の
  両方から同じものを使う。どちらの道で音が届いても、測り方と渡し方が同じになるように。

  やること
    ・メーター用のピーク（サンプルピーク）と True Peak（4倍オーバーサンプル）
    ・割れの検出。「1.0 に達した」だけでなく、その手前で頭が平らになった波も数える
      （プリアンプや ADC の手前で歪んだ音は 0 dBFS に届かないまま割れている）
    ・録音中は生のサンプルをそのままブロックにまとめて渡す。加工はしない
    ・録音の頭から trim フレームぶんを捨てる（重ね録りのズレ合わせ）
    ・押す前の音も残す（プリロール）。録音していない間も直近の音を輪っかで持ち、
      録音を押した瞬間にその前の数秒を先頭に付ける
    ・録るチャンネルを選ぶ（多入力の機材で 3-4 ch だけ、など）
    ・ズレ合わせ測定用の覗き穴（tap）

  この中では一切ファイルに触らない。外へ postMessage で渡すだけ。
*/

/* ---------------- True Peak（ITU-R BS.1770 の考え方） ----------------
   サンプルとサンプルの間で 0 dBFS を超える波は、サンプル値だけ見ると割れていないように見える。
   4倍に補間して間の値を推定する。窓付き sinc の 12 タップ × 3 位相（位相 0 は元の値そのもの）。 */
const TP_TAPS = 12;
const TP_HALF = TP_TAPS / 2;
const TP_PHASES = [0.25, 0.5, 0.75].map(f => {
  const c = new Float32Array(TP_TAPS);
  let sum = 0;
  for (let k = -TP_HALF + 1; k <= TP_HALF; k++) {
    const x = k - f;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 * (1 + Math.cos(Math.PI * x / TP_HALF));   // ハン窓
    c[k + TP_HALF - 1] = sinc * w;
    sum += sinc * w;
  }
  for (let i = 0; i < TP_TAPS; i++) c[i] /= sum;
  return c;
});

/* 頭が平らになった波の判定。この振幅以上で、この幅以下の揺れが、この長さ続いたら1回と数える */
const FLAT_LEVEL = 0.97;
const FLAT_SPREAD = 0.002;
const FLAT_RUN = 4;

export class CaptureCore {
  /**
   * @param post   (message, transferList) => void
   * @param opts   { channels, blockFrames, tapFrames }
   */
  constructor(post, opts = {}) {
    this.post = post;
    this.blockFrames = opts.blockFrames || 4096;
    this.tapFrames = opts.tapFrames || 1024;
    this.reportEvery = opts.reportEvery || 1024;

    this.recording = false;
    this.tapping = false;
    this.trimRemaining = 0;
    this.sinceReport = 0;
    this.totalFrames = 0;
    this.recordMap = null;          // 録るチャンネル（入力の番号の配列）。null なら全部
    this.prerollCapacity = 0;       // 輪っかの大きさ（フレーム）

    this.tapBuf = new Float32Array(this.tapFrames);
    this.tapFilled = 0;

    this.setChannels(opts.channels || 1);
  }

  setChannels(n) {
    if (n <= 0) return;
    this.channels = n;
    this.peaks = new Float32Array(n);
    this.truePeaks = new Float32Array(n);
    this.clips = new Int32Array(n);
    this.flats = new Int32Array(n);
    this.buf = new Float32Array(this.blockFrames * n);
    this.filled = 0;
    this.recordMap = null;
    this._allocRing();
    // True Peak 用の直近サンプル（各 ch）と、平らな頭を追う状態
    this.hist = [];
    this.flatRun = new Int32Array(n);
    this.flatMin = new Float32Array(n);
    this.flatMax = new Float32Array(n);
    this.warm = new Int32Array(n);      // 補間の履歴が埋まるまでの残り。埋まる前は間の値を見ない（無から段差が立つのは偽の山）
    for (let c = 0; c < n; c++) { this.hist.push(new Float32Array(TP_TAPS)); this.warm[c] = TP_TAPS; }
  }

  _allocRing() {
    const n = this.recordMap ? this.recordMap.length : this.channels;
    this.ringChannels = n;
    this.ring = this.prerollCapacity > 0 ? new Float32Array(this.prerollCapacity * n) : null;
    this.ringWrite = 0;
    this.ringFilled = 0;
  }

  /** 録音に使うチャンネルの番号（入力の並び）。 */
  get recordChannels() { return this.recordMap ? this.recordMap.length : this.channels; }

  command(m) {
    if (m.cmd === 'record') {
      if (m.on) {
        this.trimRemaining = m.trimFrames | 0;
        this.filled = 0;
        this.recording = true;
        // 押す前の音：ズレ合わせで頭を捨てる録り（重ね録り）には付けない。基準点が動いてしまうため
        let prerolled = 0;
        if (m.preroll && this.ring && this.ringFilled > 0 && this.trimRemaining === 0) {
          prerolled = this._emitRing(Math.min(this.ringFilled, m.prerollFrames | 0 || this.ringFilled));
        }
        this.post({ type: 'started', prerolledFrames: prerolled, channels: this.recordChannels, totalFrames: this.totalFrames });
      } else {
        this.recording = false;
        this.flush(true);
      }
    } else if (m.cmd === 'preroll') {
      this.prerollCapacity = Math.max(0, m.frames | 0);
      this._allocRing();
    } else if (m.cmd === 'channels-map') {
      const map = Array.isArray(m.map) && m.map.length ? m.map.filter(i => i >= 0 && i < this.channels) : null;
      this.recordMap = map && map.length ? map : null;
      this.buf = new Float32Array(this.blockFrames * this.recordChannels);
      this.filled = 0;
      this._allocRing();
    } else if (m.cmd === 'tap') {
      this.tapping = !!m.on;
      this.tapFilled = 0;
    } else if (m.cmd === 'channels') {
      this.setChannels(m.channels | 0);
    }
  }

  flush(final) {
    const rc = this.recordChannels;
    if (this.filled === 0) {
      if (final) this.post({ type: 'data', end: true });
      return;
    }
    const out = this.buf.slice(0, this.filled * rc);
    this.post({ type: 'data', samples: out, frames: this.filled, channels: rc, end: !!final }, [out.buffer]);
    this.filled = 0;
  }

  /** 輪っかの中身（古い順）を録音の先頭として渡す。 */
  _emitRing(frames) {
    const n = this.ringChannels;
    const cap = this.prerollCapacity;
    const out = new Float32Array(frames * n);
    let start = (this.ringWrite - frames + cap) % cap;
    for (let i = 0; i < frames; i++) {
      const src = ((start + i) % cap) * n;
      out.set(this.ring.subarray(src, src + n), i * n);
    }
    this.post({ type: 'data', samples: out, frames, channels: n, end: false, preroll: true }, [out.buffer]);
    this.ringFilled = 0;
    return frames;
  }

  flushTap() {
    if (this.tapFilled === 0) return;
    const out = this.tapBuf.slice(0, this.tapFilled);
    this.post({ type: 'tap', frames: out }, [out.buffer]);
    this.tapFilled = 0;
  }

  /**
   * チャンネルごとの Float32Array（プレーナ）を1ブロック受け取る。
   * @param planes  Float32Array[]（長さ = channels）
   * @param frames  このブロックのフレーム数
   * @param extra   便りに添える追加情報（生フレーム取得の Worker がレート等を添える）
   */
  push(planes, frames, extra) {
    const ch = planes.length;
    if (ch === 0 || frames === 0) return;
    if (ch !== this.channels) this.setChannels(ch);

    this.totalFrames += frames;

    // メーターと割れの検出（録音していなくても常に）
    for (let c = 0; c < ch; c++) this._meter(planes[c], frames, c);

    this.sinceReport += frames;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      const msg = {
        type: 'peaks',
        peaks: Array.from(this.peaks),
        truePeaks: Array.from(this.truePeaks),
        clips: Array.from(this.clips),
        flats: Array.from(this.flats),
        totalFrames: this.totalFrames,
      };
      if (extra) Object.assign(msg, extra);
      this.post(msg);
      this.peaks.fill(0);
      this.truePeaks.fill(0);
    }

    // 測定用の覗き穴（1ch にまとめる）
    if (this.tapping) {
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += planes[c][i];
        this.tapBuf[this.tapFilled++] = v / ch;
        if (this.tapFilled >= this.tapBuf.length) this.flushTap();
      }
    }

    const map = this.recordMap;
    const rc = this.recordChannels;

    if (!this.recording) {
      // 押す前の音を輪っかに入れておく
      if (this.ring) {
        const cap = this.prerollCapacity;
        for (let i = 0; i < frames; i++) {
          const base = this.ringWrite * rc;
          for (let k = 0; k < rc; k++) this.ring[base + k] = planes[map ? map[k] : k][i];
          this.ringWrite = (this.ringWrite + 1) % cap;
          if (this.ringFilled < cap) this.ringFilled++;
        }
      }
      return;
    }

    // 頭を捨てる（出力遅延＋入力遅延ぶん）
    let start = 0;
    if (this.trimRemaining > 0) {
      const skip = Math.min(this.trimRemaining, frames);
      this.trimRemaining -= skip;
      start = skip;
      if (start >= frames) return;
    }

    for (let i = start; i < frames; i++) {
      const base = this.filled * rc;
      for (let k = 0; k < rc; k++) this.buf[base + k] = planes[map ? map[k] : k][i];
      this.filled++;
      if (this.filled >= this.blockFrames) this.flush(false);
    }
  }

  /** 落ちたフレームのぶんを無音で埋める（時間の長さを保つ。落ちた事実は別に知らせる）。 */
  pushSilence(frames) {
    if (frames <= 0) return;
    const rc = this.recordChannels;
    this.totalFrames += frames;
    if (!this.recording) return;
    for (let i = 0; i < frames; i++) {
      const base = this.filled * rc;
      for (let k = 0; k < rc; k++) this.buf[base + k] = 0;
      this.filled++;
      if (this.filled >= this.blockFrames) this.flush(false);
    }
  }

  _meter(data, frames, c) {
    let peak = this.peaks[c];
    let tpeak = this.truePeaks[c];
    let clip = this.clips[c];
    let flat = this.flats[c];
    let run = this.flatRun[c], fmin = this.flatMin[c], fmax = this.flatMax[c];
    const h = this.hist[c];
    let warm = this.warm[c];

    for (let i = 0; i < frames; i++) {
      const v = data[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 1) clip++;

      // 平らな頭：大きい値がほとんど動かずに続く
      if (a >= FLAT_LEVEL) {
        if (run === 0) { fmin = fmax = a; }
        else { if (a < fmin) fmin = a; if (a > fmax) fmax = a; }
        run++;
        if (fmax - fmin > FLAT_SPREAD) { run = 1; fmin = fmax = a; }   // 揺れている＝平らではない。ここから数え直す
        else if (run === FLAT_RUN) flat++;
      } else {
        run = 0;
      }

      // True Peak：直近 12 サンプルの間を補間する
      h.copyWithin(0, 1);
      h[TP_TAPS - 1] = v;
      if (warm > 0) { warm--; continue; }
      for (let p = 0; p < 3; p++) {
        const coef = TP_PHASES[p];
        let y = 0;
        for (let k = 0; k < TP_TAPS; k++) y += h[k] * coef[k];
        const ay = Math.abs(y);
        if (ay > tpeak) tpeak = ay;
      }
    }
    if (peak > tpeak) tpeak = peak;

    this.peaks[c] = peak;
    this.truePeaks[c] = tpeak;
    this.clips[c] = clip;
    this.flats[c] = flat;
    this.flatRun[c] = run; this.flatMin[c] = fmin; this.flatMax[c] = fmax;
    this.warm[c] = warm;
  }
}

/** 録音済みの音（インターリーブ）の True Peak を出す。書き出し前の「割れるか」に使う。 */
export function truePeakOf(samples, channels) {
  const core = new CaptureCore(() => { }, { channels, reportEvery: 1 << 30 });
  const frames = Math.floor(samples.length / channels);
  const planes = [];
  for (let c = 0; c < channels; c++) {
    const p = new Float32Array(frames);
    for (let i = 0; i < frames; i++) p[i] = samples[i * channels + c];
    planes.push(p);
  }
  core.push(planes, frames);
  let tp = 0, sp = 0;
  for (let c = 0; c < channels; c++) {
    if (core.truePeaks[c] > tp) tp = core.truePeaks[c];
    if (core.peaks[c] > sp) sp = core.peaks[c];
  }
  let flats = 0;
  for (let c = 0; c < channels; c++) flats += core.flats[c];
  return { truePeak: tp, samplePeak: sp, flats };
}
