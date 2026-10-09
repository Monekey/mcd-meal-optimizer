/**
 * 部署后把 README 里的 demo 占位链接替换成真实的 GitHub Pages 地址。
 *
 * 用法：
 *   node scripts/set-pages-url.mjs <用户名> <仓库名>
 *   # 例如：node scripts/set-pages-url.mjs cuiqimeng mcd-meal-optimizer
 *   # 得到 https://cuiqimeng.github.io/mcd-meal-optimizer/
 *
 * 会同时更新 README.md 里所有 {@PAGES_URL} 占位符。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , user, repo] = process.argv;

if (!user || !repo) {
  console.error('用法：node scripts/set-pages-url.mjs <用户名> <仓库名>');
  process.exit(1);
}

const url = `https://${user}.github.io/${repo}/`;
const files = ['README.md', 'MCP_INTEGRATION.md', 'release/发布物料包.md'];

let changed = 0;
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const before = fs.readFileSync(p, 'utf8');
  const after = before
    .replaceAll('{@PAGES_URL}', url)
    .replaceAll('https://<你的用户名>.github.io/<仓库名>/', url)
    .replaceAll('https://<用户名>.github.io/<仓库名>/', url)
    .replaceAll('<你的用户名>/<仓库名>', `${user}/${repo}`);
  if (after !== before) {
    fs.writeFileSync(p, after);
    changed++;
    console.log(`  ✔ ${f}`);
  }
}

console.log(`\ndemo 地址已写入：${url}`);
console.log(`共更新 ${changed} 个文件。别忘了在仓库 Settings → Pages 里选 main / docs。`);
