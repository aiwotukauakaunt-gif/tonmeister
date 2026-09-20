/* Tonmeister — Service Worker
   オフラインでも開けるように自分のファイルをキャッシュ。
   ネットワーク優先（更新をすぐ反映）→ 失敗したらキャッシュ。keyboard と同じ型。
   Worker / AudioWorklet のスクリプトも同じ origin なので、同じ扱いで拾う。 */
const CACHE = 'tonmeister-deeb5ddf9e';
const ASSETS = [
  './', './apple-touch-icon.png', './css/host-keyboard.css', './css/theme.css', './icon-192.png',
  './icon-512-maskable.png', './icon-512.png', './index.html', './js/analysis.js', './js/app.js',
  './js/capture-core.js', './js/capture-worker.js', './js/disk-writer.js', './js/edit.js', './js/engine.js',
  './js/finish.js', './js/flac.js', './js/host.js', './js/i18n.js', './js/importer.js', './js/meterscale.js',
  './js/miccal.js', './js/model.js', './js/palette.js', './js/quality.js', './js/reverb.js', './js/side.js',
  './js/storage-worker.js', './js/store.js', './js/sweep.js', './js/ui/context.js', './js/ui/diagnostics.js',
  './js/ui/export.js', './js/ui/overdub.js', './js/ui/record.js', './js/ui/sessions.js', './js/ui/settings.js',
  './js/wav.js', './js/waveform.js', './js/worklets.js', './manifest.json'
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
