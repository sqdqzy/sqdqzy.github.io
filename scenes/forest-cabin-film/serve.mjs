/**
 * serve.mjs — 零依赖静态服务器（ES module 必须走 http，file:// 会被 CORS 拦住）
 * 用法： node serve.mjs [端口]   默认 8124
 * 附带 POST /__save 截图落盘端点，仅本地开发用。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8124);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.jsonl': 'application/octet-stream', '.wasm': 'application/octet-stream',
};

http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    if (req.method === 'POST' && p === '/__save') {
      const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot.png').replace(/[^a-zA-Z0-9._-]/g, '_');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const b64 = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/\w+;base64,/, '');
        const dir = path.join(ROOT, 'shots');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
        res.writeHead(200).end('saved ' + name);
      });
      return;
    }

    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('404 ' + p); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    res.writeHead(500).end('500 ' + e.message);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  林间小屋 → http://127.0.0.1:${PORT}/`);
  console.log(`  参数：?preset=dawn|morning|golden|dusk|night  ?q=low|medium|high|ultra  ?cam=free  ?shot\n`);
});
