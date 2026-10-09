/**
 * 套餐营养补全
 *
 * 问题：`list-nutrition-foods` 只给「单品」营养（160 条），而菜单里大量是套餐
 * （麦辣鸡腿汉堡三件套、安格斯厚牛堡四件套随心选……），直接按名字匹配不上，
 * 若强行按 0 计，会让「更轻」路线选出最不健康的东西。
 *
 * 解法：套餐详情工具 `query-meal-detail` 会返回 `rounds[].choices[]`，
 * 其中 `isDefault === 1` 的选项就是套餐的默认组成。把各默认选项的营养相加即可。
 *
 * 工程约束：
 *  · 每个套餐要 1 次 MCP 调用 → 只对「真正进入候选/购物车」的套餐补全
 *  · 结果落盘缓存（data/nutrition-cache.json），重复运行零调用
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 1));
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 名称索引：归一化名 → 营养记录 */
function buildIndex(rows, normName) {
  const idx = new Map();
  for (const r of rows || []) {
    const k = normName(r.productName);
    if (k && !idx.has(k)) idx.set(k, r);
  }
  return idx;
}

function lookup(name, idx, normName) {
  const k = normName(name);
  if (!k) return null;
  if (idx.has(k)) return idx.get(k);
  // 包含匹配（如「中杯可乐」vs「可口可乐中杯」）
  let best = null;
  for (const [key, r] of idx) {
    if (key.length < 3) continue;
    if (k.includes(key) || key.includes(k)) {
      if (!best || Math.abs(key.length - k.length) < Math.abs(best.k.length - k.length)) best = { k: key, r };
    }
  }
  return best ? best.r : null;
}

const SUN = ['kcal', 'protein', 'fat', 'carb', 'sodium', 'calcium'];

/**
 * 用 query-meal-detail 解析套餐默认组成的营养合计。
 * @returns {Promise<{kcal,protein,fat,carb,sodium,calcium,components:Array,unknownComponents:string[]}|null>}
 */
export async function resolveComboNutrition(code, { client, nutritionRows, normName, cache = {}, quiet = true }) {
  if (cache[code]) return cache[code];

  const r = await client.call('query-meal-detail', {
    storeCode: client.__storeCode,
    orderType: client.__orderType ?? 1,
    beType: client.__beType ?? 1,
    code,
  });
  if (!r.ok) return null;

  let detail;
  try {
    const i = r.text.indexOf('{"success"');
    const i2 = r.text.indexOf('{"code"');
    const start = i >= 0 ? i : i2 >= 0 ? i2 : -1;
    if (start < 0) return null;
    const raw = JSON.parse(r.text.slice(start, r.text.lastIndexOf('}') + 1));
    detail = raw.data ?? raw;
  } catch {
    return null;
  }

  const rounds = detail?.rounds || [];
  if (!rounds.length) return null;

  const idx = buildIndex(nutritionRows, normName);
  const acc = { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, calcium: 0 };
  const components = [];
  const unknownComponents = [];
  let known = 0;

  for (const round of rounds) {
    const def = (round.choices || []).find((c) => c.isDefault === 1) || (round.choices || [])[0];
    if (!def) continue;
    const qty = Math.max(1, round.quantity || 1);
    const n = lookup(def.name, idx, normName);
    if (!n || n.energyKcal == null) {
      unknownComponents.push(def.name);
      components.push({ name: def.name, qty, kcal: null });
      continue;
    }
    known++;
    acc.kcal += n.energyKcal * qty;
    acc.protein += (n.protein || 0) * qty;
    acc.fat += (n.fat || 0) * qty;
    acc.carb += (n.carbohydrate || 0) * qty;
    acc.sodium += (n.sodium || 0) * qty;
    acc.calcium += (n.calcium || 0) * qty;
    components.push({ name: def.name, qty, kcal: n.energyKcal * qty });
  }

  if (!known) return null;

  const out = {
    kcal: Math.round(acc.kcal),
    protein: Math.round(acc.protein),
    fat: Math.round(acc.fat),
    carb: Math.round(acc.carb),
    sodium: Math.round(acc.sodium),
    calcium: Math.round(acc.calcium),
    components,
    unknownComponents,
    source: 'query-meal-detail',
  };

  cache[code] = out;
  if (!quiet) console.log(`  ✔ 补全 ${detail.name || code} → ${out.kcal} kcal（${components.length} 项组成）`);
  return out;
}

/**
 * 批量补全：只处理「没有营养」且看起来是套餐的 item，按需限量。
 * @returns {Promise<number>} 补全数量
 */
export async function enrichCombos(items, { client, nutritionRows, normName, cacheFile, budget = 12, quiet = true }) {
  const cache = loadCache(cacheFile);
  let used = 0;
  let filled = 0;

  const targets = items.filter(
    (i) => !i.nutrition && /套|餐|组合|拼盘|随心选|分享|精选|套装|件/.test(String(i.name)) && i.price != null
  );

  // 优先补全「贵/常见」的套餐，性价比更高
  targets.sort((a, b) => b.price - a.price);

  for (const it of targets) {
    if (used >= budget) break;
    if (cache[it.code]) {
      it.nutrition = { ...cache[it.code], matchedName: cache[it.code].source, matchMethod: 'combo-detail' };
      filled++;
      continue;
    }
    used++;
    const n = await resolveComboNutrition(it.code, { client, nutritionRows, normName, cache, quiet });
    if (n) {
      it.nutrition = { ...n, matchedName: n.source, matchMethod: 'combo-detail' };
      filled++;
    }
  }

  saveCache(cacheFile, cache);
  return { filled, mcCalls: used, cached: Object.keys(cache).length };
}

export default { enrichCombos, resolveComboNutrition, loadCache, saveCache };
