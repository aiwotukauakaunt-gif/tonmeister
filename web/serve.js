/*
  付属の小さなサーバ。依存は無い。

    node web/serve.js        → http://localhost:8787

  file:// で開くとブラウザがマイクを開けない（安全な文脈でないため）。
  localhost は安全な文脈として扱われるので、これで開く。
*/

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ROOT ? require("path").resolve(process.env.ROOT) : __dirname;   // ROOT で別のフォルダも配れる（keyboard の動作確認用）
// ポートは PORT 環境変数 → 引数 → 既定 の順で決める（外から割り当てられることがある）
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません: ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Tonmeister — http://localhost:${PORT}`);
});
