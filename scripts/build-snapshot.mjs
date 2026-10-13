#!/usr/bin/env node
/**
 * 生成技能包内置的门店菜单快照（scripts/snapshot.json）
 * ---------------------------------------------------------------------------
 * 为什么需要它：技能市场用户绝大多数没有麦当劳 MCP Token。
 * 如果没有兜底，装完技能第一条命令就报错 —— 体验等于零。
 *
 * 所以把一家门店的**真实菜单**（含已补全的营养数据）固化进包里，
 * 没 Token 时用同一套算法跑快照，让用户立刻看到真实结果；
 * 有 Token 时自动走实时数据（快照只是兜底，不会覆盖实时价）。
 *
 * 用法：node scripts/build-snapshot.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SRC = path.join(ROOT, 'data', 'demo-menu.json');
const OUT = path.join(ROOT, 'skills', 'mcd-meal-optimizer', 'scripts', 'snapshot.json');

const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// 只保留算法真正用到的字段，去掉图片 URL 等冗余（包体积能砍掉一大半）
const items = d.items.map((i) => ({
  code: i.code,
  name: i.name,
  price: i.price,
  originalPrice: i.originalPrice ?? null,
  isCardPrice: !!i.isCardPrice,
  categories: i.categories || [],
  categoryKeys: i.categoryKeys || [],
  nutrition: i.nutrition || null,
}));

const out = {
  meta: {
    ...d.meta,
    note: '这是门店菜单快照（离线兜底用），价格与实时菜单可能不同。需要实时数据请配置 MCD_MCP_TOKEN。',
  },
  categories: d.categories.map((c) => ({ name: c.name, key: c.key, count: c.count })),
  items,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`✔ ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB  ${items.length} 个 SKU`);
