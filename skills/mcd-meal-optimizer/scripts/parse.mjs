/**
 * MCP 返回解析层
 *
 * 实测：麦当劳 MCP 的每个响应都是「给 LLM 看的说明 Markdown + 内嵌原始数据」的混合体，例如
 *
 *   # API Response Information
 *   ## Response Structure
 *   - **data**: 服务器时间信息 (Type: object)
 *     - **data.date**: 日期字符串 (yyyy-MM-dd)
 *   ...
 *   ## Original Response
 *   {"success":true,"code":200,"data":{...}}
 *
 * 而有的工具（如 query-store-coupons）只返回 Markdown 表格，没有 JSON 行。
 * 因此这里提供三种抽取器：JSON、Markdown 表格、伪表格（营养表）。
 */

/** 从混合文本里抽出第一个完整 JSON 对象（容错：JSON 后面可能还有说明文字） */
export function extractJson(text, { mustHave = null } = {}) {
  if (!text) return null;

  // 优先找 MCP 约定的原始响应锚点
  const anchors = ['## Original Response', '{"success"', '{"code"', '{'];
  for (const a of anchors) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(a, from);
      if (i < 0) break;
      const start = text.indexOf('{', i);
      if (start < 0) break;
      try {
        const obj = JSON.parse(text.slice(start, findBalancedEnd(text, start) + 1));
        if (!mustHave || Object.prototype.hasOwnProperty.call(obj, mustHave)) return obj;
      } catch {
        /* 尝试下一个位置 */
      }
      from = i + a.length;
    }
  }
  return null;
}

/** 找到从 index 处的 `{` 开始配平的 `}` 位置（跳过字符串与转义） */
function findBalancedEnd(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

/** 抽出 data 载荷；兼容 data 直接是对象/数组，或 {data:{data:...}} 的包装 */
export function extractData(text) {
  const root = extractJson(text, { mustHave: 'success' });
  if (!root) return null;
  let d = root.data;
  if (d && typeof d === 'object' && !Array.isArray(d) && 'data' in d) d = d.data;
  return d ?? null;
}

/**
 * 解析营养伪表格。实测格式：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     ...
 */
export function parseNutritionTable(text) {
  if (!text) return [];

  // 实测：该工具把整张表塞在一个字符串里，行分隔用的是「转义换行」而非真实换行
  const norm = String(text).replace(/\\r\\n|\\n|\\r/g, '\n');

  const m = norm.match(/\[(\d+)\]\{([^}]+)\}\s*:?\s*/);
  if (!m) return [];

  const header = m[2].split(',').map((s) => s.trim());
  const body = norm.slice(m.index + m[0].length);
  const rows = [];

  for (const line of body.split('\n')) {
    const l = line.trim();
    if (!l || !l.includes(',')) continue;
    const parts = l.split(',').map((s) => s.trim());
    if (parts.length < header.length) continue;

    const rec = {};
    header.forEach((k, i) => {
      const v = parts[i];
      if (v === 'null' || v === '') rec[k] = null;
      else if (/^-?\d+$/.test(v)) rec[k] = parseInt(v, 10);
      else if (/^-?\d*\.\d+$/.test(v)) rec[k] = parseFloat(v);
      else rec[k] = v;
    });
    if (rec[header[0]]) rows.push(rec);
  }
  return rows;
}
/** 解析 Markdown 表格 → 对象数组（用于券列表等只有表格返回的工具） */
export function parseMarkdownTables(text) {
  if (!text) return [];
  const tables = [];
  const lines = text.split('\n');

  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    const isRow = t.startsWith('|') && t.endsWith('|') && t.length > 2;
    if (!isRow) {
      if (cur && cur.rows.length) tables.push(cur);
      cur = null;
      continue;
    }
    const cells = t
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());

    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行

    if (!cur) cur = { header: cells, rows: [] };
    else cur.rows.push(cells);
  }
  if (cur && cur.rows.length) tables.push(cur);

  return tables.map((t) => t.rows.map((r) => Object.fromEntries(t.header.map((h, i) => [h, r[i] ?? null]))));
}

/**
 * 券解析：把「券名」反解成「目标商品 + 券价」。
 * 实测券名形如「9.9元中杯冰美式」「巨无霸类5折券」「下单立减3元券」，需要分类处理。
 */
export function parseCouponTitle(title) {
  if (!title) return { kind: 'unknown', raw: title };
  const s = String(title).trim();

  // 形如「9.9元中杯冰美式」/「￥9.9 中杯冰美式」
  let m = s.match(/^[¥￥]?\s*(\d+(?:\.\d+)?)\s*元\s*(.+)$/);
  if (m) return { kind: 'fixed-price', price: Math.round(parseFloat(m[1]) * 100), target: m[2].trim(), raw: s };

  // 形如「下单立减3元券」
  m = s.match(/立减\s*(\d+(?:\.\d+)?)\s*元/);
  if (m) return { kind: 'minus', amount: Math.round(parseFloat(m[1]) * 100), target: null, raw: s };

  // 形如「巨无霸类5折券」「5折券」
  m = s.match(/(\d+(?:\.\d+)?)\s*折/);
  if (m) {
    const discount = parseFloat(m[1]) / 10;
    const target = s.replace(/[\d.]+\s*折.*$/, '').replace(/券$/, '').trim();
    return { kind: 'ratio', discount, target: target ? target.replace(/类$/, '') : null, raw: s };
  }

  // 形如「买一赠一」「第二份半价」
  if (/买一赠一|买一送一/.test(s)) return { kind: 'bogo', target: null, raw: s };
  if (/第二份半价/.test(s)) return { kind: 'second-half', target: null, raw: s };

  return { kind: 'unknown', target: null, raw: s };
}

/** 渠道标签：券有「到店专用 / 外送专用」限制，优化时必须区分 */
export function parseCouponChannel(text) {
  const has = (k) => text.includes(k);
  const dineIn = has('到店专用') || has('到店');
  const delivery = has('外送专用') || has('外送');
  if (dineIn && !delivery) return 'dine-in';
  if (delivery && !dineIn) return 'delivery';
  return 'both';
}

/**
 * 解析 query-my-coupons 的 Markdown 券列表。实测格式：
 *   ## 9.9元中杯冰美式
 *   - **优惠**: ¥9.9 (用券价格)
 *   - **有效期**: 2026-10-07 00:00-2026-10-13 23:59
 *   - **标签**: 到店专用、外送专用
 */
export function parseCouponList(text) {
  if (!text) return [];
  const out = [];
  // 与营养表一致：MCP 有时把换行写成字面量 \n，先归一化再切块
  const norm = String(text).replace(/\\r\\n|\\n|\\r/g, '\n');
  const blocks = norm.split(/\n(?=#{2,3}\s)/);

  for (const b of blocks) {
    const m = b.match(/^#{2,3}\s*(.+)$/m);
    if (!m) continue;
    const raw = m[1].trim();
    if (/优惠券列表|使用规则|温馨提示/.test(raw)) continue;

    const field = (k) => {
      const r = new RegExp(`\\*\\*${k}\\*\\*[:：]\\s*(.+)`);
      const mm = b.match(r);
      return mm ? mm[1].trim().replace(/<[^>]+>/g, '') : null;
    };

    const discount = field('优惠') || '';
    const validity = field('有效期');
    const tags = field('标签') || '';
    const priceMatch = discount.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);

    const parsed = parseCouponTitle(raw);
    out.push({
      id: raw,
      raw,
      ...parsed,
      priceFen: parsed.price ?? (priceMatch ? Math.round(parseFloat(priceMatch[1]) * 100) : null),
      discountText: discount,
      validity,
      validTo: validity ? (validity.split('-').pop() || '').trim() : null,
      tags,
      channel: parseCouponChannel(tags || b),
    });
  }
  return out;
}

export default {
  extractJson,
  extractData,
  parseNutritionTable,
  parseMarkdownTables,
  parseCouponTitle,
  parseCouponChannel,
  parseCouponList,
};
