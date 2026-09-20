/*
  置き場所。デスクトップ版はフォルダ1つ＝セッション1つだったが、
  ブラウザにはフォルダが無いので IndexedDB に同じ形で持つ。

    sessions … session.json にあたるもの
    audio    … WAV そのもの（Blob）。書き出しはこれをそのまま渡す
    chunks   … 録音中の書き出し先（OPFS が使えないブラウザでの受け皿。途中で閉じても音が残る）
  OPFS が使えるブラウザでは、録音中の音は storage-worker.js が OPFS のファイルへ同期追記する。
    settings … 機器・細かさ・ズレ合わせなど、次に開いたときのため

  「フォルダごとコピーすれば持ち運べる」の代わりに、
  セッションを丸ごと書き出す（session.json ＋ WAV）を用意してある。
*/

const DB_NAME = 'tonmeister';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/* ---------------- セッション ---------------- */

export async function listSessions() {
  const list = await tx('sessions', 'readonly', s => wrap(s.getAll())).then(p => p);
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function loadSession(id) {
  return tx('sessions', 'readonly', s => wrap(s.get(id))).then(p => p);
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  await tx('sessions', 'readwrite', s => s.put(JSON.parse(JSON.stringify(session))));
  return session;
}

export async function deleteSession(id) {
  const session = await loadSession(id);
  if (session) {
    for (const track of session.tracks || []) {
      for (const take of track.takes || []) {
        if (take.audioId) await deleteAudio(take.audioId);
      }
    }
  }
  await tx('sessions', 'readwrite', s => s.delete(id));
}

/* ---------------- 音そのもの ---------------- */

export async function putAudio(id, blob) {
  await tx('audio', 'readwrite', s => s.put({ id, blob }));
  return id;
}

export async function getAudio(id) {
  const rec = await tx('audio', 'readonly', s => wrap(s.get(id))).then(p => p);
  return rec ? rec.blob : null;
}

export async function deleteAudio(id) {
  await tx('audio', 'readwrite', s => s.delete(id));
}

/* ---------------- 録音中の受け皿 ---------------- */
/*
   OPFS（Origin Private File System）が使えるブラウザでは、storage-worker.js が
   「録音1本＝ファイル1つ」で同期追記する。使えなければ IndexedDB に塊で入れる。
   どちらでも、途中でタブを閉じた録音は「孤児」として次に開いたとき拾える。
*/

let storageWorker = null;
let storageSeq = 0;
const storageWaiting = new Map();
let opfsProbe = null;

function callStorage(cmd, args = {}, transfer = []) {
  if (!storageWorker) {
    storageWorker = new Worker('js/storage-worker.js', { type: 'module' });
    storageWorker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const w = storageWaiting.get(id);
      if (!w) return;
      storageWaiting.delete(id);
      if (error) w.reject(new Error(error)); else w.resolve(result);
    };
    storageWorker.onerror = (e) => {
      for (const w of storageWaiting.values()) w.reject(new Error(e.message || 'storage worker error'));
      storageWaiting.clear();
    };
  }
  const id = ++storageSeq;
  return new Promise((resolve, reject) => {
    storageWaiting.set(id, { resolve, reject });
    storageWorker.postMessage(Object.assign({ id, cmd }, args), transfer);
  });
}

/** OPFS が実際に使えるか（同期アクセスハンドルまで含めて）を一度だけ確かめる。 */
export function hasOpfs() {
  if (opfsProbe) return opfsProbe;
  opfsProbe = (async () => {
    if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker === 'undefined') return false;
    try { await callStorage('probe'); return true; }
    catch { return false; }
  })();
  return opfsProbe;
}

export async function storageKind() { return (await hasOpfs()) ? 'opfs' : 'idb'; }

/**
 * 録音1本ぶんの受け皿を開く。append で足し、end で閉じる。
 * 返ってくる sink はどちらの置き場所でも同じ形。
 */
export async function openRecordingSink(recId, channels, sampleRate) {
  if (await hasOpfs()) {
    await callStorage('begin', { recId, channels, sampleRate });
    return {
      kind: 'opfs',
      append: (samples) => callStorage('append', { samples, channels }, [samples.buffer]),
      end: () => callStorage('end'),
    };
  }
  let seq = 0;
  return {
    kind: 'idb',
    append: async (samples) => { await appendChunk(recId, seq++, samples, channels, sampleRate); },
    end: async () => ({ recId }),
  };
}

/** 受け皿に入っている音を丸ごと読む（止めたとき／孤児の復元）。 */
export async function readRecording(recId) {
  if (await hasOpfs()) {
    try {
      const r = await callStorage('read', { recId });
      if (r && r.samples && r.samples.length) return r;
    } catch { }
  }
  const stored = await listChunks(recId);
  if (!stored.length) return null;
  let total = 0;
  for (const c of stored) total += c.samples.length;
  const samples = new Float32Array(total);
  let p = 0;
  for (const c of stored) { samples.set(c.samples, p); p += c.samples.length; }
  const channels = stored[0].channels;
  return { samples, channels, sampleRate: stored[0].sampleRate, frames: Math.floor(total / channels) };
}

export async function clearRecording(recId) {
  if (await hasOpfs()) { try { await callStorage('remove', { recId }); } catch { } }
  await clearChunks(recId);
}

async function appendChunk(recId, seq, samples, channels, sampleRate) {
  const key = `${recId}:${String(seq).padStart(8, '0')}`;
  await tx('chunks', 'readwrite', s => s.put({ key, recId, seq, samples, channels, sampleRate }));
}

async function listChunks(recId) {
  const all = await tx('chunks', 'readonly', s => wrap(s.getAll())).then(p => p);
  return all.filter(c => c.recId === recId).sort((a, b) => a.seq - b.seq);
}

export async function listOrphanRecordings() {
  const out = [];
  if (await hasOpfs()) { try { out.push(...await callStorage('list')); } catch { } }
  const all = await tx('chunks', 'readonly', s => wrap(s.getAll())).then(p => p);
  const byRec = new Map();
  for (const c of all) {
    const cur = byRec.get(c.recId) || { recId: c.recId, frames: 0, channels: c.channels, sampleRate: c.sampleRate };
    cur.frames += c.samples.length / c.channels;
    byRec.set(c.recId, cur);
  }
  out.push(...byRec.values());
  return out;
}

async function clearChunks(recId) {
  const all = await tx('chunks', 'readonly', s => wrap(s.getAllKeys())).then(p => p);
  const mine = all.filter(k => String(k).startsWith(recId + ':'));
  if (!mine.length) return;
  await tx('chunks', 'readwrite', s => { for (const k of mine) s.delete(k); });
}

/* ---------------- 覚えておく設定 ---------------- */

export async function getSettings() {
  const rec = await tx('settings', 'readonly', s => wrap(s.get('app'))).then(p => p);
  return rec ? rec.v : {};
}

export async function setSettings(v) {
  await tx('settings', 'readwrite', s => s.put({ k: 'app', v: JSON.parse(JSON.stringify(v)) }));
}

/* フォルダのハンドル（File System Access API）は JSON にできないので、別の鍵で丸ごと入れる。 */
export async function setHandle(name, handle) {
  if (handle) await tx('settings', 'readwrite', s => s.put({ k: 'handle:' + name, v: handle }));
  else await tx('settings', 'readwrite', s => s.delete('handle:' + name));
}

export async function getHandle(name) {
  const rec = await tx('settings', 'readonly', s => wrap(s.get('handle:' + name))).then(p => p);
  return rec ? rec.v : null;
}

/** 使っている容量のおおよそ。 */
export async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
