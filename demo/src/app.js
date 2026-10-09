/* 离线演示的前端逻辑
 *
 * 说明：下面的 normalizeMenu / solve / advise / cardRoi / toYuanStr 等函数
 * 都是在构建时从 core/ 原样内联进来的（见 scripts/build-demo.mjs），
 * 所以这里的计算结果与线上服务完全一致 —— 不是另写一份"演示版算法"。
 */

const $ = (id) => document.getElementById(id);
// 注意：core 里的 toYuanStr 只负责"分 → 两位小数字符串"，货币符号在这里补
const yuan = (fen) => (fen == null ? '—' : '¥' + toYuanStr(fen));

/* ------------------------------ 组装上下文 ------------------------------ */

// 快照里的 items / categories 已经是「归一化后」的结构（价格已换算为整数分），
// 因此这里直接组装 ctx，不再走一遍 normalizeMenu —— 但求解器、建议器、卡 ROI
// 都是 core/ 里那同一套函数。
const MENU = {
  items: DATA.items.map((i) => ({
    ...i,
    categories: i.categories || [],
    categoryKeys: i.categoryKeys || [],
    nutrition: i.nutrition ? { ...i.nutrition, matchedName: null, matchMethod: 'snapshot' } : null,
  })),
  categories: DATA.categories.map((c) => ({ ...c, count: c.codes.length })),
  frequent: null,
};
MENU.byCode = new Map(MENU.items.map((i) => [i.code, i]));

const CTX = { menu: MENU, coupons: [] };

const state = { cat: DATA.categories[0]?.name || null, cart: [] };

/* -------------------------------- 渲染 -------------------------------- */

$('storeName').textContent = `${DATA.meta.storeName} · ${DATA.meta.sku} 个餐品`;

function renderRail() {
  $('rail').innerHTML = MENU.categories
    .map((c) => `<button data-c="${esc(c.name)}" class="${c.name === state.cat ? 'on' : ''}">${esc(c.name)}</button>`)
    .join('');
}

function renderList() {
  const cat = MENU.categories.find((c) => c.name === state.cat);
  const items = cat ? cat.codes.map((k) => MENU.byCode.get(k)).filter((i) => i && i.price != null) : [];
  $('list').innerHTML = items
    .map((it) => {
      const n = it.nutrition;
      const tg = [];
      if (it.isCardPrice) tg.push('<span class="tg card">麦金卡价</span>');
      if (n && n.kcal != null) tg.push(`<span class="tg kcal">${n.kcal} kcal</span>`);
      if (n && n.protein >= 20) tg.push(`<span class="tg">蛋白 ${n.protein}g</span>`);
      if (!n) tg.push('<span class="tg">营养待补全</span>');
      const img = it.image
        ? `<img src="${it.image}" alt="" loading="lazy" onerror="this.className='ph';this.removeAttribute('src')" />`
        : '<div class="ph"></div>';
      return `<div class="item">${img}
        <div class="info">
          <div class="nm">${esc(it.name)}</div>
          <div class="tags">${tg.join('')}</div>
          <div class="pr"><span class="now">${yuan(it.price)}</span>${it.isCardPrice ? `<span class="was">${yuan(it.originalPrice)}</span>` : ''}</div>
        </div>
        <button class="add" data-add="${it.code}">＋</button>
      </div>`;
    })
    .join('') || '<div class="empty">该分类暂无可售餐品</div>';
}

function totals() {
  let payable = 0;
  let list = 0;
  let card = 0;
  let kcal = 0;
  let partial = false;
  let count = 0;
  for (const { code, qty } of state.cart) {
    const it = MENU.byCode.get(code);
    if (!it) continue;
    count += qty;
    payable += it.price * qty;
    list += (it.originalPrice ?? it.price) * qty;
    if (it.isCardPrice) card += (it.originalPrice - it.price) * qty;
    if (it.nutrition && it.nutrition.kcal != null) kcal += it.nutrition.kcal * qty;
    else partial = true;
  }
  return { payable, list, card, kcal, partial, count };
}

function renderCart() {
  const t = totals();
  $('total').textContent = yuan(t.payable);
  $('sub').textContent = t.count
    ? `${t.count} 件 · ${t.partial ? '约 ' : ''}${t.kcal} kcal${t.card > 0 ? ` · 麦金卡省 ${yuan(t.card)}` : ''}`
    : '还没选东西';
  $('cartIco').classList.toggle('on', t.count > 0);
  $('cartDot').style.display = t.count ? '' : 'none';
  $('cartDot').textContent = t.count;
  $('optBtn').disabled = !t.count;

  const adv = t.count ? advise(state.cart, CTX) : null;
  const hint = $('saveHint');
  if (adv && adv.totalSaveFen > 0) {
    hint.classList.remove('hidden');
    $('saveText').textContent = `同样内容还能再省 ${yuan(adv.totalSaveFen)}`;
  } else {
    hint.classList.add('hidden');
  }
}

/* -------------------------------- 交互 -------------------------------- */

$('rail').onclick = (e) => {
  const b = e.target.closest('button[data-c]');
  if (!b) return;
  state.cat = b.dataset.c;
  renderRail();
  renderList();
};

$('list').onclick = (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const hit = state.cart.find((c) => c.code === b.dataset.add);
  if (hit) hit.qty += 1;
  else state.cart.push({ code: b.dataset.add, qty: 1 });
  renderCart();
};

$('optBtn').onclick = () => openModal('优化');
$('saveHint').onclick = () => openModal('优化');
$('mclose').onclick = closeModal;
$('mask').onclick = closeModal;

function openModal(tab) {
  $('mask').classList.add('on');
  $('modal').classList.add('on');
  renderModal(tab);
}
function closeModal() {
  $('mask').classList.remove('on');
  $('modal').classList.remove('on');
}

let currentTab = '优化';

function renderModal(tab) {
  currentTab = tab;
  $('mtitle').textContent = tab === '优化' ? '省钱与热量优化' : '麦金卡 ROI 精算';
  $('mbody').innerHTML = `
    <div class="tabs">
      <button data-t="优化" class="${tab === '优化' ? 'on' : ''}">优化建议</button>
      <button data-t="麦金卡" class="${tab === '麦金卡' ? 'on' : ''}">麦金卡 ROI</button>
    </div>
    <div id="tabBody">${tab === '优化' ? viewOptimize() : viewCard()}</div>`;
  $('mbody').querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => renderModal(b.dataset.t)));

  const tb = $('tabBody');
  tb.querySelectorAll('[data-swap]').forEach((b) => {
    b.onclick = () => {
      const adv = advise(state.cart, CTX);
      const s = adv.suggestions[+b.dataset.swap];
      const fromList = Array.isArray(s.from) ? s.from : [s.from];
      const totalQty = fromList.reduce((n, f) => n + (state.cart.find((c) => c.code === f.code)?.qty || 0), 0);
      if (!totalQty) return;

      const drop = new Set(fromList.map((f) => f.code));
      state.cart = state.cart.filter((c) => !drop.has(c.code));
      const addQty = s.type === 'bundle' ? 1 : totalQty;
      const hit = state.cart.find((c) => c.code === s.to.code);
      if (hit) hit.qty += addQty;
      else state.cart.push({ code: s.to.code, qty: addQty });

      renderCart();
      renderModal('优化');
    };
  });
  tb.querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = () => {
      const r = solve(planReq(), CTX);
      const p = r.plans[+b.dataset.apply];
      state.cart = p.items.map((i) => ({ code: i.code, qty: i.qty }));
      renderCart();
      renderModal('优化');
    };
  });
  const fee = $('fee');
  if (fee) fee.onchange = () => renderModal('麦金卡');
}

function planReq() {
  return {
    wants: state.cart.map((c) => {
      const it = MENU.byCode.get(c.code);
      // 用最"具体"的分类做替换范围（避开「人气热卖」这类宽泛聚合分类）
      const cat = bestCategoryFor(c.code, MENU.categories);
      const usable = cat && cat.count > 1;
      return { label: cat?.name || it?.name, category: usable ? cat.name : null, code: usable ? null : c.code, qty: c.qty };
    }),
  };
}

/* ------------------------------ 优化视图 ------------------------------ */

function viewOptimize() {
  const adv = advise(state.cart, CTX);
  const b = adv.baseline;
  const r = solve(planReq(), CTX);

  const swaps = adv.suggestions.length
    ? adv.suggestions
        .map((s, i) => {
          const isBundle = s.type === 'bundle';
          const fromNames = isBundle ? s.from.map((x) => x.name).join(' + ') : s.from.name;
          return `<div class="swap">
        <div class="txt">
          <span class="tg" style="margin-right:4px">${isBundle ? '打包' : '替换'}</span>
          <span style="color:#97979f">${esc(fromNames)}</span> → <b>${esc(s.to.name)}</b>
          <div class="d">${s.deltaKcal != null && s.deltaKcal > 0 ? `少 ${s.deltaKcal} kcal · ` : ''}${esc(s.reason)}</div>
        </div>
        <div class="sv">−${yuan(s.saveFen)}</div>
        <button data-swap="${i}">${isBundle ? '换套餐' : '换'}</button>
      </div>`;
        })
        .join('')
    : '<div class="note">这单在「内容不变少」的前提下没有更便宜的换法了 —— 挑得不错。</div>';

  const plans = (r.plans || [])
    .map(
      (p, i) => `<div class="plan ${i === 0 ? 'best' : ''}">
      <div class="hd"><span class="pt">${esc(p.title)}</span><span class="ps">${esc(p.subtitle)}</span><span class="pp">${yuan(p.payableFen)}</span></div>
      <div class="tags">
        <span class="tg kcal">${p.nutrition.kcal == null ? '热量未知' : p.nutrition.kcal + ' kcal' + (p.nutrition.partial ? '（部分）' : '')}</span>
        <span class="tg">蛋白 ${p.nutrition.protein ?? '?'}g</span>
        ${p.cardSavingsFen > 0 ? `<span class="tg card">麦金卡省 ${yuan(p.cardSavingsFen)}</span>` : ''}
      </div>
      <ul>${p.items.map((x) => `<li>${esc(x.name)}${x.qty > 1 ? ' ×' + x.qty : ''} · ${yuan(x.lineFen)}${x.kcal != null ? ` · ${x.kcal} kcal` : ''}</li>`).join('')}</ul>
      <button data-apply="${i}">用这套替换购物车</button>
    </div>`
    )
    .join('') || '<div class="note">没有找到可替换的组合。</div>';

  return `
    <div class="kpi">
      <div><div class="k">当前实付</div><div class="v">${yuan(b.payableFen)}</div></div>
      <div><div class="k">可优化</div><div class="v" style="color:#0f9d58">−${yuan(adv.totalSaveFen)}</div></div>
      <div><div class="k">当前热量</div><div class="v">${b.nutrition.kcal == null ? '—' : (b.nutrition.partial ? '≥' : '') + b.nutrition.kcal}<span style="font-size:10px;font-weight:400"> kcal</span></div></div>
    </div>
    <h4 style="font-size:12.5px;margin:14px 0 6px">最小改动建议（每一条都可以单独点「换」）</h4>
    <div class="d" style="font-size:11px;color:#97979f;margin-bottom:8px">
      只做「内容不变少」的替换：套餐只换套餐、单品只换单品；把单品打包成套餐也是允许的（内容只多不少）。
    </div>
    ${swaps}
    <h4 style="font-size:12.5px;margin:16px 0 8px">重新搭配的三条路线 · 共评估 ${r.evaluated} 个组合</h4>
    ${plans}
    ${r.note ? `<div class="note warn">${esc(r.note)}</div>` : ''}
  `;
}

/* ------------------------------ 麦金卡视图 ------------------------------ */

function viewCard() {
  const feeVal = $('fee') ? $('fee').value : '';
  const r = cardRoi({
    items: MENU.items,
    cart: state.cart,
    byCode: MENU.byCode,
    visitsPerMonth: 8,
    cardFeeFen: feeVal === '' ? null : Math.round(parseFloat(feeVal) * 100),
  });

  const max = r.topItems[0]?.saveFen || 1;
  const bars = r.topItems
    .slice(0, 8)
    .map(
      (i) => `<div class="bar2">
      <div class="nm" title="${esc(i.name)}">${esc(i.name)}</div>
      <div class="track"><div class="fill ${i.saveFen === max ? 'top' : ''}" style="width:${Math.round((i.saveFen / max) * 100)}%"></div></div>
      <div class="amt">−${yuan(i.saveFen)}</div>
    </div>`
    )
    .join('');

  return `
    <div class="kpi">
      <div><div class="k">卡价商品</div><div class="v">${r.eligibleCount}<span style="font-size:10px;font-weight:400"> / ${r.eligibleTotal}</span></div></div>
      <div><div class="k">本单可省</div><div class="v" style="color:#0f9d58">${yuan(r.basket.saveFen)}</div></div>
      <div><div class="k">盈亏平衡卡费</div><div class="v">${yuan(r.feeCeilingPerVisitFen)}</div></div>
    </div>
    <div class="note">${r.verdict.replace(/\n\n/g, '<br><br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>
    <h4 style="font-size:12.5px;margin:14px 0 8px">你的卡费是多少？（元）</h4>
    <input id="fee" type="number" step="1" value="${feeVal}" placeholder="如 19"
      style="width:100%;padding:9px 11px;border:1px solid #ececef;border-radius:9px;background:#fafafa;font:inherit" />
    <div class="d" style="font-size:11px;color:#97979f;margin-top:5px">
      卡费在 MCP 里查不到，所以这里让你填；不填也能给出「低于多少就值得买」。
    </div>
    <h4 style="font-size:12.5px;margin:16px 0 8px">本店麦金卡价 Top ${Math.min(8, r.topItems.length)}</h4>
    ${bars || '<div class="note">本店暂无麦金卡价商品。</div>'}
  `;
}

/* -------------------------------- 启动 -------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

renderRail();
renderList();
renderCart();
