/* Tonmeister — Service Worker
   オフラインでも開けるように自分のファイルをキャッシュ。
   ネットワーク優先（更新をすぐ反映）→ 失敗したらキャッシュ。keyboard と同じ型。
   Worker / AudioWorklet のスクリプトも同じ origin なので、同じ扱いで拾う。 */
const CACHE = 'tonmeister-v1';
const ASSETS = [
  './', './index.html', './manifest.json', './css/theme.css',
  './js/app.js', './js/engine.js', './js/capture-core.js', './js/capture-worker.js', './js/storage-worker.js',
  './js/worklets.js', './js/wav.js', './js/analysis.js', './js/edit.js', './js/waveform.js', './js/model.js',
  './js/store.js', './js/meterscale.js', './js/finish.js', './js/reverb.js', './js/quality.js', './js/sweep.js',
  './js/miccal.js', './js/disk-writer.js', './js/importer.js', './js/i18n.js',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
