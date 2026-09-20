/*
  Tonmeister — 脇の録りの「揃え」。capture-worker.js の中で動く純粋な部品（DOM も Worker API も触らない）。

  マイクの札（AudioData）と脇の札は同じ時計（timestamp, µs）で来る。
    ・StreamClock：ストリームの「0 フレーム目の時刻」を推定する。届く遅れは足される方向にしか揺れないので、
      ts − 累計フレーム/レート の最小がいちばん原点に近い。ずっと更新し続ける
    ・SideCutter：脇の札を溜め、本線の「開始した時刻」「止めた時刻」を受けて、同じ時刻の標本から切り出す。
      抜けた札は無音で埋めて時計を保つ。切り出した音は post({type:'side-data', ...}) で外へ
  selftest.html で、既知の 2 本の札の列から差 0 で切り出せることを確かめている。
*/

export class StreamClock {
  constructor() { this.off = null; this.count = 0; }
  /** 札が届いたら呼ぶ。framesBefore はこの札より前の累計フレーム。 */
  feed(ts, framesBefore, rate) {
    const cand = ts - framesBefore / rate * 1e6;
    this.off = this.off == null ? cand : Math.min(this.off, cand);
    this.count++;
  }
  /** フレーム番号 → 時刻（µs）。時計がまだ無ければ null。 */
  timeOf(frames, rate) { return this.off == null ? null : this.off + frames / rate * 1e6; }
  /** 時刻（µs）→ フレーム番号。 */
  frameAt(tUs, rate) { return Math.round((tUs - this.off) * rate / 1e6); }
  reset() { this.off = null; this.count = 0; }
}

export class SideCutter {
  /**
   * @param post   (message, transfer) => void
   * @param opts   { blockFrames, ringFrames }
   */
  constructor(post, opts = {}) {
    this.post = post;
    this.blockFrames = opts.blockFrames || 4096;
    this.ringMax = opts.ringFrames || 120;      // 溜めておく札の数（10 ms 刻みなら約 1.2 秒）
    this.rate = 0;
    this.reset();
  }

  reset() {
    this.frames = 0;
    this.clock = new StreamClock();
    this.ring = [];
    this.recording = false;
    this.startIdx = 0;
    this.stopIdx = Infinity;
    this.pendingStart = null;
    this.buf = null;
    this.filled = 0;
    this.errs = [];           // 直近の「札の時刻 − 時計の言う時刻」（µs）。抜けの検出に使う
    this.slow = null; this.seen = 0;
  }

  /**
   * 札を入れる。samples はモノラル（Float32Array）、ts は µs か null。
   * 抜けが見つかれば無音で埋め、録っている最中なら切り出す。
   */
  feed(samples, ts, rate) {
    const n = samples.length;
    if (this.rate !== rate) { const keep = this.pendingStart; this.rate = rate; this.reset(); this.pendingStart = keep; }
    if (typeof ts === 'number') {
      const frameUs = n / rate * 1e6;
      if (this.clock.off != null) {
        // 抜けた札。timestamp は 1 枚ごとに ±数 ms 揺れる（札 1 枚と同じくらい）ので、1 枚では判断できない。
        // 「直近 20 枚の遅れの平均」が「それまでの平均（ゆっくり追う）」より半枚以上大きくなったら、その差ぶんの札が抜けている。
        // 揺れの平均は 20 枚で 1 ms 程度に落ちるので、半枚（5 ms）の段差は見誤らない。見つかるのは約 200 ms 遅れ
        const err = ts - this.clock.timeOf(this.frames, rate);
        this.errs.push(err); if (this.errs.length > 20) this.errs.shift();
        if (this.slow == null) this.slow = err; else this.slow += (err - this.slow) * 0.02;
        this.seen = (this.seen || 0) + 1;
        if (this.seen >= 40 && this.errs.length === 20) {
          const fast = this.errs.reduce((x, y) => x + y, 0) / this.errs.length;
          const jump = fast - this.slow;
          if (jump > 0.5 * frameUs) {
            const gap = Math.min(Math.round(jump / frameUs) * n, rate * 2);   // 抜けるのは札の単位
            this._push({ start: this.frames, samples: new Float32Array(gap) });
            this.frames += gap;
            this.errs = [];
          } else if (jump < -0.5 * frameUs) {
            this.clock.reset(); this.errs = []; this.slow = null; this.seen = 0;   // 早く届きすぎ＝時計が飛んだ。測り直す
          }
        }
      }
      this.clock.feed(ts, this.frames, rate);
      if (this.pendingStart != null && this.clock.off != null) this.begin(this.pendingStart);
    }
    this._push({ start: this.frames, samples });
    this.frames += n;
    if (this.recording && this.frames >= this.stopIdx) this._finish();
  }

  /** 本線がこの時刻（µs）のフレームから録り始めた。 */
  begin(tUs) {
    if (tUs == null) { this.recording = false; return; }
    if (this.clock.off == null) { this.pendingStart = tUs; return; }   // 繋いだ直後：最初の札を待つ
    this.pendingStart = null;
    this.startIdx = this.clock.frameAt(tUs, this.rate);
    this.stopIdx = Infinity;
    this.recording = true;
    this.filled = 0;
    if (!this.buf) this.buf = new Float32Array(this.blockFrames);
    for (const f of this.ring) this._take(f);
    this.ring = [];
  }

  /** 本線がこの時刻（µs）のフレームで止めた。 */
  end(tUs) {
    if (this.pendingStart != null) { this.pendingStart = null; this.post({ type: 'side-data', end: true, sampleRate: this.rate }); return; }
    if (!this.recording) return;
    this.stopIdx = tUs == null ? this.frames : this.clock.frameAt(tUs, this.rate);
    if (this.frames >= this.stopIdx) this._finish();
  }

  /** 入口が閉じた。録っている最中なら切り上げる。 */
  close() { if (this.recording) this._finish(); }

  _push(f) {
    if (this.recording) this._take(f);
    else { this.ring.push(f); while (this.ring.length > this.ringMax) this.ring.shift(); }
  }

  _take(f) {
    const a = Math.max(f.start, this.startIdx), b = Math.min(f.start + f.samples.length, this.stopIdx);
    if (b <= a) return;
    const seg = f.samples.subarray(a - f.start, b - f.start);
    let p = 0;
    while (p < seg.length) {
      const room = this.buf.length - this.filled;
      const k = Math.min(room, seg.length - p);
      this.buf.set(seg.subarray(p, p + k), this.filled);
      this.filled += k; p += k;
      if (this.filled >= this.buf.length) this._flush(false);
    }
  }

  _finish() { this.recording = false; this._flush(true); }

  _flush(final) {
    if (this.filled > 0) {
      const out = this.buf.slice(0, this.filled);
      this.filled = 0;
      this.post({ type: 'side-data', samples: out, frames: out.length, channels: 1, sampleRate: this.rate, end: false }, [out.buffer]);
    }
    if (final) this.post({ type: 'side-data', end: true, sampleRate: this.rate });
  }
}
