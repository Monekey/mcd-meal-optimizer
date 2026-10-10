/**
 * 麦麦点餐官 · 本地服务
 *
 * 为什么必须要一个后端：
 *  1) 麦当劳 MCP 是 Streamable HTTP（SSE），浏览器不能直连（CORS + 流式限制）
 *  2) MCP Token 代表真实会员身份，绝不能下发到前端
 *  3) 组合求解、营养匹配、档案存储都需要一个可信执行环境
 *
 * 前端必须用本服务的地址打开（如 http://127.0.0.1:8790），
 * 用 file:// 或静态预览面板打开会因为取不到 /api 而失败。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McdMcpClient, hasToken } from './mcp-client.mjs';
import * as P from './parse.mjs';
import * as M from '../core/menu.mjs';
import * as O from '../core/optimizer.mjs';
import { cardRoi } from '../core/card-roi.mjs';
import { enrichCombos, loadCache } from './enrich.mjs';
import { ProfileStore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8791);
const MENU_TTL_MS = 5 * 60 * 1000;

const client = new McdMcpClient();
const profiles = new ProfileStore(path.join(DATA, 'profiles.json'));

const menuCache = new Map();
const couponCache = { at: 0, data: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

const modeToParams = (mode) =>
  mode === 'delivery' ? { orderType: 2, beType: 2 } : { orderType: 1, beType: 1 };

/* ---------------------------------- 门店 ---------------------------------- */

async function getStores({ mode = 'takein', city = '北京', keyword = '', addressId = null } = {}) {
  const { beType } = modeToParams(mode);

  if (mode === 'delivery') {
    // 外送查门店只认地址：delivery-query-stores 的必填参数是 beType + addressId。
    // 早期版本在这里传了 city/keyword 而没传 addressId（当成了到店接口），结果永远是空列表。
    if (!addressId) {
      return {
        ok: false,
        needsAddress: true,
        stores: [],
        hint: '麦乐送必须先选收货地址。先调 GET /api/addresses 拿 addressId，再带 addressId 查询。',
      };
    }
    const r = await client.call('delivery-query-stores', { beType, addressId });
    if (!r.ok) return { ok: false, stores: [], raw: r.error || r.text.slice(0, 300) };
    const d = P.extractData(r.text) || {};
    return { ok: true, stores: d.stores || (Array.isArray(d) ? d : []) };
  }

  // 实测：searchType=2（按位置）+ 空 keyword 会返回空数组，
  // 因此这里做四级兜底，按"与用户意图的相关性"从强到弱排列：
  //   关键词 → 用城市名当关键词 → 泛关键词 → 收藏餐厅
  const attempts = [
    { beType, searchType: 2, city, keyword },
    { beType, searchType: 2, city, keyword: city },
    { beType, searchType: 2, city: '', keyword: '麦当劳' },
    { beType, searchType: 1 },
  ];

  for (const args of attempts) {
    const r = await client.call('query-nearby-stores', args);
    const stores = r.ok ? P.extractData(r.text) || [] : [];
    if (stores.length) return { ok: true, stores, strategy: JSON.stringify(args) };
  }
  return { ok: true, stores: [], strategy: 'all-failed' };
}

/* --------------------------------- 收货地址 -------------------------------- */

async function getAddresses() {
  const r = await client.call('delivery-query-addresses', {});
  if (!r.ok) return { ok: false, addresses: [], error: r.error || null };
  const d = P.extractData(r.text) || {};
  const list = d.addresses || (Array.isArray(d) ? d : []);
  return { ok: true, addresses: list };
}


/* ---------------------------------- 菜单 ---------------------------------- */

async function getMenu(storeCode, mode = 'takein', beCode = null) {
  const key = `${storeCode}:${mode}:${beCode || ''}`;
  const hit = menuCache.get(key);
  if (hit && Date.now() - hit.at < MENU_TTL_MS) return hit.value;

  const { orderType, beType } = modeToParams(mode);
  const args = { storeCode, orderType, beType };
  if (beCode) args.beCode = beCode; // 外送/得来速/团餐必传
  const menuRaw = P.extractData((await client.call('query-meals', args)).text);
  if (!menuRaw) throw new Error('菜单拉取失败（MCP 返回空或超时）');

  const nutriRes = await client.call('list-nutrition-foods', {});
  const nutrition = P.parseNutritionTable(nutriRes.text);

  const menu = M.normalizeMenu(menuRaw);
  M.attachNutrition(menu.items, nutrition);

  client.__storeCode = storeCode;
  client.__orderType = orderType;
  client.__beType = beType;
  const en = await enrichCombos(menu.items, {
    client,
    nutritionRows: nutrition,
    normName: M.normName,
    cacheFile: path.join(DATA, 'nutrition-cache.json'),
    budget: 14,
  });

  const value = {
    storeCode,
    mode,
    fetchedAt: new Date().toISOString(),
    nutrition,
    menu,
    stats: {
      sku: menu.items.length,
      categories: menu.categories.length,
      nutritionCoverage: menu.items.filter((i) => i.nutrition).length,
      comboEnriched: en.filled,
      mcCalls: en.mcCalls,
    },
  };
  menuCache.set(key, { at: Date.now(), value });
  return value;
}

/* ---------------------------------- 券 ---------------------------------- */

async function getCoupons(force = false) {
  if (!force && couponCache.data && Date.now() - couponCache.at < MENU_TTL_MS) return couponCache.data;
  const r = await client.call('query-my-coupons', {});
  const list = r.ok ? P.parseCouponList(r.text) : [];
  // "auto" = 优化器能自动用的（固定价券，且已知券价）
  const auto = list.filter((c) => c.kind === 'fixed-price' && c.price);
  couponCache.at = Date.now();
  couponCache.data = {
    total: list.length,
    autoUsable: auto.length,
    needsManual: list.length - auto.length,
    list,
  };
  return couponCache.data;
}

function ctxFor(storeCode, mode, coupons) {
  return { menu: null, coupons: coupons || [], storeCode, mode };
}

/* --------------------------------- 路由 --------------------------------- */

async function api(req, res, url) {
  const q = url.searchParams;
  const p = url.pathname;

  if (p === '/api/status') {
    let info = null;
    let tools = 0;
    if (client.configured) {
      try {
        info = await client.initialize();
        tools = client.__toolCount || 0;
      } catch {
        /* ignore */
      }
    }
    return json(res, 200, {
      configured: client.configured,
      demo: !client.configured,
      serverInfo: info,
      toolCount: tools,
      stats: client.stats,
      latestRankingHint: '本服务为本地运行，不代用户下单；所有写入类工具均需二次确认。',
    });
  }

  if (p === '/api/addresses') {
    return json(res, 200, await getAddresses());
  }

  if (p === '/api/stores') {
    const r = await getStores({
      mode: q.get('mode') || 'takein',
      city: q.get('city') || '北京',
      keyword: q.get('keyword') || '',
      addressId: q.get('addressId') || null,
    });
    return json(res, 200, r);
  }

  if (p === '/api/menu') {
    const storeCode = q.get('storeCode');
    const mode = q.get('mode') || 'takein';
    if (!storeCode) return json(res, 400, { error: 'storeCode 必填' });
    try {
      const m = await getMenu(storeCode, mode, q.get('beCode') || null);
      return json(res, 200, {
        storeCode,
        mode,
        beCode: q.get('beCode') || null,
        fetchedAt: m.fetchedAt,
        stats: m.stats,
        categories: m.menu.categories,
        items: m.menu.items,
      });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/coupons') {
    const c = await getCoupons(q.get('force') === '1');
    return json(res, 200, c);
  }

  if (p === '/api/solve' && req.method === 'POST') {
    const body = await readBody(req);
    const storeCode = body.storeCode;
    if (!storeCode) return json(res, 400, { error: 'storeCode 必填' });
    const m = await getMenu(storeCode, body.mode || 'takein', body.beCode || null);
    const coupons = (await getCoupons()).list;
    const profile = body.profileId ? profiles.get(body.profileId) : profiles.active();
    const constraints = { ...profiles.toConstraints(profile), ...(body.constraints || {}) };
    const result = O.solve({ wants: body.wants || [], constraints, weights: body.weights }, { menu: m.menu, coupons, constraints });
    return json(res, 200, { ...result, constraints, profileId: profile?.id || null });
  }

  if (p === '/api/advise' && req.method === 'POST') {
    const body = await readBody(req);
    const m = await getMenu(body.storeCode, body.mode || 'takein', body.beCode || null);
    const coupons = (await getCoupons()).list;
    return json(res, 200, O.advise(body.cart || [], { menu: m.menu, coupons, constraints: body.constraints || {} }));
  }

  if (p === '/api/card-roi') {
    const storeCode = q.get('storeCode');
    const m = await getMenu(storeCode, q.get('mode') || 'takein', q.get('beCode') || null);
    const cart = q.get('cart') ? JSON.parse(q.get('cart')) : [];
    const fee = q.get('feeFen');
    const visits = q.get('visits');
    return json(res, 200, cardRoi({
      items: m.menu.items,
      cart,
      byCode: m.menu.byCode,
      visitsPerMonth: visits ? Number(visits) : null,
      cardFeeFen: fee !== null && fee !== '' ? Number(fee) : null,
    }));
  }

  if (p === '/api/profiles') {
    if (req.method === 'GET') return json(res, 200, profiles.list());
    const body = await readBody(req);
    if (req.method === 'POST') {
      if (body.action === 'setActive') return json(res, 200, profiles.setActive(body.id));
      if (body.action === 'remove') return json(res, 200, profiles.remove(body.id));
      return json(res, 200, profiles.upsert(body.profile || body));
    }
    if (req.method === 'DELETE') return json(res, 200, profiles.remove(q.get('id')));
  }

  if (p === '/api/price' && req.method === 'POST') {
    const body = await readBody(req);
    const { orderType, beType } = modeToParams(body.mode || 'takein');
    const items = (body.items || []).map((i) => {
      const row = { productCode: i.code, quantity: i.qty || 1 };
      if (i.couponId) row.couponId = i.couponId;
      if (i.couponCode) row.couponCode = i.couponCode;
      return row;
    });
    const priceArgs = { storeCode: body.storeCode, orderType, beType, items };
    // 外送/得来速/团餐的核价必须带 beCode，否则拿不到正确价格
    if (beType !== 1 && body.beCode) priceArgs.beCode = body.beCode;
    if (body.reservationDate) priceArgs.reservationDate = body.reservationDate;
    const r = await client.call('calculate-price', priceArgs);
    return json(res, r.ok ? 200 : 502, { ok: r.ok, data: P.extractData(r.text), error: r.error || null, raw: r.ok ? undefined : r.text.slice(0, 600) });
  }

  if (p === '/api/order' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.confirm) {
      return json(res, 400, { error: '下单为写入类操作，必须带 confirm:true 二次确认', needConfirm: true });
    }
    const { orderType, beType } = modeToParams(body.mode || 'takein');
    const args = {
      storeCode: body.storeCode,
      orderType,
      beType,
      items: (body.items || []).map((i) => ({ productCode: i.code, quantity: i.qty || 1 })),
    };
    // ⚠️ takeWayCode 的合法取值只有核价返回的 takeWayList 里的 code（如 eat-in / 外带）。
    // 早期版本写死成 'take-in-store'，那是个不存在的值，会带着错误参数去下单。
    // 到店（orderType=1）必传且必须显式给出；外送不传。
    if (orderType === 1) {
      if (!body.takeWayCode) {
        return json(res, 400, {
          error: '到店下单必须提供 takeWayCode（取值范围见 /api/price 返回的 takeWayList）',
          needTakeWayCode: true,
        });
      }
      args.takeWayCode = body.takeWayCode;
    } else {
      if (body.beCode) args.beCode = body.beCode;
      if (!body.addressId) {
        return json(res, 400, { error: '外送下单必须提供 addressId', needAddress: true });
      }
      args.addressId = body.addressId;
    }
    if (body.remark) args.remark = body.remark;
    const r = await client.call('create-order', args);
    return json(res, r.ok ? 200 : 502, { ok: r.ok, data: P.extractData(r.text), error: r.error || null });
  }

  return json(res, 404, { error: 'not found' });
}

/* --------------------------------- 静态 --------------------------------- */

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await api(req, res, url);
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', async () => {
  if (client.configured) {
    try {
      await client.initialize();
      const tools = await client.listTools();
      client.__toolCount = tools.length;
      console.log(`✔ 麦当劳 MCP 已连接：${tools.length} 个工具 · serverInfo=${JSON.stringify(client.serverInfo)}`);
    } catch (e) {
      console.log(`✘ MCP 连接失败：${e.message}`);
    }
  } else {
    console.log('⚠ 未检测到 MCD_MCP_TOKEN，服务以「演示模式」启动（使用本地快照数据）');
  }
  console.log(`\n  麦麦点餐官已启动 →  http://127.0.0.1:${PORT}\n`);
  const cache = loadCache(path.join(DATA, 'nutrition-cache.json'));
  console.log(`  套餐营养缓存：${Object.keys(cache).length} 条`);
});

export { server, client, getMenu };
