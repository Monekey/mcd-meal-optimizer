/**
 * 归一化 + 营养匹配
 *
 * 关键实测差异（必读）：
 *  - query-meals 的价格是「元」字符串，如 "33.5"
 *  - calculate-price 的价格是「分」整数，如 3350
 *  → 本模块统一把一切价格转成「整数分」，全程不做浮点运算。
 */

/** 元（字符串或数字）→ 整数分 */
export function toFen(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** 整数分 → "12.90" */
export function toYuanStr(fen) {
  if (fen == null || !Number.isFinite(fen)) return '—';
  return (fen / 100).toFixed(2);
}

/** 名称归一化：去空格、去商标符号、全角转半角、去「套餐/随心选」等营销后缀 */
export function normName(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/【.*?】/g, '')
    .replace(/[·・\-—_/]/g, '')
    .toLowerCase();
}

/** 把 query-meals 的返回归一化成扁平的 item 列表 + 分类索引 */
export function normalizeMenu(menu) {
  const raw = menu?.meals || {};
  const categories = [];

  const items = Object.entries(raw).map(([code, m]) => {
    const price = toFen(m.currentPrice);
    const originalPrice = toFen(m.originalPrice);
    const isCardPrice = m.discountType === '麦金卡优惠' && originalPrice != null && price != null && originalPrice > price;
    return {
      code,
      name: m.name || code,
      image: m.image || null,
      price, // 菜单当前价（可能已是麦金卡价）
      originalPrice,
      discountType: m.discountType || null,
      isCardPrice,
      canWithOrder: !!m.canWithOrder,
      categories: [],
      categoryKeys: [],
    };
  });

  const byCode = new Map(items.map((i) => [i.code, i]));

  for (const cat of menu?.categories || []) {
    const name = String(cat.name || '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const key = name.replace(/\s+/g, '');
    const codes = [];
    for (const ref of cat.meals || []) {
      const it = byCode.get(ref.code);
      if (!it) continue;
      codes.push(ref.code);
      if (!it.categories.includes(name)) it.categories.push(name);
      if (!it.categoryKeys.includes(key)) it.categoryKeys.push(key);
      if (ref.tags?.length) it.tags = (it.tags || []).concat(ref.tags);
    }
    categories.push({ name, key, codes, count: codes.length });
  }

  return { items, byCode, categories, frequent: menu?.frequent || null };
}

/**
 * 菜单 ↔ 营养表匹配。
 * 三级策略：精确 → 归一化 → 双向包含（取最长公共匹配，避免误配）
 */
/**
 * 规格优先序：菜单名往往不写规格（「薯条」「可乐」），而营养表是按规格拆开的
 * （中薯条 / 大薯条 / 小薯条）。这时需要挑一个默认规格 —— 按麦当劳的常规默认取「中」。
 */
const SIZE_RULES = [
  [/中/, 1],
  [/小/, 2],
  [/大/, 3],
  [/迷你/, 4],
];

function sizeRank(name) {
  for (const [re, r] of SIZE_RULES) if (re.test(name)) return r;
  return 0;
}

export function attachNutrition(items, nutritionRows) {
  const exact = new Map();
  const norm = new Map();
  for (const r of nutritionRows || []) {
    if (!r?.productName) continue;
    if (!exact.has(r.productName)) exact.set(r.productName, r);
    const k = normName(r.productName);
    if (k && !norm.has(k)) norm.set(k, r);
  }

  let hit = 0;
  let assumed = 0;
  for (const it of items) {
    let n = exact.get(it.name);
    let method = 'exact';

    if (!n) {
      n = norm.get(normName(it.name));
      method = 'normalized';
    }

    if (!n) {
      // 双向包含 A：菜单名里含营养名（如「麦辣鸡腿汉堡三件套」含「麦辣鸡腿汉堡」）
      const key = normName(it.name);
      let best = null;
      for (const [k, r] of norm) {
        if (k.length < 4) continue;
        if (key.includes(k) && (!best || k.length > best.k.length)) best = { k, r };
      }
      if (best) {
        n = best.r;
        method = 'contains-menu';
      }
    }

    if (!n) {
      // 双向包含 B：营养名里含菜单名（菜单名没写规格：「薯条」→「中薯条」）
      // 先取名字最短的（避免「脆脆薯条」压过「中薯条」），再按「中 > 无规格 > 小 > 大 > 迷你」定规格。
      const key = normName(it.name);
      if (key.length >= 2) {
        const cands = [];
        for (const [k, r] of norm) {
          if (k !== key && k.includes(key)) cands.push({ k, r });
        }
        if (cands.length) {
          cands.sort((a, b) => a.k.length - b.k.length || sizeRank(a.k) - sizeRank(b.k));
          n = cands[0].r;
          method = 'contains-nutrition';
        }
      }
    }

    if (n) {
      it.nutrition = {
        kcal: n.energyKcal ?? null,
        protein: n.protein ?? null,
        fat: n.fat ?? null,
        carb: n.carbohydrate ?? null,
        sodium: n.sodium ?? null,
        calcium: n.calcium ?? null,
        matchedName: n.productName,
        matchMethod: method,
        // 套餐按「主品」匹配时热量不完整，需要调用方用 query-meal-detail 补全
        isComboGuess: method === 'contains-menu',
        // 菜单名没写规格、按默认规格估的（如「薯条」按「中薯条」）。展示层应如实标注。
        assumedSize: method === 'contains-nutrition',
      };
      hit++;
      if (method === 'contains-nutrition') assumed++;
    } else {
      it.nutrition = null;
    }
  }

  return { matched: hit, total: items.length, assumedSize: assumed };
}

/**
 * 汇总一组 item 的营养。
 * 关键：热量未知的商品**绝不按 0 计入**——否则「0 kcal 的套餐」会显得最健康，
 * 反而让"更轻"路线选出最不健康的东西。未知一律单独计数并在前端标注「部分数据」。
 */
export function sumNutrition(list) {
  const acc = { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, calcium: 0, unknown: 0, known: 0 };

  for (const { item, qty } of list) {
    const n = item.nutrition;
    if (!n || n.kcal == null) {
      acc.unknown += qty;
      continue;
    }
    acc.known += qty;
    for (const k of ['kcal', 'protein', 'fat', 'carb', 'sodium', 'calcium']) {
      acc[k] += (n[k] || 0) * qty;
    }
  }

  const hasAny = acc.known > 0;
  for (const k of ['kcal', 'protein', 'fat', 'carb', 'sodium', 'calcium']) {
    acc[k] = hasAny ? Math.round(acc[k]) : null;
  }
  acc.partial = hasAny && acc.unknown > 0;
  acc.knownRatio = acc.known + acc.unknown ? acc.known / (acc.known + acc.unknown) : 0;
  return acc;
}

/**
 * 找出某个 SKU 最"具体"的归属分类。
 * 一个商品会同时出现在「人气热卖」这类宽泛聚合分类和「巨无霸 / 牛鱼肉堡」这类精确分类里；
 * 做替换建议时应该用更精确的那个，否则会拿奶茶去替换汉堡。
 */
export function bestCategoryFor(code, categories) {
  const hits = (categories || []).filter((c) => c.codes.includes(code)).sort((a, b) => a.count - b.count);
  return hits[0] || null;
}

export default { toFen, toYuanStr, normName, normalizeMenu, attachNutrition, sumNutrition, bestCategoryFor };
