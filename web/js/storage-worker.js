/*
  録音中の受け皿（OPFS 版）。
  Origin Private File System に「録音1本＝ファイル1つ」で追記していく。
  同期アクセスハンドル（createSyncAccessHandle）は Worker の中でしか使えないので、
  ここが専用の書き込み係になる。デスクトップ版の「専用スレッドでファイル I/O」にあたる。

  IndexedDB に 2 秒ごとに塊を入れる方式に比べて
    ・GC や他のトランザクションと競合しない
    ・GB 級でも一定の速さで書ける
    ・途中でタブが落ちても、書けたところまではファイルに残る

  レイアウト
    tonmeister/rec/<recId>.f32   … float32 インターリーブ生データ（追記）
    tonmeister/rec/<recId>.json  … { channels, sampleRate, startedAt }
*/

let dir = null;           // tonmeister/rec
let handle = null;        // 同期アクセスハンドル（録音中のみ）
let recId = null;
let size = 0;
let written = 0;          // フレーム数

const reply = (id, result, error) => self.postMessage({ id, result, error });

async function root() {
  if (dir) return dir;
  const top = await navigator.storage.getDirectory();
  const tm = await top.getDirectoryHandle('tonmeister', { create: true });
  dir = await tm.getDirectoryHandle('rec', { create: true });
  return dir;
}

async function begin(id, channels, sampleRate) {
  const d = await root();
  const meta = await d.getFileHandle(id + '.json', { create: true });
  const mw = await meta.createSyncAccessHandle();
  const text = new TextEncoder().encode(JSON.stringify({ channels, sampleRate, startedAt: Date.now() }));
  mw.truncate(0); mw.write(text, { at: 0 }); mw.flush(); mw.close();

  const fh = await d.getFileHandle(id + '.f32', { create: true });
  handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  size = 0;
  written = 0;
  recId = id;
}

function append(samples, channels) {
  if (!handle) throw new Error('録音の受け皿が開いていません。');
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const n = handle.write(bytes, { at: size });
  if (n !== bytes.byteLength) throw new Error('書き込みが途中で止まりました。');
  size += n;
  written += samples.length / channels;
  return written;
}

function end() {
  if (handle) { try { handle.flush(); } catch { } try { handle.close(); } catch { } }
  handle = null;
  const r = { recId, frames: written, bytes: size };
  recId = null;
  return r;
}

async function read(id) {
  const d = await root();
  const meta = JSON.parse(await (await (await d.getFileHandle(id + '.json')).getFile()).text());
  const file = await (await d.getFileHandle(id + '.f32')).getFile();
  const buf = await file.arrayBuffer();
  const samples = new Float32Array(buf);
  return { samples, channels: meta.channels, sampleRate: meta.sampleRate, frames: Math.floor(samples.length / meta.channels) };
}

async function list() {
  const d = await root();
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (!name.endsWith('.json') || h.kind !== 'file') continue;
    const id = name.slice(0, -5);
    if (id === recId) continue;   // いま録っている最中のものは孤児ではない
    try {
      const meta = JSON.parse(await (await h.getFile()).text());
      const f = await (await d.getFileHandle(id + '.f32')).getFile();
      out.push({ recId: id, channels: meta.channels, sampleRate: meta.sampleRate, frames: Math.floor(f.size / 4 / meta.channels) });
    } catch { }
  }
  return out;
}

async function remove(id) {
  const d = await root();
  for (const n of [id + '.f32', id + '.json']) { try { await d.removeEntry(n); } catch { } }
}

/** 本当に同期追記ができるかを、小さなファイルで一度だけ確かめる（Safari の古い版などは途中で失敗する）。 */
async function probe() {
  const d = await root();
  const fh = await d.getFileHandle('.probe', { create: true });
  const h = await fh.createSyncAccessHandle();
  h.truncate(0);
  const n = h.write(new Uint8Array([1, 2, 3, 4]), { at: 0 });
  h.flush(); h.close();
  try { await d.removeEntry('.probe'); } catch { }
  if (n !== 4) throw new Error('write short');
  return true;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.cmd) {
      case 'probe': reply(m.id, await probe()); break;
      case 'begin': await begin(m.recId, m.channels, m.sampleRate); reply(m.id, true); break;
      case 'append': reply(m.id, append(m.samples, m.channels)); break;
      case 'end': reply(m.id, end()); break;
      case 'read': { const r = await read(m.recId); self.postMessage({ id: m.id, result: r }, [r.samples.buffer]); break; }
      case 'list': reply(m.id, await list()); break;
      case 'remove': await remove(m.recId); reply(m.id, true); break;
      default: reply(m.id, null, '不明な命令: ' + m.cmd);
    }
  } catch (err) {
    reply(m.id, null, String(err && err.message || err));
  }
};
