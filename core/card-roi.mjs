/**
 * 麦金卡 / 早餐卡 ROI 精算
 *
 * 为什么这事能做：
 *   实测 query-meals 返回的每个 SKU 都带 discountType。持卡价商品的 discountType 为
 *   字符串「麦金卡优惠」，且 originalPrice > currentPrice —— 于是「单次能省多少」是
 *   可以纯数据算出来的，不需要任何硬编码。
 *
 * 为什么不能直接给「值不值」：
 *   MCP 没有任何工具能查到卡费（会员卡本身不在菜单 SKU 里，实测 canWithOrder 全为 false）。
 *   所以本模块的输出是「盈亏平衡卡费」——一个不依赖未知量的、可验证的结论。
 */

/** 麦金卡可优惠的商品清单 */
export function cardEligibleItems(items) {
  return items
    .filter((i) => i.isCardPrice && i.price != null && i.originalPrice != null && i.originalPrice > i.price)
    .map((i) => ({
      code: i.code,
      name: i.name,
      image: i.image,
      listFen: i.originalPrice,
      cardFen: i.price,
      saveFen: i.originalPrice - i.price,
      saveRate: (i.originalPrice - i.price) / i.originalPrice,
      categories: i.categories,
    }))
    .sort((a, b) => b.saveFen - a.saveFen);
}

/**
 * @param {object} p
 * @param {Array} p.items        归一化后的菜单 items
 * @param {Array} [p.cart]       [{code, qty}] 当前购物车
 * @param {number} [p.visitsPerMonth] 预估每月到店次数
 * @param {number} [p.cardFeeFen] 卡费（分）。未知时传 null，仍可算盈亏平衡点。
 * @param {object} [p.menu]      normalizeMenu 的结果（用于拿 byCode）
 */
export function cardRoi({ items, cart = [], visitsPerMonth = null, cardFeeFen = null, byCode = null }) {
  const eligible = cardEligibleItems(items);

  const savings = eligible.map((e) => e.saveFen).sort((a, b) => a - b);
  const median = savings.length ? savings[Math.floor(savings.length / 2)] : 0;
  const avg = savings.length ? Math.round(savings.reduce((s, x) => s + x, 0) / savings.length) : 0;

  // 当前购物车中可被麦金卡优惠覆盖的部分
  let basketListFen = 0;
  let basketCardFen = 0;
  const basketHits = [];
  if (byCode) {
    for (const { code, qty = 1 } of cart) {
      const it = byCode.get(code);
      if (!it || !it.isCardPrice) continue;
      basketListFen += it.originalPrice * qty;
      basketCardFen += it.price * qty;
      basketHits.push({ code, name: it.name, saveFen: (it.originalPrice - it.price) * qty, qty });
    }
  }
  const basketSaveFen = basketListFen - basketCardFen;

  // 盈亏平衡卡费：不依赖未知卡费的核心结论
  const feeCeilingPerVisitFen = basketSaveFen > 0 ? basketSaveFen : median;

  const result = {
    eligibleCount: eligible.length,
    eligibleTotal: items.length,
    eligibleRatio: items.length ? eligible.length / items.length : 0,
    topItems: eligible.slice(0, 10),
    stats: { min: savings[0] ?? 0, median, avg, max: savings[savings.length - 1] ?? 0 },
    basket: { saveFen: basketSaveFen, listFen: basketListFen, cardFen: basketCardFen, hits: basketHits },
    feeCeilingPerVisitFen,
    cardFeeFen,
    visitsPerMonth,
  };

  // 已知卡费 → 给回本次数与月度净收益
  if (cardFeeFen != null && cardFeeFen >= 0) {
    const perVisit = feeCeilingPerVisitFen || 0;
    result.breakEvenVisits = perVisit > 0 ? Math.ceil(cardFeeFen / perVisit) : null;
    if (visitsPerMonth) {
      const monthlySave = perVisit * visitsPerMonth;
      result.monthly = {
        saveFen: monthlySave,
        feeFen: cardFeeFen,
        netFen: monthlySave - cardFeeFen,
        netPositive: monthlySave - cardFeeFen > 0,
      };
    }
  }

  result.verdict = buildVerdict(result);
  return result;
}

function buildVerdict(r) {
  const y = (fen) => (fen / 100).toFixed(2);
  const parts = [];

  if (!r.eligibleCount) {
    return '这家门店当前没有麦金卡优惠商品，本单不适用。';
  }

  if (r.basket.hits.length) {
    parts.push(`本单里有 ${r.basket.hits.length} 项属于麦金卡优惠，用卡可省 ¥${y(r.basket.saveFen)}。`);
  } else {
    parts.push('**你这单里没有麦金卡优惠商品** —— 换成本店带「麦金卡价」的商品才会有优惠。');
  }
  parts.push(`全店共 ${r.eligibleCount} 项（占 ${Math.round(r.eligibleRatio * 100)}%）带麦金卡价，单项最大可省 ¥${y(r.stats.max)}，中位数 ¥${y(r.stats.median)}。`);
  parts.push(`**盈亏平衡点：只要卡费低于 ¥${y(r.feeCeilingPerVisitFen)}，${r.basket.hits.length ? '这一单' : '一次典型到店'}就已经回本。**`);

  if (r.breakEvenVisits) {
    parts.push(`按卡费 ¥${y(r.cardFeeFen)} 计算，大约要去 ${r.breakEvenVisits} 次才能回本。`);
  } else {
    parts.push('（卡费 MCP 查不到，填入卡费后可给出明确的回本次数。）');
  }

  if (r.monthly) {
    parts.push(
      r.monthly.netPositive
        ? `按月 ${r.visitsPerMonth} 次估算，月省 ¥${y(r.monthly.saveFen)}，扣除卡费净赚 ¥${y(r.monthly.netFen)}。`
        : `按月 ${r.visitsPerMonth} 次估算，月省 ¥${y(r.monthly.saveFen)}，仍低于卡费 ¥${y(r.monthly.feeFen)}，不建议买。`
    );
  }
  return parts.join('\n\n');
}

export default { cardRoi, cardEligibleItems };
