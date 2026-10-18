/**
 * serve.mjs — 零依赖静态服务器（ES module 必须走 http，不能 file:// 打开）
 * 用法： node serve.mjs [port]   默认 8123
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const SHOT_DIR = path.join(ROOT, 'shots');

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // ---- 截图落盘端点（仅本地开发用）：POST /__save?name=xxx.png  body = dataURL
    if (req.method === 'POST' && urlPath === '/__save') {
      const name = (new URL(req.url, 'http://localhost').searchParams.get('name') || 'shot.png')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const b64 = raw.replace(/^data:image\/\w+;base64,/, '');
        try {
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(b64, 'base64'));
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end('saved ' + name);
        } catch (e) {
          res.writeHead(500).end('save failed: ' + e.message);
        }
      });
      return;
    }

    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  林间小屋 · 本地预览\n  →  http://127.0.0.1:${PORT}/\n`);
  console.log(`  画面参数：?preset=golden|dawn|morning|overcast|dusk|night  ?q=low|medium|high|ultra  ?cam=free  ?shot=1\n`);
});
