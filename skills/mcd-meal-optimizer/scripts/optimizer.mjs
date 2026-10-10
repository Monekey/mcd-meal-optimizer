/**
 * 双目标组合求解器（价格 × 热量/营养）
 *
 * 设计原则 —— 呼应"数值不进 LLM"：
 *   · 全部算术在本地用「整数分」完成，无浮点误差
 *   · 结果是确定性的、可复现的、可回归测试的
 *   · 大模型只负责把结果讲成人话，不负责算
 *
 * 与竞品的差异：
 *   · 省钱类竞品只做「价格最小」，营养类竞品只做「热量约束」
 *   · 本求解器把两者放进同一目标函数，并同时给出三条可解释路线
 */

import { sumNutrition, toYuanStr, bestCategoryFor, normName } from './menu.mjs';

const DEFAULT_LIMIT_PER_SLOT = 22;
const COMBO_HARD_CAP = 400000;

/**
 * 默认过滤掉「不是一份吃的」的东西：蘸酱、餐具、周边、玩具等。
 * 否则「最省」路线会给你算出「纯悦 + 一包山葵酱」这种正确但荒谬的组合。
 */
const NON_MEAL = /酱$|蘸酱$|餐具|纸巾|包装袋|周边|玩具|徽章|帽子|玩偶|盘|杯垫/;

/** 购物车 → 结算行 + 价格 + 营养。priceMode: 'as-is'（菜单当前价） */
export function cartTotals(cart, ctx) {
  const { byCode } = ctx.menu;
  const lines = [];
  let listFen = 0;
  let payableFen = 0;
  let cardSavingsFen = 0;

  for (const { code, qty = 1 } of cart || []) {
    const item = byCode.get(code);
    if (!item) continue;
    const list = (item.originalPrice ?? item.price ?? 0) * qty;
    const pay = (item.price ?? 0) * qty;
    listFen += list;
    payableFen += pay;
    if (item.isCardPrice) cardSavingsFen += list - pay;
    lines.push({ item, qty, listFen: list, payableFen: pay });
  }

  return {
    lines,
    count: (cart || []).reduce((s, c) => s + (c.qty || 1), 0),
    listFen,
    payableFen,
    cardSavingsFen,
    nutrition: sumNutrition(lines.map((l) => ({ item: l.item, qty: l.qty }))),
  };
}

/** 券 → 可参与优化的「虚拟行」 */
export function applyCoupons(lines, ctx) {
  const coupons = ctx.coupons || [];
  const used = [];
  const nextLines = lines.map((l) => ({ ...l }));
  const claimed = new Set();

  for (const line of nextLines) {
    const key = String(line.item.name || '');
    for (const c of coupons) {
      if (claimed.has(c.id)) continue;
      if (c.kind !== 'fixed-price' || !c.price) continue;
      if (c.price >= line.item.price) continue; // 券不划算就不挂
      if (!c.target) continue;
      const t = String(c.target).replace(/\s/g, '');
      const k = key.replace(/\s/g, '');
      if (k.includes(t) || t.includes(k)) {
        line.couponId = c.couponId;
        line.couponCode = c.couponCode;
        line.couponTitle = c.raw;
        line.priceBeforeCouponFen = line.payableFen;
        line.payableFen = c.price * line.qty;
        line.couponSavingsFen = line.priceBeforeCouponFen - line.payableFen;
        line.listFen = line.priceBeforeCouponFen;
        claimed.add(c.id);
        used.push(c);
        break;
      }
    }
  }

  return {
    lines: nextLines,
    couponsUsed: used,
    payableFen: nextLines.reduce((s, l) => s + l.payableFen, 0),
    listFen: nextLines.reduce((s, l) => s + l.listFen, 0),
    couponSavingsFen: nextLines.reduce((s, l) => s + (l.couponSavingsFen || 0), 0),
    cardSavingsFen: nextLines.reduce((s, l) => s + (l.item.isCardPrice ? (l.listFen - l.payableFen) : 0), 0),
    nutrition: sumNutrition(nextLines.map((l) => ({ item: l.item, qty: l.qty }))),
  };
}

/** 为一个「想要」构造候选 list */
function candidatesFor(want, ctx) {
  const { items } = ctx.menu;
  const avoid = (ctx.constraints?.avoid || []).map((s) => String(s).trim()).filter(Boolean);

  let pool = items.filter((i) => i.price != null);

  if (!want.includeNonMeal) pool = pool.filter((i) => !NON_MEAL.test(String(i.name)));

  if (want.code) pool = pool.filter((i) => i.code === want.code);
  else if (want.categories?.length || want.category) {
    // 支持单个 category，也支持 categories 数组（一个口语词常常横跨多个品类，
    // 例如「汉堡」同时属于 鸡肉汉堡/卷、巨无霸牛鱼肉堡、安格斯MAX厚牛堡）。
    const raw = want.categories?.length ? want.categories : [want.category];
    const keys = new Set(raw.map((k) => String(k).replace(/\s+/g, '')));
    const codes = new Set();
    for (const c of ctx.menu.categories) {
      const ck = String(c.key || '').replace(/\s+/g, '');
      const cn = String(c.name || '').replace(/\s+/g, '');
      if (keys.has(ck) || keys.has(cn)) for (const code of c.codes) codes.add(code);
    }
    pool = pool.filter((i) => codes.has(i.code));
  }

  if (want.anyOf?.length) {
    pool = pool.filter((i) => want.anyOf.some((k) => String(i.name).includes(k)));
  }
  if (want.exclude?.length) {
    pool = pool.filter((i) => !want.exclude.some((k) => String(i.name).includes(k)));
  }
  if (want.maxPriceFen != null) pool = pool.filter((i) => i.price <= want.maxPriceFen);
  if (avoid.length) pool = pool.filter((i) => !avoid.some((k) => String(i.name).includes(k)));
  if (ctx.constraints?.maxKcal != null) {
    pool = pool.filter((i) => i.nutrition?.kcal == null || i.nutrition.kcal <= ctx.constraints.maxKcal);
  }

  // 同价位冗余去重（同名不同 code 只留便宜的）
  const seen = new Map();
  const out = [];
  for (const i of pool) {
    const k = i.name;
    if (seen.has(k)) {
      const prev = seen.get(k);
      if (i.price < prev.price) {
        out.splice(out.indexOf(prev), 1, i);
        seen.set(k, i);
      }
      continue;
    }
    seen.set(k, i);
    out.push(i);
  }

  out.sort((a, b) => a.price - b.price);
  const limit = want.limit || ctx.limitPerSlot || DEFAULT_LIMIT_PER_SLOT;
  return out.slice(0, limit);
}

/** 单条组合的估价 */
function priceCombo(combo, ctx) {
  const lines = combo.map(({ item, qty }) => ({
    item,
    qty,
    listFen: (item.originalPrice ?? item.price) * qty,
    payableFen: item.price * qty,
  }));
  const withCoupons = applyCoupons(lines, ctx);
  return {
    lines: withCoupons.lines,
    listFen: withCoupons.listFen,
    payableFen: withCoupons.payableFen,
    couponSavingsFen: withCoupons.couponSavingsFen,
    cardSavingsFen: withCoupons.cardSavingsFen,
    couponsUsed: withCoupons.couponsUsed,
    nutrition: withCoupons.nutrition,
  };
}

function feasible(p, c) {
  const cr = c.constraints || {};
  if (cr.budgetFen != null && p.payableFen > cr.budgetFen) return false;

  // 关键诚实性约束：只要设了热量/钠/蛋白上限，就不允许用「热量未知」的商品来凑数。
  // 否则会算出「0 kcal 套餐」这种看起来达标、实际什么都没算的结论。
  const hasNutritionCap = cr.maxKcal != null || cr.maxSodium != null || cr.minProtein != null;
  if (hasNutritionCap && p.nutrition.unknown > 0) return false;
  if (cr.maxKcal != null && !(p.nutrition.kcal <= cr.maxKcal)) return false;
  if (cr.minProtein != null && !(p.nutrition.protein >= cr.minProtein)) return false;
  if (cr.maxSodium != null && !(p.nutrition.sodium <= cr.maxSodium)) return false;
  return true;
}

/** 生成笛卡尔组合（带硬上限，超出则按单位价格剪枝） */
function* enumerate(slots) {
  const idx = new Array(slots.length).fill(0);
  for (;;) {
    const combo = [];
    let ok = true;
    const usedInGroup = new Map();

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const cand = s.candidates[idx[i]];
      if (!cand) {
        ok = false;
        break;
      }
      // 同一分组（品类）内的多个槽位不能选同一个 SKU ——
      // 否则"两个槽位都从人气热卖挑"会退化成"最便宜的那个买两份"，结果没有参考价值。
      if (s.group != null) {
        const set = usedInGroup.get(s.group) || new Set();
        if (set.has(cand.code)) {
          ok = false;
          break;
        }
        set.add(cand.code);
        usedInGroup.set(s.group, set);
      }
      combo.push({ item: cand, qty: s.qty || 1 });
    }
    if (ok) yield combo;

    let i = slots.length - 1;
    while (i >= 0) {
      idx[i]++;
      if (idx[i] < slots[i].candidates.length) break;
      idx[i] = 0;
      i--;
    }
    if (i < 0) return;
  }
}

/**
 * 求解。
 * @param {object} req
 * @param {Array<{label?:string, code?:string, category?:string, anyOf?:string[], exclude?:string[], qty?:number, limit?:number}>} req.wants
 * @param {{budgetFen?:number, maxKcal?:number, minProtein?:number, maxSodium?:number, avoid?:string[]}} [req.constraints]
 * @param {{wPrice?:number, wKcal?:number, wProtein?:number}} [req.weights]
 */
export function solve(req, ctx) {
  const wants = (req.wants || []).filter(Boolean);
  if (!wants.length) return { plans: [], evaluated: 0, feasible: 0, note: '没有选择任何品类' };

  // 约束既可能挂在 req 上，也可能挂在 ctx 上（服务端两种都会传）——统一合并一次，
  // 否则会出现「传了预算但没生效」这种静默错误。
  const resolved = {
    ...ctx,
    constraints: { ...(ctx.constraints || {}), ...(req.constraints || {}) },
    limitPerSlot: req.limitPerSlot ?? ctx.limitPerSlot,
  };
  if (!resolved.constraints.avoid?.length && ctx.constraints?.avoid?.length) {
    resolved.constraints.avoid = ctx.constraints.avoid;
  }

  const slots = wants.map((w) => ({
    qty: w.qty || 1,
    // 分组只用于"同品类不重复"约束：用户明确点了同一个 code 的多个数量时不参与去重
    group: w.code
      ? null
      : (w.group ?? w.category ?? (w.categories?.length ? w.categories.join('|') : null) ?? w.label ?? null),
    candidates: candidatesFor(w, resolved),
  }));
  const emptySlot = slots.findIndex((s) => !s.candidates.length);
  if (emptySlot >= 0) {
    return {
      plans: [],
      evaluated: 0,
      feasible: 0,
      note: `「${wants[emptySlot].label || wants[emptySlot].category || '所选品类'}」在当前门店菜单下没有可用候选（可能受热量上限或忌口过滤影响）`,
    };
  }

  const total = slots.reduce((s, x) => s * x.candidates.length, 1);
  if (total > COMBO_HARD_CAP) {
    slots.forEach((s) => (s.candidates = s.candidates.slice(0, 14)));
  }

  const all = [];
  let evaluated = 0;
  let feasibleCount = 0;

  for (const combo of enumerate(slots)) {
    evaluated++;
    const p = priceCombo(combo, resolved);
    p.items = combo;
    all.push(p);
    if (feasible(p, ctx)) feasibleCount++;
  }

  if (!all.length) return { plans: [], evaluated, feasible: 0, note: '组合空间为空' };

  const kcalVals = all.map((p) => p.nutrition.kcal).filter(Number.isFinite);
  const priceVals = all.map((p) => p.payableFen);
  const proteinVals = all.map((p) => p.nutrition.protein).filter(Number.isFinite);
  const rng = (a) => (a.length ? { min: Math.min(...a), max: Math.max(...a) } : { min: 0, max: 0 });
  const kr = rng(kcalVals);
  const pr = rng(priceVals);
  const ar = rng(proteinVals);
  // 营养未知的组合在综合评分里按「中性 0.5」处理，不因为缺数据而占便宜
  const span = (r, v) => (v == null || r.max === r.min ? 0.5 : (v - r.min) / (r.max - r.min));

  const w = { wPrice: 0.55, wKcal: 0.35, wProtein: 0.1, ...(req.weights || {}) };
  const wsum = w.wPrice + w.wKcal + w.wProtein || 1;

  for (const p of all) {
    // 营养数据不全的组合要付出置信度代价，不能让"没有数据"变成隐形的优势
    const unknownPenalty = 0.3 * (1 - (p.nutrition.knownRatio ?? 1));
    p.score =
      (w.wPrice * span(pr, p.payableFen) + w.wKcal * span(kr, p.nutrition.kcal) + w.wProtein * (1 - span(ar, p.nutrition.protein))) /
        wsum +
      unknownPenalty;
    p.feasible = feasible(p, resolved);
  }

  const okList = all.filter((p) => p.feasible);
  const pool = okList.length ? okList : all;

  const pick = (fn) => pool.reduce((best, p) => (best == null || fn(p) < fn(best) ? p : best), null);

  // 「更轻」必须优先选**热量数据完整**的方案：只靠一杯水的 0 kcal 不能算"轻"
  const lighterKey = (p) => [
    p.nutrition.unknown > 0 ? 1 : 0,
    p.nutrition.kcal == null ? Number.MAX_SAFE_INTEGER : p.nutrition.kcal,
  ];

  const raw = [
    // 同价时优先选营养数据完整的（并列第一也要选信息更多的那套）
    { id: 'cheapest', title: '最省', subtitle: '实付最低', plan: pool.reduce((b, p) => (!b || p.payableFen < b.payableFen || (p.payableFen === b.payableFen && p.nutrition.unknown < b.nutrition.unknown) ? p : b), null) },
    { id: 'balanced', title: '最平衡', subtitle: '钱与热量综合最优', plan: pick((p) => p.score) },
    {
      id: 'lighter',
      title: '更轻',
      subtitle: '热量最低（营养数据完整）',
      plan: pool.reduce((best, p) => {
        if (best == null) return p;
        const a = lighterKey(best);
        const b = lighterKey(p);
        return b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? p : best;
      }, null),
    },
  ];

  const seen = new Set();
  const plans = [];
  const push = (r) => {
    if (!r.plan) return false;
    const sig = r.plan.items.map((x) => `${x.item.code}x${x.qty}`).join('|');
    if (seen.has(sig)) return false;
    seen.add(sig);
    plans.push({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      payableFen: r.plan.payableFen,
      listFen: r.plan.listFen,
      couponSavingsFen: r.plan.couponSavingsFen,
      cardSavingsFen: r.plan.cardSavingsFen,
      couponsUsed: r.plan.couponsUsed.map((c) => ({ title: c.raw, couponId: c.couponId })),
      nutrition: r.plan.nutrition,
      kcalKnown: r.plan.nutrition.kcal != null,
      items: r.plan.items.map(({ item, qty }) => ({
        code: item.code,
        name: item.name,
        image: item.image,
        qty,
        unitFen: item.price,
        lineFen: item.price * qty,
        isCardPrice: item.isCardPrice,
        kcal: item.nutrition?.kcal ?? null,
      })),
    });
    return true;
  };

  for (const r of raw) push(r);

  // 三条路线高度重合时（例如约束很紧），补一条"次优"备选，避免界面只剩一个方案
  if (plans.length < 2) {
    const rest = pool.filter((p) => !seen.has(p.items.map((x) => `${x.item.code}x${x.qty}`).join('|'))).sort((a, b) => a.score - b.score);
    if (rest[0]) {
      push({ id: 'runnerUp', title: '次优选择', subtitle: '另一个可行搭配', plan: rest[0] });
    }
  }

  return {
    plans,
    evaluated,
    feasible: feasibleCount,
    totals: pool.length,
    ranges: { price: pr, kcal: kr, protein: ar },
    note: okList.length ? null : '当前约束下没有完全满足的方案，以下为最接近的推荐',
  };
}

/**
 * 判断一个 SKU 是「套餐」还是「单品」。
 * 这个区分是必须的：把「四件套」换成「巨无霸单品」虽然便宜，但内容少了，
 * 那不是"省钱"，是"少买"。所以替换建议必须同类才能比较。
 */
const COMBO_NAME = /件套|套餐|随心选|分享餐|组合|双人|多人|拼盘|双堡|三堡|四堡|餐盒/;

export function kindOf(item) {
  if (item?.nutrition?.components?.length) return 'combo';
  if (COMBO_NAME.test(String(item?.name || ''))) return 'combo';
  return 'single';
}

/**
 * 更细的「食物类别」判定 —— 单品替换的第三道闸。
 *
 * 光靠菜单品类不够：麦当劳把薯条、冰淇淋、苹果片全塞在同一个「小食甜品/其他」品类下，
 * 只按品类挑替代会给出「薯条 → 圆筒冰淇淋」这种荒唐建议 —— 那不是同类替换，
 * 换的是完全不同的东西。所以单品必须再过这一层。
 *
 * 顺序有讲究：burger 必须在 chicken 之前，否则「板烧鸡腿堡」会被 鸡腿 抢先判成 chicken。
 */
const FOOD_RULES = [
  ['icecream', /圆筒|圣代|新地|冰淇淋|麦旋风|冰炫风/],
  ['fries', /薯条/],
  ['burger', /巨无霸|汉堡|堡|麦香鱼|鳕鱼|板烧/],
  ['chicken', /麦乐鸡|鸡块|鸡翅|鸡腿|炸鸡|脆汁鸡|原味鸡|鸡排|鸡柳/],
  ['drink', /可乐|雪碧|芬达|纯悦|饮用水|矿泉水|柠檬茶|冰红茶|红茶|绿茶|咖啡|奶铁|拿铁|美式|摩卡|雪顶|酷爽|奶昔|鲜奶|豆浆/],
  ['side', /苹果片|玉米|沙拉|蔬菜|坚果/],
  ['dessert', /派|蛋糕|可颂|曲奇|饼干|麦芬|甜甜圈|面包|布朗尼|挞/],
  ['sauce', /酱|蘸料/],
];

export function foodGroup(item) {
  const n = String(item?.name || '');
  for (const [g, re] of FOOD_RULES) if (re.test(n)) return g;
  return 'other';
}

/** 套餐的默认组成（归一化名称集合），用于"内容不能变少"的比较 */
function componentSet(item) {
  const c = item?.nutrition?.components || [];
  return [...new Set(c.map((x) => normName(x.name)).filter((x) => x && x.length >= 2))].sort();
}

/** 套餐内容是否覆盖（≥）另一份套餐/一组单品 */
function coversAll(altSet, needSet) {
  if (!needSet.length) return false;
  return needSet.every((n) => altSet.some((a) => a === n || a.includes(n) || n.includes(a)));
}

/**
 * 基于购物车给出「最小改动建议」——本产品的核心差异点。
 *
 * 两条铁律（曾经踩过的坑）：
 *   ① 只做**同类替换**：套餐只能换套餐，单品只能换单品。
 *      「安格斯厚牛堡四件套 → 巨无霸」看着省 ¥11.5，实际是少了薯条和饮料。
 *   ② 套餐替换必须**内容不减少**（组件集合覆盖原套餐）。
 *
 * 另外新增第 ③ 类建议：把购物车里的多个单品**打包成一个套餐**——
 * 这才是麦当劳场景里真正的大头（单点巨无霸+薯条+可乐 vs 巨无霸三件套）。
 */
export function advise(cart, ctx, { maxSuggestions = 6 } = {}) {
  const base = applyCoupons(cartTotals(cart, ctx).lines, ctx);
  const suggestions = [];

  /* ---------- ① 同类替换 ---------- */
  for (const line of base.lines) {
    const item = line.item;
    if (NON_MEAL.test(String(item.name))) continue;
    const cat = bestCategoryFor(item.code, ctx.menu.categories);
    if (!cat || cat.count < 2) continue;

    const myKind = kindOf(item);
    const myComp = myKind === 'combo' ? componentSet(item) : [];
    // 铁律 ①b：单品必须落在同一个「食物类别」里。
    // 类别判定不出来的，保守起见不做建议 —— 宁可不提，也不要给出荒唐的替换。
    const myGroup = myKind === 'single' ? foodGroup(item) : null;
    if (myKind === 'single' && myGroup === 'other') continue;

    let best = null;
    for (const code of cat.codes) {
      const alt = ctx.menu.byCode.get(code);
      if (!alt || alt.code === item.code || alt.price == null) continue;
      if (NON_MEAL.test(String(alt.name))) continue;

      // 铁律 ①
      if (kindOf(alt) !== myKind) continue;
      // 铁律 ①b：薯条 ≠ 冰淇淋，鸡块 ≠ 苹果片
      if (myKind === 'single' && foodGroup(alt) !== myGroup) continue;
      // 铁律 ②：套餐必须有组成数据，且内容不能变少
      if (myKind === 'combo') {
        const altComp = componentSet(alt);
        if (!altComp.length || !myComp.length) continue;
        if (!coversAll(altComp, myComp)) continue;
      }

      const dFen = (item.price - alt.price) * line.qty;
      const knownBoth = item.nutrition?.kcal != null && alt.nutrition?.kcal != null;
      const dKcal = knownBoth ? (item.nutrition.kcal - alt.nutrition.kcal) * line.qty : null;
      const dProtein = knownBoth ? (alt.nutrition.protein - item.nutrition.protein) * line.qty : null;

      if (dFen <= 0 && !(dKcal != null && dKcal > 0)) continue;

      const gain = dFen + (dKcal ? dKcal * 0.15 : 0) + (dProtein ? dProtein * 2 : 0) + (knownBoth ? 5 : 0);
      if (!best || gain > best.gain) best = { alt, dFen, dKcal, dProtein, gain };
    }

    if (best) {
      suggestions.push({
        type: 'swap',
        sameContent: true,
        from: { code: item.code, name: item.name, unitFen: item.price, kcal: item.nutrition?.kcal ?? null },
        to: { code: best.alt.code, name: best.alt.name, unitFen: best.alt.price, kcal: best.alt.nutrition?.kcal ?? null },
        qty: line.qty,
        saveFen: best.dFen,
        deltaKcal: best.dKcal == null ? null : -best.dKcal,
        deltaProtein: best.dProtein,
        reason:
          myKind === 'combo' ? '同类套餐、内容不变，更便宜' : best.dFen > 0 && best.dKcal > 0 ? '同类单品，更便宜且更轻' : best.dFen > 0 ? '同类单品，更便宜' : '同类单品，热量更低',
      });
    }
  }

  /* ---------- ② 单点打包成套餐 ---------- */
  const singles = base.lines.filter((l) => kindOf(l.item) === 'single' && !NON_MEAL.test(String(l.item.name)));
  if (singles.length >= 2) {
    const combos = ctx.menu.items.filter((i) => kindOf(i) === 'combo' && i.price != null && componentSet(i).length >= 2);
    const bundleBest = new Map();

    for (const combo of combos) {
      const comps = componentSet(combo);
      const covered = singles.filter((l) => coversAll(comps, [normName(l.item.name)]));
      const uniq = new Map(covered.map((l) => [l.item.code, l]));
      if (uniq.size < 2) continue;

      const list = [...uniq.values()];
      const sumFen = list.reduce((s, l) => s + l.item.price * l.qty, 0);
      const save = sumFen - combo.price;
      if (save <= 0) continue;

      const prev = bundleBest.get(combo.code);
      if (!prev || save > prev.saveFen) {
        bundleBest.set(combo.code, {
          type: 'bundle',
          sameContent: true, // 套餐内容 ⊇ 被替换的单品，不会变少
          to: { code: combo.code, name: combo.name, unitFen: combo.price, kcal: combo.nutrition?.kcal ?? null },
          from: list.map((l) => ({ code: l.item.code, name: l.item.name, unitFen: l.item.price, kcal: l.nutrition?.kcal ?? null, qty: l.qty })),
          coveredCodes: list.map((l) => l.item.code),
          saveFen: save,
          deltaKcal: null,
          reason: `把 ${list.length} 个单品打包成套餐，内容只多不少`,
        });
      }
    }
    suggestions.push(...bundleBest.values());
  }

  suggestions.sort((a, b) => b.saveFen - a.saveFen);
  const shown = suggestions.slice(0, maxSuggestions);

  // ⚠️「还能再省多少」必须是**可以同时达成**的数字，不能把所有建议简单相加。
  // 打包建议之间是互斥的（每一个都消费整单），加总会把「省 ¥16.5」和「省 ¥12」
  // 算成「省 ¥28.5」—— 那是虚报，用户照着做根本省不到。
  // 口径：逐项替换互不冲突 → 可累加；打包只能取最优的一个；两者取较大值。
  const bySwapFen = shown
    .filter((s) => s.type === 'swap')
    .reduce((s, x) => s + Math.max(0, x.saveFen), 0);
  const bestBundleFen = shown
    .filter((s) => s.type === 'bundle')
    .reduce((m, x) => (x.saveFen > m ? x.saveFen : m), 0);

  return {
    baseline: {
      payableFen: base.payableFen,
      listFen: base.listFen,
      couponSavingsFen: base.couponSavingsFen,
      cardSavingsFen: base.cardSavingsFen,
      nutrition: base.nutrition,
      count: (cart || []).reduce((s, c) => s + (c.qty || 1), 0),
    },
    suggestions: shown,
    totalSaveFen: Math.max(bySwapFen, bestBundleFen),
    totalSaveBreakdown: {
      bySwapFen,
      bestBundleFen,
      strategy: bestBundleFen > bySwapFen ? 'bundle' : bySwapFen > 0 ? 'swap' : 'none',
      note:
        '两个策略互斥，取更优的一个：要么照「替换」逐项改（可累加），' +
        '要么整单照「打包」换成套餐（只能选一个）。',
    },
  };
}

/** 购物车 → 求解器的 wants（同品类同数量，用于找"等效更优组合"） */
export function wantsFromCart(cart, ctx) {
  const wants = [];
  for (const { code, qty = 1 } of cart || []) {
    const item = ctx.menu.byCode.get(code);
    if (!item) continue;
    const cat = bestCategoryFor(item.code, ctx.menu.categories);
    wants.push({
      label: cat?.name || item.name,
      category: cat?.count > 1 ? cat.name : null,
      code: cat?.count > 1 ? null : item.code,
      qty,
      anchor: item.name,
    });
  }
  return wants;
}

export { toYuanStr };
export default { cartTotals, applyCoupons, solve, advise, wantsFromCart, kindOf };
