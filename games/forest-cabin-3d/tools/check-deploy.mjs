/**
 * check-deploy.mjs — 部署前自检（Lead 工具，不参与网页运行）
 * 目的：本地 Windows 不区分大小写，而 GitHub Pages / Linux 区分。
 * 这里用「逐段精确匹配目录项」的方式模拟大小写敏感的文件系统，
 * 递归走完整依赖图（含 vendor/three/examples/jsm 的传递依赖），
 * 报出任何在 Linux 上会 404 的导入。
 *
 * 用法: node tools/check-deploy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const norm = (p) => p.replace(/\\/g, '/');

/** 大小写敏感地解析工作区内的相对路径 */
function resolveExact(relPath) {
  const parts = norm(relPath).split('/').filter((s) => s && s !== '.');
  let cur = ROOT;
  for (const part of parts) {
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return null; }
    const hit = entries.find((e) => e === part);      // 精确匹配，不做大小写折叠
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return fs.statSync(cur).isFile() ? cur : null;
}

const visited = new Set();
const missing = [];
const externals = new Set();

function walk(relFile) {
  if (visited.has(relFile)) return;
  visited.add(relFile);
  const abs = resolveExact(relFile);
  if (!abs) { missing.push({ from: '(entry)', spec: relFile, resolved: relFile }); return; }
  let code;
  try { code = fs.readFileSync(abs, 'utf8'); } catch { return; }

  // 覆盖 `import x from '...'`、`import('...')`、`export ... from '...'`
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1];
    let target = null;
    if (spec.startsWith('.')) {
      target = norm(path.posix.join(path.posix.dirname(relFile), spec));
    } else if (spec.startsWith('three/addons/')) {
      target = 'vendor/three/examples/jsm/' + spec.slice('three/addons/'.length);
    } else if (spec.startsWith('three/')) {
      target = 'vendor/three/' + spec.slice('three/'.length);
    } else if (spec === 'three') {
      target = 'vendor/three/build/three.module.js';
    } else {
      externals.add(spec);          // 裸模块（非 three），需要 importmap 或打包器
      continue;
    }
    if (!resolveExact(target)) missing.push({ from: relFile, spec, resolved: target });
    else walk(target);
  }
}

// 入口：index.html 引用的脚本 + src 下全部模块
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) walk(norm(m[1]).replace(/^\.\//, ''));
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (f.endsWith('.js')) walk('src/' + f);
}

console.log(`依赖图扫描：${visited.size} 个模块文件`);

// 实际被用到的 vendor 子集体积（用于评估能否精简 vendor/）
let usedVendor = 0, usedVendorFiles = 0;
for (const f of visited) {
  if (!f.startsWith('vendor/')) continue;
  const abs = resolveExact(f);
  if (abs) { usedVendor += fs.statSync(abs).size; usedVendorFiles++; }
}
let totalVendor = 0;
const walkDir = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkDir(p);
    else totalVendor += fs.statSync(p).size;
  }
};
walkDir(path.join(ROOT, 'vendor'));
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
console.log(`vendor 实际用到：${usedVendorFiles} 个文件 / ${mb(usedVendor)}（vendor 全量 ${mb(totalVendor)}）`);
console.log(`外部裸模块（需 importmap/打包器）：${externals.size ? [...externals].join(', ') : '无'}`);
if (missing.length === 0) {
  console.log('✅ 全部导入在大小写敏感的文件系统上都能解析（GitHub Pages 可用）');
  process.exit(0);
}
console.log(`❌ 有 ${missing.length} 处会在 Linux/GitHub Pages 上 404：`);
for (const m of missing) console.log(`   ${m.from}  ->  ${m.spec}`);
process.exit(1);
