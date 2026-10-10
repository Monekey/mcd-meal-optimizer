#!/usr/bin/env node
/**
 * 麦麦点餐官 CLI —— 供 WorkBuddy Skill 调用
 *
 * 设计原则：**所有算术都在这里完成，绝不交给 LLM。**
 * 价格、热量、优惠全部用整数「分」运算，无浮点误差。
 *
 * 用法：
 *   node cli.mjs stores   --city 北京 --keyword 国贸
 *   node cli.mjs menu     --store 1950564 --mode takein
 *   node cli.mjs solve    --store 1950564 --mode takein --wants "汉堡,饮料" --budget 40 --max-kcal 700
 *   node cli.mjs advise   --store 1950564 --mode takein --cart "1100:1,4810:1"
 *   node cli.mjs card-roi --store 1950564 --mode takein --fee 19 --visits 8
 *   node cli.mjs price    --store 1950564 --mode takein --cart "1100:1"
 *   node cli.mjs tools
 *
 * 通用参数：
 *   --text   输出人话（默认输出 JSON）
 *
 * Token：从环境变量 MCD_MCP_TOKEN 或本机 ~/.workbuddy/mcp.json 读取，永不写盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McdMcpClient, hasToken } from './mcp-client.mjs';
import * as P from './parse.mjs';
import * as M from './menu.mjs';
import * as O from './optimizer.mjs';
import { cardRoi } from './card-roi.mjs';
import { enrichCombos, loadCache, saveCache } from './enrich.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(DIR, '.cache', 'nutrition.json');

/* ------------------------------- 参数解析 ------------------------------- */

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const yuan = M.toYuanStr;
const fen = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

const MODES = {
  takein: { orderType: 1, beType: 1, label: '到店取餐' },
  delivery: { orderType: 2, beType: 2, label: '麦乐送' },
};

function modeOf(v) {
  const m = MODES[v || 'takein'];
  if (!m) throw new Error(`未知的 --mode：${v}（可选 takein / delivery）`);
  return m;
}

/* --------------------------------- 工具 -------------------------------- */

const client = new McdMcpClient();

if (!hasToken()) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: '未找到麦当劳 MCP Token',
        howTo:
          '去 https://open.mcd.cn/mcp 用手机号登录 → 右上角「控制台」→ 激活 → 复制 Token；' +
          '然后把它配到环境变量 MCD_MCP_TOKEN，或在 WorkBuddy 的【连接器】里启用 mcd-mcp。',
      },
      null,
      2
    )
  );
  process.exit(2);
}

async function call(name, args) {
  const r = await client.call(name, args);
  if (!r.ok) throw new Error(`${name} 调用失败：${r.error?.message || JSON.stringify(r.error)}`);
  return r.text;
}

function cartOf(spec) {
  if (!spec) return [];
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [code, qty] = s.split(':');
      return { code: code.trim(), qty: Number(qty || 1) };
    });
}

/**
 * 口语 → 品类 的别名表。
 * 一个口语词常常横跨多个品类，例如「汉堡」同时属于三个品类，
 * 而「饮料」在菜单里叫「饮品」—— 光靠子串匹配对不上，必须显式映射。
 */
const CATEGORY_ALIAS = {
  饮料: ['饮品'],
  喝的: ['饮品'],
  汽水: ['饮品'],
  可乐: ['饮品'],
  饮品: ['饮品'],
  汉堡: ['鸡肉汉堡/卷', '巨无霸牛鱼肉堡', '安格斯MAX厚牛堡'],
  堡: ['鸡肉汉堡/卷', '巨无霸牛鱼肉堡', '安格斯MAX厚牛堡'],
  牛肉堡: ['巨无霸牛鱼肉堡', '安格斯MAX厚牛堡'],
  鸡肉堡: ['鸡肉汉堡/卷'],
  小食: ['小食甜品/其他', '蘸酱炸鸡', '炸鸡'],
  小吃: ['小食甜品/其他', '蘸酱炸鸡'],
  甜品: ['小食甜品/其他'],
  炸鸡: ['炸鸡', '蘸酱炸鸡'],
  咖啡: ['麦咖啡™', '麦咖啡'],
  麦咖啡: ['麦咖啡™', '麦咖啡'],
  儿童餐: ['开心乐园'],
  儿童: ['开心乐园'],
  单人餐: ['精选单人餐', '大堡口福单人餐'],
  双人餐: ['小食拼盘/多人餐'],
  分享餐: ['小食拼盘/多人餐'],
  多人餐: ['小食拼盘/多人餐'],
  低卡: ['500大卡套餐'],
  轻食: ['500大卡套餐'],
  麦金卡: ['麦金卡专享'],
  随心配: ['随心配1+1'],
  人气: ['人气热卖'],
  热卖: ['人气热卖'],
};

/** 把用户口语（"汉堡"、"饮料"）解析成求解器认识的 wants */
function resolveWants(list, menu) {
  const keys = new Set(menu.categories.map((c) => c.key));

  return list
    .map((raw) => {
      const s = String(raw).trim();
      if (!s) return null;
      const qty = 1;

      // 1) 看起来就是商品 code
      if (menu.byCode.has(s)) return { label: menu.byCode.get(s).name, code: s, qty };

      const q = s.replace(/\s+/g, '');

      // 2) 别名表（最可靠，优先）
      const alias = CATEGORY_ALIAS[q];
      if (alias) {
        const hit = alias.filter((k) => keys.has(k));
        if (hit.length === 1) return { label: q, category: hit[0], qty };
        if (hit.length > 1) return { label: q, categories: hit, qty };
      }

      // 3) 品类名包含关键词
      const byName = menu.categories.filter((c) => c.key.includes(q)).map((c) => c.key);
      if (byName.length === 1) return { label: q, category: byName[0], qty };
      if (byName.length > 1) return { label: q, categories: byName, qty };

      // 4) 反过来：用户说的词里包含某个品类名
      const byReverse = menu.categories.filter((c) => q.includes(c.key)).map((c) => c.key);
      if (byReverse.length) return { label: q, category: byReverse[0], qty };

      // 5) 兜底：按商品名包含匹配
      return { label: s, anyOf: [s], qty };
    })
    .filter(Boolean);
}

/**
 * 麦乐送：外送必须先有「收货地址」才能查到可配送门店，
 * 而门店返回的 beCode 是外送下单/核价的必传参数（到店场景不需要）。
 */
async function resolveDeliveryStores(addressId, storeCode = null) {
  if (!addressId) {
    throw new Error('麦乐送需要 --address <地址ID>；可以先跑 `node cli.mjs addresses` 看有哪些地址');
  }
  const d = P.extractData(await call('delivery-query-stores', { beType: 2, addressId })) || {};
  const stores = d.stores || (Array.isArray(d) ? d : []);
  if (!stores.length) throw new Error('这个地址没有可配送的门店');

  if (!storeCode) return { stores, store: stores[0] };
  const hit = stores.find((s) => String(s.storeCode) === String(storeCode));
  if (!hit) {
    throw new Error(
      `该地址不配送门店 ${storeCode}。可配送的有：` +
        stores.map((s) => `${s.storeName}(${s.storeCode})`).join('、')
    );
  }
  return { stores, store: hit };
}

let _menuCache = null;

/**
 * 载入菜单。返回的 menu 上挂了 `__store`，供 price/order 复用同一套
 * storeCode / beCode / orderType / beType —— 避免调用方各拼一套拼错。
 */
async function loadMenu(storeCode, mode, { enrich = true, budget = 14, addressId = null, beCode = null } = {}) {
  const { orderType, beType } = modeOf(mode);

  let sc = storeCode;
  let bc = beCode;
  if (mode === 'delivery') {
    if (!bc) {
      const { store } = await resolveDeliveryStores(addressId, storeCode);
      sc = store.storeCode;
      bc = store.beCode;
    }
    if (!bc) throw new Error('这家门店没有返回 beCode，外送无法核价/下单');
  }

  const cacheKey = `${mode}:${sc}:${bc || ''}`;
  if (_menuCache?.key === cacheKey) return _menuCache.menu;

  const args = { storeCode: sc, orderType, beType };
  if (bc) args.beCode = bc; // 外送/得来速/团餐必传
  const menuRaw = P.extractData(await call('query-meals', args));
  const menu = M.normalizeMenu(menuRaw);

  let nutritionRows = [];
  try {
    nutritionRows = P.parseNutritionTable(await call('list-nutrition-foods', {}));
  } catch {
    nutritionRows = [];
  }
  M.attachNutrition(menu.items, nutritionRows);

  let enriched = 0;
  if (enrich) {
    const r = await enrichCombos(menu.items, {
      client,
      nutritionRows,
      normName: M.normName,
      cacheFile: CACHE_FILE,
      budget,
      // 必须显式传门店与渠道 —— 否则套餐营养会静默地一个都补不上
      storeCode: sc,
      orderType,
      beType,
    });
    enriched = r?.filled || 0;
  }

  menu.stats = {
    mode,
    storeCode: sc,
    beCode: bc || null,
    sku: menu.items.length,
    categories: menu.categories.length,
    withNutrition: menu.items.filter((i) => i.nutrition?.kcal != null).length,
    cardPrice: menu.items.filter((i) => i.isCardPrice).length,
    enriched,
    mcpCalls: client.stats.requests,
  };
  // 供 price / order 复用，避免各命令各拼一套参数
  menu.__store = { storeCode: sc, beCode: bc, orderType, beType, mode };

  _menuCache = { key: cacheKey, menu };
  return menu;
}

/* -------------------------------- 子命令 ------------------------------- */

const COMMANDS = {
  async tools() {
    const tools = await client.listTools();
    return {
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 160) })),
      note: '注意：实际返回数比官方文档多 2 个（query-promotions / query-survey-coupon）。',
    };
  },

  /** 麦乐送用的收货地址（外卖下单的必要前置） */
  async addresses() {
    const d = P.extractData(await call('delivery-query-addresses', {})) || {};
    const list = d.addresses || (Array.isArray(d) ? d : []);
    return {
      ok: true,
      count: list.length,
      addresses: list.map((a) => ({
        addressId: a.addressId,
        contactName: a.contactName,
        phone: a.phone,
        fullAddress: a.fullAddress,
        isDefault: !!a.isDefault,
      })),
      note: '麦乐送必须用 addressId 查可配送门店；核价与下单也要用同一个 addressId。',
    };
  },

  async stores(a) {
    const mode = a.mode || 'takein';

    if (mode === 'delivery') {
      const { stores } = await resolveDeliveryStores(a.address, a.store);
      return {
        ok: true,
        mode,
        count: stores.length,
        stores: stores.map((s) => ({
          storeCode: s.storeCode,
          beCode: s.beCode,
          name: s.storeName,
          address: s.address,
          distance: s.distance,
        })),
        note: '外送必须带 beCode 才能核价/下单；用 --store 可指定其中一家。',
      };
    }

    const m = modeOf(mode);
    const text = await call('query-nearby-stores', {
      beType: m.beType,
      searchType: 2,
      city: a.city || '北京',
      keyword: a.keyword || '',
    });
    const stores = P.extractData(text) || [];
    return {
      ok: true,
      mode,
      count: stores.length,
      stores: stores.slice(0, 20).map((s) => ({
        storeCode: s.storeCode,
        beCode: s.beCode || null,
        name: s.storeName,
        address: s.address,
        distance: s.distance,
      })),
    };
  },

  async menu(a) {
    const menu = await loadMenu(a.store, a.mode, {
      enrich: a['no-enrich'] !== true,
      addressId: a.address || null,
    });
    return {
      ok: true,
      stats: menu.stats,
      categories: menu.categories.map((c) => ({ name: c.name.replace(/\s+/g, ''), key: c.key, count: c.count })),
      sample: menu.items.slice(0, 5).map((i) => ({ code: i.code, name: i.name, priceFen: i.price })),
    };
  },

  async solve(a) {
    if (!a.wants) throw new Error('缺少 --wants（例如 --wants "汉堡,饮料,小食"）');
    const menu = await loadMenu(a.store, a.mode, { addressId: a.address || null });
    const wants = resolveWants(String(a.wants).split(','), menu);

    const constraints = {};
    const budgetFen = fen(a.budget);
    if (budgetFen != null) constraints.budgetFen = budgetFen;
    if (a['max-kcal']) constraints.maxKcal = Number(a['max-kcal']);
    if (a['min-protein']) constraints.minProtein = Number(a['min-protein']);
    if (a.avoid) constraints.avoid = String(a.avoid).split(',').map((s) => s.trim()).filter(Boolean);

    const r = O.solve({ wants, constraints, weights: a.weights ? JSON.parse(a.weights) : undefined }, { menu, coupons: [] });

    return {
      ok: true,
      evaluated: r.evaluated,
      feasible: r.feasible,
      note: r.note,
      resolvedWants: wants.map((w) => ({
        label: w.label,
        by: w.categories ? 'categories' : w.category ? 'category' : w.code ? 'code' : 'name',
        value: w.categories ? w.categories.join(' | ') : w.category || w.code || w.anyOf?.[0],
      })),
      plans: (r.plans || []).map((p) => ({
        title: p.title,
        subtitle: p.subtitle,
        payableFen: p.payableFen,
        payableYuan: yuan(p.payableFen),
        kcal: p.nutrition?.kcal ?? null,
        kcalKnown: p.nutrition?.kcal != null,
        proteinG: p.nutrition?.protein ?? null,
        items: p.items.map((i) => ({ code: i.code, name: i.name, qty: i.qty, unitYuan: yuan(i.unitFen), kcal: i.kcal })),
      })),
    };
  },

  async advise(a) {
    if (!a.cart) throw new Error('缺少 --cart（例如 --cart "1100:1,4810:1"）');
    const menu = await loadMenu(a.store, a.mode, { addressId: a.address || null });
    const cart = cartOf(a.cart);
    const bad = cart.filter((c) => !menu.byCode.has(c.code));
    if (bad.length) throw new Error(`购物车里有不存在的商品 code：${bad.map((b) => b.code).join(', ')}`);

    const r = O.advise(cart, { menu, coupons: [] });
    return {
      ok: true,
      baseline: {
        payableFen: r.baseline.payableFen,
        payableYuan: yuan(r.baseline.payableFen),
        kcal: r.baseline.nutrition?.kcal ?? null,
      },
      totalSaveFen: r.totalSaveFen,
      totalSaveYuan: yuan(r.totalSaveFen),
      totalSaveBreakdown: r.totalSaveBreakdown,
      suggestions: r.suggestions.map((s) => ({
        type: s.type,
        from: s.type === 'bundle' ? s.from.map((x) => x.name) : s.from.name,
        to: s.to.name,
        saveYuan: yuan(s.saveFen),
        deltaKcal: s.deltaKcal,
        reason: s.reason,
        sameContent: s.sameContent !== false,
      })),
      caution: '建议只做「同类替换」与「单品打包成套餐」，不得把套餐换成单品（那是少买，不是省钱）。',
    };
  },

  async 'card-roi'(a) {
    const menu = await loadMenu(a.store, a.mode, { addressId: a.address || null });
    const r = cardRoi({
      items: menu.items,
      cart: cartOf(a.cart),
      byCode: menu.byCode,
      visitsPerMonth: a.visits ? Number(a.visits) : null,
      cardFeeFen: fen(a.fee),
    });
    return {
      ok: true,
      eligibleCount: r.eligibleCount,
      eligibleTotal: r.eligibleTotal,
      eligibleRatio: r.eligibleRatio,
      basketSaveFen: r.basket.saveFen,
      basketSaveYuan: yuan(r.basket.saveFen),
      feeCeilingPerVisitYuan: yuan(r.feeCeilingPerVisitFen),
      breakEvenVisits: r.breakEvenVisits,
      monthly: r.monthly,
      verdict: r.verdict,
      topItems: r.topItems.slice(0, 8).map((i) => ({
        name: i.name,
        listYuan: yuan(i.listFen),
        cardYuan: yuan(i.cardFen),
        saveYuan: yuan(i.saveFen),
      })),
      keyPoint: '「盈亏平衡卡费」是关键结论 —— 卡费低于它这一单就回本，不需要知道卡费本身。',
    };
  },

  /** 核价（官方权威价）。外送会自动带上 beCode，到店不需要。 */
  async price(a) {
    const cart = cartOf(a.cart);
    if (!cart.length) throw new Error('缺少 --cart');
    const menu = await loadMenu(a.store, a.mode, { enrich: false, addressId: a.address || null });
    const { storeCode, beCode, orderType, beType } = menu.__store;

    const args = { storeCode, orderType, beType, items: cart.map((c) => ({ productCode: c.code, quantity: c.qty })) };
    if (beCode) args.beCode = beCode;

    const data = P.extractData(await call('calculate-price', args)) || {};
    const takeWay = (data.takeWayList || []).map((t) => ({ title: t.title, code: t.takeWayCode || t.code }));
    return {
      ok: true,
      mode: menu.stats.mode,
      storeCode,
      beCode: beCode || null,
      productPriceYuan: yuan(data.productPrice),
      discountYuan: yuan(data.discount),
      payableYuan: yuan(data.price),
      takeWay,
      lines: (data.productList || []).map((p) => ({ name: p.productName, subtotalYuan: yuan(p.subtotal) })),
      warn: data.price === 0 ? '核价返回 0 —— 通常是 productCode 传错（静默失败），请检查 code 是否正确。' : undefined,
      note:
        orderType === 1
          ? '到店下单必须带 takeWayCode（从 takeWay 里选）。'
          : '外送下单不传 takeWayCode，但要带 addressId。',
    };
  },

  /**
   * 下单 —— ⚠️ **写入操作**，会在你的麦当劳账号里创建一张真实订单。
   *
   * 安全设计：
   *  ① 不带 --confirm 时只做**预演**，打印清单与金额，绝不创建订单；
   *  ② 本命令**不涉及支付**，创建后需在麦当劳官方 App / 小程序里付款；
   *  ③ 到店场景若 takeWayList 有多个取餐方式且没指定，会拒绝执行并要求先选。
   */
  async order(a) {
    const cart = cartOf(a.cart);
    if (!cart.length) throw new Error('缺少 --cart');
    const menu = await loadMenu(a.store, a.mode, { enrich: false, addressId: a.address || null });
    const { storeCode, beCode, orderType, beType, mode } = menu.__store;

    // 先核价：既拿到最终金额，也是 takeWayCode 的唯一来源
    const priceArgs = { storeCode, orderType, beType, items: cart.map((c) => ({ productCode: c.code, quantity: c.qty })) };
    if (beCode) priceArgs.beCode = beCode;
    const priced = P.extractData(await call('calculate-price', priceArgs)) || {};
    const takeWayList = (priced.takeWayList || []).map((t) => ({ title: t.title, code: t.takeWayCode || t.code }));

    let takeWayCode = a['take-way'] || null;
    if (orderType === 1) {
      // 传了就必须是合法的 —— 否则会静默按错误方式下单
      if (takeWayCode && takeWayList.length && !takeWayList.some((t) => t.code === takeWayCode)) {
        return {
          ok: false,
          invalidTakeWayCode: true,
          takeWay: takeWayList,
          error: `--take-way "${takeWayCode}" 不在可选范围内，请从 takeWay 里选一个。`,
        };
      }
      if (!takeWayCode) {
        if (takeWayList.length === 1) takeWayCode = takeWayList[0].code;
        else
          return {
            ok: false,
            needsTakeWayCode: true,
            takeWay: takeWayList,
            error: '到店下单需要指定取餐方式，请从 takeWay 里选一个，用 --take-way <code> 传入。',
          };
      }
    }

    const items = cart.map((c) => ({ productCode: c.code, quantity: c.qty }));
    const preview = {
      mode,
      storeCode,
      beCode: beCode || null,
      orderType,
      takeWayCode,
      takeWayTitle: (takeWayList.find((t) => t.code === takeWayCode) || {}).title || null,
      addressId: orderType === 2 ? a.address : undefined,
      items: items.map((i) => {
        const it = menu.byCode.get(i.productCode);
        return { code: i.productCode, name: it?.name ?? null, qty: i.quantity, unitYuan: yuan(it?.price) };
      }),
      payableYuan: yuan(priced.price),
      discountYuan: yuan(priced.discount),
    };

    if (a.confirm !== true && a.confirm !== 'true') {
      return {
        ok: true,
        confirmed: false,
        ...preview,
        warning:
          '⚠️ 这是**预演，没有创建订单**。下单是写入操作，会在你的麦当劳账号里生成一张真实订单（未支付）。' +
          '确认清单与金额无误后，再加 --confirm 才会真正下单。',
      };
    }

    const orderArgs = { storeCode, orderType, beType, items };
    if (beCode) orderArgs.beCode = beCode;
    if (takeWayCode) orderArgs.takeWayCode = takeWayCode;
    if (orderType === 2) orderArgs.addressId = a.address;
    if (a.remark) orderArgs.remark = a.remark;

    const data = P.extractData(await call('create-order', orderArgs)) || {};
    return {
      ok: true,
      confirmed: true,
      ...preview,
      orderId: data.orderId || data.orderCode || data.id || null,
      order: data,
      note: '订单已创建（未支付）。请到麦当劳官方 App / 小程序完成付款。',
    };
  },
};

/* --------------------------------- 出口 -------------------------------- */

function humanize(cmd, d) {
  if (cmd === 'solve') {
    const L = [`评估 ${d.evaluated} 个组合，可行 ${d.feasible} 个`];
    for (const p of d.plans) {
      L.push(`\n[${p.title}] ${p.payableYuan} · ${p.kcalKnown ? p.kcal + ' kcal' : '热量待核实'} · 蛋白 ${p.proteinG ?? '?'}g`);
      for (const i of p.items) L.push(`   ${i.name}${i.qty > 1 ? ' ×' + i.qty : ''}  ${i.unitYuan}`);
    }
    return L.join('\n');
  }
  if (cmd === 'advise') {
    const L = [`基线 ${d.baseline.payableYuan} · ${d.baseline.kcal ?? '?'} kcal · 可省 ${d.totalSaveYuan}`];
    for (const s of d.suggestions) {
      const from = Array.isArray(s.from) ? s.from.join(' + ') : s.from;
      L.push(`[${s.type === 'bundle' ? '打包' : '替换'}] ${from} → ${s.to}  省 ${s.saveYuan}  (${s.reason})`);
    }
    return L.join('\n');
  }
  if (cmd === 'card-roi') {
    return [
      `麦金卡可优惠 ${d.eligibleCount}/${d.eligibleTotal} 项（占 ${Math.round((d.eligibleRatio || 0) * 100)}%）`,
      `本单可省 ${d.basketSaveYuan}`,
      `**盈亏平衡卡费 ${d.feeCeilingPerVisitYuan}**`,
      // 本单没有卡价商品时，「N 次回本」会自相矛盾（可省 0 却说 1 次回本），所以只在真有节省时输出
      d.basketSaveFen > 0 && d.breakEvenVisits ? `按当前这单，约 ${d.breakEvenVisits} 次回本` : '',
      d.verdict || '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (cmd === 'addresses') {
    const L = [`共 ${d.count} 个收货地址：`];
    for (const a of d.addresses) L.push(`  [${a.addressId}] ${a.contactName} ${a.phone}  ${a.fullAddress}`);
    return L.join('\n');
  }
  if (cmd === 'order') {
    // 提前返回的失败结果（如缺 takeWayCode）没有 items，不能按成功结构渲染
    if (!Array.isArray(d.items)) return JSON.stringify(d, null, 2);
    const L = [];
    L.push(`渠道：${d.mode === 'delivery' ? '麦乐送' : '到店取餐'}　门店：${d.storeCode}`);
    if (d.takeWayTitle) L.push(`取餐方式：${d.takeWayTitle}（${d.takeWayCode}）`);
    L.push('清单：');
    for (const i of d.items) L.push(`  ${i.name ?? i.code} ×${i.qty}  ${i.unitYuan}`);
    L.push(`应付：${d.payableYuan}　优惠：${d.discountYuan}`);
    if (!d.confirmed) {
      L.push('');
      L.push('⚠️ 以上是**预演，没有创建订单**。');
      L.push('确认无误后，在命令末尾加 --confirm 才会真正下单。');
    } else {
      L.push('');
      L.push(`✔ 订单已创建：${d.orderId ?? '(未返回订单号)'}`);
      L.push('请到麦当劳官方 App / 小程序完成付款。');
    }
    return L.join('\n');
  }
  return JSON.stringify(d, null, 2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgv(argv.slice(1));

  if (!cmd || cmd === 'help' || a.help) {
    console.log(
      [
        '麦麦点餐官 CLI',
        '',
        '本工具支持两种渠道：',
        '  到店取餐（默认）  --mode takein',
        '  麦乐送（外送）    --mode delivery  ← 必须再给 --address <地址ID>',
        '',
        '  addresses            列出麦乐送收货地址（拿 addressId）',
        '  stores   [--city 北京] [--keyword 国贸] [--mode takein|delivery] [--address <id>]',
        '  menu     [--store <code>] [--mode takein] [--address <id>] [--no-enrich]',
        '  solve    --wants "汉堡,饮料,小食" [--store <code>] [--budget 40] [--max-kcal 700] [--min-protein 20] [--avoid 花生]',
        '  advise   --cart "1100:1,4810:1" [--store <code>]',
        '  card-roi --store <code> [--cart "..."] [--fee 19] [--visits 8]',
        '  price    --cart "..." [--store <code>]',
        '  order    --cart "..." [--store <code>] [--take-way <code>] [--remark 备注] [--confirm]',
        '           ⚠️ 不带 --confirm 只做预演，不会创建订单',
        '  tools',
        '',
        '外送示例：',
        '  node cli.mjs addresses',
        '  node cli.mjs menu  --mode delivery --address <addressId>',
        '  node cli.mjs solve --mode delivery --address <addressId> --wants "汉堡,饮料" --budget 50',
        '  node cli.mjs order --mode delivery --address <addressId> --cart "..." --confirm',
        '',
        '通用：--text 输出人话（默认 JSON）',
        '',
        'Token 来源：环境变量 MCD_MCP_TOKEN，或本机 ~/.workbuddy/mcp.json',
      ].join('\n')
    );
    return;
  }

  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`未知命令：${cmd}（用 node cli.mjs help 看用法）`);

  const data = await fn(a);
  if (a.text) console.log(humanize(cmd, data));
  else console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
