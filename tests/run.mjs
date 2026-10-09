/**
 * 可回归的测试用例
 *
 * 产品主张之一是「数值不进 LLM」——所有算术都在本地、整数分、确定性。
 * 因此这里用固定输入断言固定输出，任何人 clone 后 `npm test` 都能复现。
 *
 * 运行：node tests/run.mjs
 */

import assert from 'node:assert/strict';
import { toFen, toYuanStr, normName, normalizeMenu, attachNutrition, sumNutrition } from '../core/menu.mjs';
import { solve, advise, cartTotals, wantsFromCart, applyCoupons } from '../core/optimizer.mjs';
import { cardRoi } from '../core/card-roi.mjs';
import { parseNutritionTable, parseCouponTitle, parseCouponChannel, parseCouponList, extractData, parseMarkdownTables } from '../server/parse.mjs';

let pass = 0;
let fail = 0;
const cases = [];

function t(name, fn) {
  cases.push({ name, fn });
}

/* ------------------------------ 金额与浮点 ------------------------------ */

t('元字符串 → 整数分，不产生浮点误差', () => {
  assert.equal(toFen('33.5'), 3350);
  assert.equal(toFen('0.1'), 10);
  assert.equal(toFen('114.5'), 11450);
  assert.equal(toFen(24.9), 2490);
  assert.equal(toFen(null), null);
});

t('0.1 + 0.2 的经典浮点问题在分单位下不存在', () => {
  const a = toFen('0.1');
  const b = toFen('0.2');
  assert.equal(a + b, 30);
  assert.equal(toYuanStr(a + b), '0.30');
});

t('分 → 元显示固定两位', () => {
  assert.equal(toYuanStr(3350), '33.50');
  assert.equal(toYuanStr(5), '0.05');
  assert.equal(toYuanStr(null), '—');
});

/* --------------------------------- 解析 --------------------------------- */

t('营养伪表格：转义换行也能解析', () => {
  const text = '# API Response Information\\n\\n[2]{productName,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\\n  巨无霸,513,27,28,44,1010,190\\n  中薯条,289,4,12,38,165,18';
  const rows = parseNutritionTable(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].productName, '巨无霸');
  assert.equal(rows[0].energyKcal, 513);
  assert.equal(rows[1].protein, 4);
});

t('混合 Markdown + JSON 的响应能抽出 data', () => {
  const text = '## Response Structure\\n- **data**: 时间\\n\\n## Original Response\\n{"success":true,"code":200,"data":{"formatted":"2026-10-09 16:00:00"}}';
  const d = extractData(text);
  assert.equal(d.formatted, '2026-10-09 16:00:00');
});

t('券名反解：固定价 / 立减 / 折扣 / 买赠', () => {
  const a = parseCouponTitle('9.9元中杯冰美式');
  assert.equal(a.kind, 'fixed-price');
  assert.equal(a.price, 990);
  assert.equal(a.target, '中杯冰美式');

  const b = parseCouponTitle('下单立减3元券');
  assert.equal(b.kind, 'minus');
  assert.equal(b.amount, 300);

  const c = parseCouponTitle('巨无霸类5折券');
  assert.equal(c.kind, 'ratio');
  assert.equal(c.discount, 0.5);

  assert.equal(parseCouponTitle('麦旋风买一赠一').kind, 'bogo');
});

t('券渠道识别：到店券不能被当成外送券用', () => {
  assert.equal(parseCouponChannel('到店专用'), 'dine-in');
  assert.equal(parseCouponChannel('外送专用'), 'delivery');
  assert.equal(parseCouponChannel('到店专用、外送专用'), 'both');
});

t('券列表 Markdown 能解析成结构', () => {
  const text = '# 您的优惠券列表\\n共 1 张\\n\\n## 9.9元中杯冰美式\\n- **优惠**: ¥9.9 (用券价格)\\n- **有效期**: 2026-10-07 00:00-2026-10-13 23:59\\n- **标签**: 到店专用、外送专用';
  const list = parseCouponList(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].raw, '9.9元中杯冰美式');
  assert.equal(list[0].price, 990);
  assert.equal(list[0].channel, 'both');
});

/* -------------------------------- 菜单归一 -------------------------------- */

const FIXTURE_MENU = {
  categories: [
    { name: '巨无霸\n牛鱼肉堡', meals: [{ code: 'B1', tags: [] }, { code: 'B2', tags: [] }, { code: 'B3', tags: [] }, { code: 'C1', tags: [] }] },
    { name: '饮品', meals: [{ code: 'D1', tags: [] }] },
    { name: '小食', meals: [{ code: 'S1', tags: [] }] },
  ],
  meals: {
    B1: { name: '巨无霸', image: null, currentPrice: '25.5', originalPrice: '25.5', canWithOrder: false },
    B3: { name: '麦香鱼', image: null, currentPrice: '22.5', originalPrice: '22.5', canWithOrder: false },
    B2: { name: '安格斯厚牛堡四件套随心选', image: null, currentPrice: '37', originalPrice: '66', discountType: '麦金卡优惠', canWithOrder: false },
    C1: { name: '巨无霸三件套', image: null, currentPrice: '33.5', originalPrice: '46', canWithOrder: false },
    D1: { name: '中杯可乐', image: null, currentPrice: '9.5', originalPrice: '9.5', canWithOrder: false },
    S1: { name: '中薯条', image: null, currentPrice: '13.5', originalPrice: '13.5', canWithOrder: false },
  },
};

const FIXTURE_NUTRITION = [
  { productName: '巨无霸', energyKcal: 513, protein: 27, fat: 28, carbohydrate: 44, sodium: 1010, calcium: 190 },
  { productName: '麦香鱼', energyKcal: 325, protein: 16, fat: 12, carbohydrate: 39, sodium: 600, calcium: 120 },
  { productName: '中杯可乐', energyKcal: 150, protein: 0, fat: 0, carbohydrate: 38, sodium: 15, calcium: 5 },
  { productName: '中薯条', energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, calcium: 18 },
];

t('菜单归一：价格转分、分类 key 去掉换行、识别麦金卡价', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  assert.equal(m.items.length, 6);
  assert.equal(m.byCode.get('B1').price, 2550);
  assert.equal(m.byCode.get('B2').price, 3700);
  assert.equal(m.byCode.get('B2').originalPrice, 6600);
  assert.equal(m.byCode.get('B2').isCardPrice, true);
  assert.equal(m.categories[0].key, '巨无霸牛鱼肉堡');
});

t('营养匹配：精确命中', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  assert.equal(m.byCode.get('B1').nutrition.kcal, 513);
  assert.equal(m.byCode.get('D1').nutrition.matchMethod, 'exact');
  assert.equal(m.byCode.get('B2').nutrition, null, '套餐不应被误配成单品');
});

t('营养汇总：未知热量不按 0 虚报', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  const s = sumNutrition([
    { item: m.byCode.get('B1'), qty: 1 },
    { item: m.byCode.get('B2'), qty: 1 },
  ]);
  assert.equal(s.kcal, 513, '只累加已知部分');
  assert.equal(s.unknown, 1);
  assert.equal(s.partial, true);
  assert.ok(s.knownRatio < 1);
});

t('营养汇总：全部未知时热量为 null 而不是 0', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  const s = sumNutrition([{ item: m.byCode.get('B2'), qty: 2 }]);
  assert.equal(s.kcal, null);
  assert.equal(s.unknown, 2);
});

/* -------------------------------- 求解器 -------------------------------- */

const ctx = (() => {
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  return { menu: m, coupons: [] };
})();

t('求解器：预算约束下给出可行解，且实付不超预算', () => {
  const r = solve({ wants: [{ label: '汉堡', category: '巨无霸牛鱼肉堡', qty: 1 }], constraints: { budgetFen: 2600 } }, ctx);
  assert.ok(r.plans.length >= 1);
  for (const p of r.plans) assert.ok(p.payableFen <= 2600, `实付 ${p.payableFen} 超预算`);
  // 预算 ¥26 内最便宜的汉堡应该是麦香鱼 ¥22.5
  assert.equal(r.plans[0].items[0].name, '麦香鱼');
  assert.equal(r.plans[0].payableFen, 2250);
});

t('求解器：热量上限约束会排除热量未知的餐品（不允许用未知冒充达标）', () => {
  const r = solve(
    { wants: [{ label: '汉堡', category: '巨无霸牛鱼肉堡', qty: 1 }], constraints: { maxKcal: 600 } },
    ctx
  );
  for (const p of r.plans) {
    assert.equal(p.nutrition.unknown, 0, '带热量约束时不应出现未知项');
    assert.ok(p.nutrition.kcal <= 600);
  }
});

t('求解器：无可行解时给出提示而不崩', () => {
  const r = solve({ wants: [{ label: '汉堡', category: '巨无霸牛鱼肉堡', qty: 1 }], constraints: { budgetFen: 1 } }, ctx);
  assert.ok(r.note, '应有 note 说明');
});

t('求解器：品类不存在时给出可读错误', () => {
  const r = solve({ wants: [{ label: '寿司', category: '不存在', qty: 1 }] }, ctx);
  assert.equal(r.plans.length, 0);
  assert.match(r.note, /没有可用候选/);
});

/* ------------------------------- 购物车建议 ------------------------------- */

t('购物车建议：能识别同品类里更便宜的单品', () => {
  const r = advise([{ code: 'B1', qty: 1 }], ctx);
  assert.equal(r.baseline.payableFen, 2550);
  const swap = r.suggestions.find((s) => s.to.code === 'B3');
  assert.ok(swap, '巨无霸(25.5) 应能换成同类更便宜的 麦香鱼(22.5)');
  assert.equal(swap.saveFen, 300);
  assert.equal(swap.sameContent, true);
  assert.equal(swap.type, 'swap');
});

t('★ 替换建议不会把套餐换成单品（内容不能变少）', () => {
  // 这是用户实测反馈的真实缺陷：
  // 「安格斯厚牛堡四件套 ¥37 → 巨无霸 ¥25.5」看着省 ¥11.5，实际少了薯条和饮料。
  const r = advise([{ code: 'B2', qty: 1 }], ctx);
  const bad = r.suggestions.find((s) => s.type === 'swap' && s.to.code === 'B1');
  assert.ok(!bad, '不该把套餐推荐替换成单品');

  // 更普适的断言：任何 swap 建议里，套餐↔单品的跨界替换都不允许出现
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  const isCombo = (code) => /件套|随心选|套餐/.test(m.byCode.get(code).name);
  const cross = r.suggestions.filter((s) => s.type === 'swap' && isCombo(s.from.code) !== isCombo(s.to.code));
  assert.equal(cross.length, 0, `出现跨界替换：${cross.map((s) => s.from.name + '→' + s.to.name).join(', ')}`);
});

t('★ 套餐只能换到「内容不减少」的套餐', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  // 给两个套餐补上默认组成：B2 是四件套（含薯条+可乐），C1 是三件套（含薯条+可乐）
  m.byCode.get('B2').nutrition = {
    ...m.byCode.get('B2').nutrition,
    components: [{ name: '安格斯厚牛堡' }, { name: '中薯条' }, { name: '中杯可乐' }],
  };
  m.byCode.get('C1').nutrition = { ...m.byCode.get('C1').nutrition, components: [{ name: '巨无霸' }, { name: '中薯条' }] };
  const c = { menu: m, coupons: [] };
  const r = advise([{ code: 'B2', qty: 1 }], c);
  const toC1 = r.suggestions.find((s) => s.to.code === 'C1');
  // C1（巨无霸+中薯条）不覆盖 B2（安格斯+薯条+可乐）的组成 → 不允许作为替换
  assert.ok(!toC1, '内容更少的套餐不应被推荐为替换');
});

t('★ 多个单品可以打包成套餐并明确省钱', () => {
  const m = normalizeMenu(FIXTURE_MENU);
  attachNutrition(m.items, FIXTURE_NUTRITION);
  // 巨无霸三件套的默认组成 = 巨无霸 + 中薯条 + 中杯可乐（真实由 query-meal-detail 得到）
  m.byCode.get('C1').nutrition = {
    ...m.byCode.get('C1').nutrition,
    components: [{ name: '巨无霸' }, { name: '中薯条' }, { name: '中杯可乐' }],
  };
  const c = { menu: m, coupons: [] };
  // 单点：25.5 + 13.5 + 9.5 = 48.5，套餐 33.5
  const r = advise([{ code: 'B1', qty: 1 }, { code: 'S1', qty: 1 }, { code: 'D1', qty: 1 }], c);
  const bundle = r.suggestions.find((s) => s.type === 'bundle' && s.to.code === 'C1');
  assert.ok(bundle, '应给出「单点打包成套餐」建议');
  assert.equal(bundle.saveFen, 4850 - 3350);
  assert.equal(bundle.sameContent, true);
  assert.equal(bundle.coveredCodes.length, 3);
});

t('购物车建议：麦金卡价被正确算进基线', () => {
  const r = cartTotals([{ code: 'B2', qty: 1 }], ctx);
  assert.equal(r.payableFen, 3700);
  assert.equal(r.listFen, 6600);
  assert.equal(r.cardSavingsFen, 2900);
});

t('购物车建议：非食品（周边/酱料）不会被当成小食推荐', () => {
  const m = normalizeMenu({
    categories: [{ name: '小食', meals: [{ code: 'S1', tags: [] }, { code: 'S2', tags: [] }] }],
    meals: {
      S1: { name: '中薯条', currentPrice: '13.5', originalPrice: '13.5' },
      S2: { name: '薯条脆卜卜毛绒周边', currentPrice: '24.9', originalPrice: '29.9' },
    },
  });
  attachNutrition(m.items, [{ productName: '中薯条', energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, calcium: 18 }]);
  const r = advise([{ code: 'S1', qty: 1 }], { menu: m, coupons: [] });
  assert.ok(!r.suggestions.some((s) => s.to.code === 'S2'), '不应把毛绒周边推荐成小食替代');
});

/* -------------------------------- 麦金卡 -------------------------------- */

t('麦金卡 ROI：盈亏平衡卡费由真实卡价算出', () => {
  const r = cardRoi({ items: ctx.menu.items, cart: [{ code: 'B2', qty: 1 }], byCode: ctx.menu.byCode, visitsPerMonth: 8 });
  assert.equal(r.eligibleCount, 1);
  assert.equal(r.basket.saveFen, 2900);
  assert.equal(r.feeCeilingPerVisitFen, 2900);
  assert.match(r.verdict, /盈亏平衡/);
});

t('麦金卡 ROI：给出卡费后能算回本次数与月净收益', () => {
  const r = cardRoi({ items: ctx.menu.items, cart: [{ code: 'B2', qty: 1 }], byCode: ctx.menu.byCode, visitsPerMonth: 8, cardFeeFen: 1900 });
  assert.equal(r.breakEvenVisits, 1);
  assert.equal(r.monthly.netFen, 2900 * 8 - 1900);
  assert.equal(r.monthly.netPositive, true);
});

t('麦金卡 ROI：无卡价商品时给出明确结论', () => {
  const r = cardRoi({ items: [ctx.menu.byCode.get('B1')], cart: [], byCode: ctx.menu.byCode });
  assert.equal(r.eligibleCount, 0);
  assert.match(r.verdict, /没有麦金卡优惠商品/);
});

/* -------------------------------- 券参与优化 -------------------------------- */

t('券作为虚拟行参与估价：券价低于菜单价时生效', () => {
  const coupons = [{ id: 'c1', kind: 'fixed-price', price: 500, target: '中杯可乐', raw: '5元中杯可乐', couponId: 'C1' }];
  const c = { ...ctx, coupons };
  const base = cartTotals([{ code: 'D1', qty: 1 }], c);
  assert.equal(base.payableFen, 950, '基线是菜单价 9.5');

  const withC = applyCoupons(base.lines, c);
  assert.equal(withC.couponsUsed.length, 1);
  assert.equal(withC.payableFen, 500, '挂券后按券价 5 元');
  assert.equal(withC.couponSavingsFen, 450);
});

t('券不划算时不会被挂上（券价高于菜单价）', () => {
  const coupons = [{ id: 'c2', kind: 'fixed-price', price: 990, target: '中杯可乐', raw: '9.9元中杯可乐', couponId: 'C2' }];
  const c = { ...ctx, coupons };
  const base = cartTotals([{ code: 'D1', qty: 1 }], c);
  const withC = applyCoupons(base.lines, c);
  assert.equal(withC.couponsUsed.length, 0, '9.9 > 9.5，不应挂券');
  assert.equal(withC.payableFen, 950);
});

/* --------------------------------- 运行 --------------------------------- */

for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`  ✔ ${c.name}`);
  } catch (e) {
    fail++;
    console.log(`  ✘ ${c.name}`);
    console.log(`      ${e.message.split('\n')[0]}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${cases.length} 项`);
process.exit(fail ? 1 : 0);
