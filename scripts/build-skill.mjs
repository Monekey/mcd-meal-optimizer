#!/usr/bin/env node
/**
 * 打包 WorkBuddy Skill
 * ---------------------------------------------------------------------------
 * 把仓库里的确定性算法层（core/ + server/）平铺进 skills/mcd-meal-optimizer/scripts/，
 * 生成一个自包含、可直接上传到 WorkBuddy 技能市场的 ZIP。
 *
 * 用法：
 *   node scripts/build-skill.mjs           # 组装 + 打包
 *   node scripts/build-skill.mjs --check   # 只组装并自检，不打包
 *
 * 产物：dist/mcd-meal-optimizer-<version>.zip
 *
 * 为什么可以平铺：core/ 与 server/ 之间只有 './xxx.mjs' 形式的同级引用，
 * 没有跨目录引用，所以复制到同一个 scripts/ 目录后路径依然成立。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'mcd-meal-optimizer');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');
const CHECK_ONLY = process.argv.includes('--check');

const line = (s = '') => console.log(s);
const ok = (s) => console.log(`  ✔ ${s}`);
const bad = (s) => console.log(`  ✘ ${s}`);

/** 需要平铺进 scripts/ 的源文件 */
const SOURCES = [
  ['core/menu.mjs', 'menu.mjs'],
  ['core/optimizer.mjs', 'optimizer.mjs'],
  ['core/card-roi.mjs', 'card-roi.mjs'],
  ['server/mcp-client.mjs', 'mcp-client.mjs'],
  ['server/parse.mjs', 'parse.mjs'],
  ['server/enrich.mjs', 'enrich.mjs'],
];

function readVersion() {
  const md = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const m = md.match(/^version:\s*(.+)$/m);
  return m ? m[1].trim() : '0.0.0';
}

function checkFrontmatter() {
  const md = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, missing: ['(整个 frontmatter)'] };

  const body = fm[1];
  const has = (k) => new RegExp(`^${k}:\\s*\\S`, 'm').test(body);

  // 技能市场要求的必填字段
  const required = ['description', 'description_zh', 'description_en', 'version', 'author'];
  const missing = required.filter((k) => !has(k));
  return { ok: missing.length === 0, missing };
}

function main() {
  line('打包 WorkBuddy Skill');
  line('='.repeat(56));

  /* 1. 检查 frontmatter ---------------------------------------- */
  line('\n[1] 检查 SKILL.md frontmatter（技能市场的必填字段）');
  const fm = checkFrontmatter();
  if (fm.ok) ok('description / description_zh / description_en / version / author 全部具备');
  else {
    bad(`缺少字段：${fm.missing.join(', ')}`);
    process.exit(1);
  }

  /* 2. 平铺算法层 ---------------------------------------------- */
  line('\n[2] 平铺算法层到 scripts/');
  fs.mkdirSync(SCRIPTS, { recursive: true });

  const copied = [];
  for (const [src, dst] of SOURCES) {
    const from = path.join(ROOT, src);
    const to = path.join(SCRIPTS, dst);
    if (!fs.existsSync(from)) {
      bad(`源文件不存在：${src}`);
      process.exit(1);
    }
    fs.copyFileSync(from, to);
    copied.push(dst);
    ok(`${src}  →  scripts/${dst}  (${(fs.statSync(to).size / 1024).toFixed(1)} KB)`);
  }

  /* 3. 检查跨目录引用 ------------------------------------------ */
  line('\n[3] 检查是否残留跨目录引用（打包后会断链）');
  let broken = 0;
  for (const f of copied) {
    const p = path.join(SCRIPTS, f);
    const code = fs.readFileSync(p, 'utf8');
    const hits = [...code.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]).filter((r) => r.includes('..'));
    if (hits.length) {
      bad(`${f} 存在跨目录引用：${[...new Set(hits)].join(', ')}`);
      broken++;
    }
  }
  if (!broken) ok('无跨目录引用，平铺后路径成立');

  /* 4. 语法自检 ------------------------------------------------ */
  line('\n[4] 语法自检');
  const all = [...copied, 'cli.mjs'];
  let syntaxBad = 0;
  for (const f of all) {
    const p = path.join(SCRIPTS, f);
    if (!fs.existsSync(p)) {
      bad(`缺少 ${f}`);
      syntaxBad++;
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    } catch (e) {
      bad(`${f} 语法错误：${String(e.stderr || e.message).split('\n')[0]}`);
      syntaxBad++;
    }
  }
  if (!syntaxBad) ok(`${all.length} 个脚本语法全部通过`);

  /* 5. 打包 ---------------------------------------------------- */
  const version = readVersion();
  const distDir = path.join(ROOT, 'dist');
  const zipName = `mcd-meal-optimizer-${version}.zip`;
  const zipPath = path.join(distDir, zipName);

  if (CHECK_ONLY) {
    line('\n自检完成（--check，未打包）。');
    if (syntaxBad || broken) process.exit(1);
    return;
  }

  line('\n[5] 打包');
  fs.mkdirSync(distDir, { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  try {
    // 在 skills/ 下执行，保证 ZIP 根目录就是 mcd-meal-optimizer/
    execFileSync('zip', ['-r', '-q', zipPath, 'mcd-meal-optimizer', '-x', '*.DS_Store', '-x', '*/.cache/*'], {
      cwd: path.join(ROOT, 'skills'),
      stdio: 'pipe',
    });
    const size = fs.statSync(zipPath).size;
    ok(`dist/${zipName}  (${(size / 1024).toFixed(1)} KB)`);
    if (size > 3 * 1024 * 1024) bad('⚠️ 超过技能市场 3MB 上限');
    else ok('未超过技能市场 3MB 上限');
  } catch (e) {
    bad(`打包失败：${e.message}`);
    line('  可以手动打包：cd skills && zip -r ../dist/' + zipName + ' mcd-meal-optimizer');
    process.exit(1);
  }

  /* 6. 列出包内结构 -------------------------------------------- */
  line('\n[6] 包内结构');
  try {
    const list = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    for (const l of list.split('\n')) {
      if (/mcd-meal-optimizer\//.test(l) && !/\/$/.test(l.split(/\s+/).pop() || '')) {
        const parts = l.trim().split(/\s+/);
        line(`  ${parts[parts.length - 1]}  (${parts[0]} B)`);
      }
    }
  } catch {
    line('  （unzip 不可用，跳过）');
  }

  line('\n' + '='.repeat(56));
  line('完成。下一步：把这个 ZIP 上传到 WorkBuddy 技能市场。');
  line('具体步骤见 release/WorkBuddy技能上架.md');
}

main();
