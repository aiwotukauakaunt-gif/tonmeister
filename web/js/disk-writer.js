/*
  録りながら、自分のフォルダにも WAV を書く（File System Access API）。
  OPFS の受け皿が主で、こちらは鏡。ブラウザが落ちても、ディスクに本物の WAV が残るために。

  Chrome の書き込みストリームは close() するまで本物のファイルに反映されない
  （途中で落ちると一時ファイルごと消える）。だから 20 秒ごとに区切って部分ファイルを閉じる。
  部分ファイルはそれぞれ正しいヘッダを持つ WAV なので、そのままでも開ける。
  止めたときに1本にまとめ、部分ファイルは消す。まとめる前に落ちていたら、次に開いたとき拾って繋ぐ。

    <フォルダ>/<セッション名>/<recId>_part001.wav …  書いている途中の部分
    <フォルダ>/<セッション名>/<名前>_32f.wav              止めたあとの1本
*/

import { encodeWav, decodeWav, SaveFormat } from './wav.js';

const HEADER = 44;

function wavHeader(dataBytes, channels, rate) {
  const b = new ArrayBuffer(HEADER);
  const v = new DataView(b);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 4, true); v.setUint16(32, channels * 4, true); v.setUint16(34, 32, true);
  w(36, 'data'); v.setUint32(40, dataBytes, true);
  return b;
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');

export class DiskMirror {
  /**
   * @param dir          FileSystemDirectoryHandle（書き込み許可済み）
   * @param sessionName  サブフォルダの名前
   */
  constructor(dir, sessionName, { partSeconds = 20 } = {}) {
    this.dir = dir;
    this.sessionName = safeName(sessionName);
    this.partSeconds = partSeconds;
    this.sub = null;
    this.recId = null;
    this.channels = 2; this.rate = 48000;
    this.part = 0;
    this.writable = null;
    this.partBytes = 0;
    this.partFrames = 0;
    this.parts = [];
    this.queue = Promise.resolve();
  }

  async _subdir() {
    if (!this.sub) this.sub = await this.dir.getDirectoryHandle(this.sessionName, { create: true });
    return this.sub;
  }

  _partName(n) { return `${this.recId}_part${String(n).padStart(3, '0')}.wav`; }

  begin(recId, channels, rate) {
    this.recId = recId; this.channels = channels; this.rate = rate;
    this.part = 0; this.parts = [];
    this.queue = this.queue.then(() => this._openPart());
    return this.queue;
  }

  async _openPart() {
    const sub = await this._subdir();
    this.part++;
    const fh = await sub.getFileHandle(this._partName(this.part), { create: true });
    this.writable = await fh.createWritable({ keepExistingData: false });
    await this.writable.write(wavHeader(0, this.channels, this.rate));   // 仮のヘッダ。閉じるときに書き直す
    this.partBytes = 0;
    this.partFrames = 0;
  }

  async _closePart() {
    if (!this.writable) return;
    const w = this.writable;
    this.writable = null;
    await w.write({ type: 'write', position: 0, data: wavHeader(this.partBytes, this.channels, this.rate) });
    await w.close();
    this.parts.push({ name: this._partName(this.part), frames: this.partFrames });
  }

  append(samples) {
    this.queue = this.queue.then(async () => {
      if (!this.writable) return;
      const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
      await this.writable.write(bytes);
      this.partBytes += bytes.byteLength;
      this.partFrames += samples.length / this.channels;
      if (this.partFrames >= this.partSeconds * this.rate) { await this._closePart(); await this._openPart(); }
    });
    return this.queue;
  }

  end() {
    this.queue = this.queue.then(() => this._closePart());
    return this.queue;
  }

  /** 止めたあと：1本の WAV にまとめ、部分ファイルを消す。 */
  async finish(result, baseName) {
    await this.queue;
    const sub = await this._subdir();
    const written = [];
    const list = result.parts && result.parts.length ? result.parts : [result];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.frames) continue;
      const name = `${safeName(baseName || this.recId)}${list.length > 1 ? `_${i + 1}` : ''}_32f.wav`;
      const fh = await sub.getFileHandle(name, { create: true });
      const w = await fh.createWritable({ keepExistingData: false });
      await w.write(encodeWav(a.samples, a.channels, a.sampleRate, SaveFormat.Float32));
      await w.close();
      written.push(name);
    }
    for (const p of this.parts) { try { await sub.removeEntry(p.name); } catch { } }
    this.parts = [];
    return written;
  }

  /**
   * 前回まとめる前に落ちた部分ファイルを探して1本に繋ぐ。
   * 部分ファイルはそれぞれ正しい WAV なので、順に読んで足すだけ。
   * @returns [{ folder, name, seconds }]
   */
  static async joinOrphans(dir) {
    const joined = [];
    for await (const [folderName, h] of dir.entries()) {
      if (h.kind !== 'directory') continue;
      const groups = new Map();
      for await (const [name, fh] of h.entries()) {
        const m = /^(rec_[a-z0-9]+)_part(\d{3})\.wav$/.exec(name);
        if (!m || fh.kind !== 'file') continue;
        const g = groups.get(m[1]) || [];
        g.push({ n: +m[2], name, fh });
        groups.set(m[1], g);
      }
      for (const [recId, parts] of groups) {
        parts.sort((a, b) => a.n - b.n);
        const chunks = [];
        let channels = 0, rate = 0, frames = 0;
        for (const p of parts) {
          try {
            const buf = await (await p.fh.getFile()).arrayBuffer();
            if (buf.byteLength <= HEADER) continue;
            const a = decodeWav(buf);
            channels = a.channels; rate = a.sampleRate; frames += a.frames;
            chunks.push(a.samples);
          } catch { }
        }
        if (!frames) continue;
        let total = 0;
        for (const c of chunks) total += c.length;
        const all = new Float32Array(total);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        const name = `${recId}_復元_32f.wav`;
        const out = await h.getFileHandle(name, { create: true });
        const w = await out.createWritable({ keepExistingData: false });
        await w.write(encodeWav(all, channels, rate, SaveFormat.Float32));
        await w.close();
        for (const p of parts) { try { await h.removeEntry(p.name); } catch { } }
        joined.push({ folder: folderName, name, seconds: frames / rate, samples: all, channels, sampleRate: rate, frames });
      }
    }
    return joined;
  }
}
