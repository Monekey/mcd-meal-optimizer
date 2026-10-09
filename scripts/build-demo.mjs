/**
 * 构建单文件离线演示 docs/demo.html
 *
 * 为什么要有这个 demo：
 *   比赛排名由 GitHub Star 决定，而"能不能点开就看"是拿 Star 的关键。
 *   真实版本需要用户自备 MCP Token，门槛太高；这个 demo 把真实门店数据快照
 *   和同一套算法内联进一个 HTML，双击即可玩，还能直接挂 GitHub Pages。
 *
 * 重要：算法不是复制的，是从 core/ 原样内联进来的 —— 保证 demo 与线上同源。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 把 ESM 模块转成可以直接内联的普通脚本片段 */
function stripModule(code) {
  const kept = code
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .filter((l) => !/^\s*export\s+default\b/.test(l))
    .join('\n');
  return kept
    .replace(/^export\s*\{[\s\S]*?\};?/gm, '')
    .replace(/^export\s+/gm, '');
}

const core = [
  '/* ===== core/menu.mjs ===== */',
  stripModule(read('core/menu.mjs')),
  '/* ===== core/optimizer.mjs ===== */',
  stripModule(read('core/optimizer.mjs')),
  '/* ===== core/card-roi.mjs ===== */',
  stripModule(read('core/card-roi.mjs')),
].join('\n\n');

const data = read('data/demo-menu.json').trim();

const html = read('demo/src/index.html')
  .replace('/*__CSS__*/', () => read('demo/src/style.css'))
  .replace('/*__CORE__*/', () => core)
  .replace('/*__DATA__*/', () => `const DATA = ${data};`)
  .replace('/*__APP__*/', () => read('demo/src/app.js'));

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const out = path.join(ROOT, 'docs', 'demo.html');
fs.writeFileSync(out, html);

// GitHub Pages 默认从 /docs 目录取 index.html 作为站点根。
// 这里同步写一份 index.html，让 demo 直接有一个公网可点的链接：
//   https://<用户名>.github.io/<仓库名>/
// （涨星的关键是"能点开就看"，所以这一步不是可选项。）
fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), html);

// 关掉 Jekyll，避免 Pages 对下划线开头的文件做处理
fs.writeFileSync(path.join(ROOT, 'docs', '.nojekyll'), '');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log('✔ 已生成 docs/demo.html 与 docs/index.html');
console.log(`  core  ${kb(core.length)}`);
console.log(`  data  ${kb(data.length)}`);
console.log(`  合计  ${kb(html.length)}`);
