#!/usr/bin/env node
/**
 * 导出离线演示数据
 * ---------------------------------------------------------------------------
 * 从麦当劳 MCP 拉一次真实菜单（含套餐营养补全），固化成
 * `data/demo-menu.json`，供 `docs/index.html` 做零 Token 离线演示。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/export-demo-data.mjs [storeCode]
 *
 * 注意：菜单与价格会变，导出时会把快照时间写进 meta，展示层应如实标注「数据快照」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { McdMcpClient, hasToken } from '../server/mcp-client.mjs';
import * as P from '../server/parse.mjs';
import * as M from '../core/menu.mjs';
import { enrichCombos } from '../server/enrich.mjs';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const STORE = process.argv[2] || '1950564';
// 菜单接口不返回门店名，所以允许显式传入（否则展示层会显示占位名）
const STORE_NAME = process.argv[3] || process.env.MCD_STORE_NAME || '麦当劳门店';
const OUT = path.join(ROOT, 'data', 'demo-menu.json');

if (!hasToken()) {
  console.error('缺少 MCD_MCP_TOKEN。用法：MCD_MCP_TOKEN=xxx node scripts/export-demo-data.mjs');
  process.exit(1);
}

const client = new McdMcpClient();
const NUTRI_CACHE = path.join(ROOT, 'data', 'nutrition-cache.json');

const menuRes = await client.call('query-meals', { storeCode: STORE, orderType: 1, beType: 1 });
if (!menuRes.ok) {
  console.error('拉取菜单失败：', menuRes.error?.message || JSON.stringify(menuRes.error));
  process.exit(1);
}
const menu = M.normalizeMenu(P.extractData(menuRes.text));

const nutritionRows = P.parseNutritionTable((await client.call('list-nutrition-foods', {})).text);
const attached = M.attachNutrition(menu.items, nutritionRows);

const enriched = await enrichCombos(menu.items, {
  client,
  nutritionRows,
  normName: M.normName,
  cacheFile: NUTRI_CACHE,
  budget: 40,
  storeCode: STORE,
  orderType: 1,
  beType: 1,
});

const items = menu.items
  .filter((i) => i.price != null)
  .map((i) => {
    const n = i.nutrition;
    return {
      code: i.code,
      name: i.name,
      image: i.image ?? null,
      price: i.price,
      originalPrice: i.originalPrice ?? null,
      isCardPrice: !!i.isCardPrice,
      categories: i.categories || [],
      categoryKeys: i.categoryKeys || [],
      nutrition: n
        ? {
            kcal: n.kcal ?? null,
            protein: n.protein ?? null,
            fat: n.fat ?? null,
            carb: n.carb ?? null,
            sodium: n.sodium ?? null,
            calcium: n.calcium ?? null,
            matchedName: n.matchedName ?? null,
            matchMethod: n.matchMethod ?? null,
            assumedSize: !!n.assumedSize,
            ...(n.components ? { components: n.components.map((c) => ({ name: c.name, qty: c.qty })) } : {}),
          }
        : null,
    };
  });

const withKcal = items.filter((i) => i.nutrition?.kcal != null);
const out = {
  meta: {
    storeCode: STORE,
    storeName: STORE_NAME,
    fetchedAt: new Date().toISOString(),
    sku: items.length,
    withNutrition: withKcal.length,
    nutritionCoverage: items.length ? +(withKcal.length / items.length).toFixed(3) : 0,
    cardPrice: items.filter((i) => i.isCardPrice).length,
    categories: menu.categories.length,
    note:
      '真实门店快照，用于零 Token 离线演示；价格单位=整数分；' +
      '营养由 list-nutrition-foods + query-meal-detail 组成求和补全；' +
      'assumedSize=true 表示菜单未标规格、按默认规格（中）估算。菜单会随时间变化，以快照时间为准。',
  },
  categories: menu.categories.map((c) => ({ name: c.name, key: c.key, codes: c.codes })),
  items,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

console.log('✔ 已导出 data/demo-menu.json');
console.log(`  门店        ${out.meta.storeName} (${STORE})`);
console.log(`  SKU         ${items.length}`);
console.log(`  分类        ${menu.categories.length}`);
console.log(`  有热量      ${withKcal.length} / ${items.length}  (${Math.round(out.meta.nutritionCoverage * 100)}%)`);
console.log(`  其中按默认规格估算  ${items.filter((i) => i.nutrition?.assumedSize).length}`);
console.log(`  麦金卡价    ${out.meta.cardPrice}`);
console.log(`  文件大小    ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`  MCP 调用    ${client.stats.requests} 次（套餐补全 ${enriched.mcCalls} 次）`);
