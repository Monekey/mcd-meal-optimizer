/* 麦麦点餐官 · 前端
 *
 * 三条产品主张：
 *  1. 不改变使用习惯 —— 布局照搬「左侧分类 + 右侧商品 + 底部购物车」的官方点餐动线
 *  2. 官方没有的能力 —— 购物车旁实时提示「还能再省多少 / 少摄入多少」，一键换方案
 *  3. 多档案共享一个会员账户 —— 给不同的人/场景设定不同的预算与热量目标
 */

const $ = (id) => document.getElementById(id);
const yuan = (fen) => (fen == null ? '—' : '¥' + (fen / 100).toFixed(2));

const state = {
  mode: 'takein',
  store: null,
  menu: null,
  cart: [],          // [{code, qty}]
  activeCat: null,
  profiles: { activeId: null, profiles: [] },
  advice: null,
  busy: false,
};

/* ---------------------------------- 工具 ---------------------------------- */

async function api(path, opts) {
  const res = await fetch(path, opts);
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(txt.slice(0, 300) || `HTTP ${res.status}`);
  }
}

const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

function openSheet(title, html, footHtml) {
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = html;
  const ft = $('sheetFoot');
  if (footHtml) {
    ft.innerHTML = footHtml;
    ft.style.display = '';
  } else {
    ft.style.display = 'none';
  }
  $('mask').classList.add('on');
  $('sheet').classList.add('on');
  $('sheetBody').scrollTop = 0;
}

function closeSheet() {
  $('mask').classList.remove('on');
  $('sheet').classList.remove('on');
}

$('mask').onclick = closeSheet;
$('sheetClose').onclick = closeSheet;

/* -------------------------------- 初始化 -------------------------------- */

async function boot() {
  bindStatic();
  try {
    const st = await api('/api/status');
    if (!st.configured) toast('未检测到 MCP Token，部分功能不可用');
  } catch { /* 忽略 */ }

  await loadProfiles();
  await loadStores();
}

function bindStatic() {
  $('modeSwitch').onclick = (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    [...$('modeSwitch').children].forEach((x) => x.classList.toggle('on', x === b));
    state.cart = [];
    state.advice = null;
    loadStores();
  };
  $('storeChange').onclick = showStorePicker;
  $('cartIco').onclick = showCart;
  $('ctaBtn').onclick = showCart;
  $('saveHintGo').onclick = showOptimizer;
  $('saveHint').onclick = showOptimizer;
}

/* --------------------------------- 档案 --------------------------------- */

async function loadProfiles() {
  state.profiles = await api('/api/profiles');
}
const activeProfile = () => state.profiles.profiles.find((p) => p.id === state.profiles.activeId) || state.profiles.profiles[0];

async function showProfiles() {
  const p = state.profiles;
  const html = `
    <div class="note" style="margin-bottom:12px">
      麦当劳 MCP 的身份凭证绑定的是<b>一个真实会员账户</b>，所以这里不是「切换人」，
      而是<b>同一个账户下的多份点餐档案</b>——各自有不同的预算、热量目标与忌口。
    </div>
    ${p.profiles
      .map(
        (x) => `<div class="profile-row ${x.id === p.activeId ? 'on' : ''}" data-id="${x.id}">
          <div class="av">${x.emoji || '🙂'}</div>
          <div class="nm">${esc(x.name)}
            <div class="ds">${[
              x.budgetFen ? `预算 ${yuan(x.budgetFen)}` : '不限预算',
              x.maxKcal ? `≤${x.maxKcal} kcal` : '不限热量',
              x.avoid?.length ? `忌口 ${x.avoid.join('/')}` : '无忌口',
            ].join(' · ')}</div>
          </div>
          <button class="pick" data-id="${x.id}">${x.id === p.activeId ? '使用中' : '选用'}</button>
        </div>`
      )
      .join('')}
    <button class="cta" id="addProfile" style="width:100%;margin-top:6px">＋ 新建档案</button>
  `;
  openSheet('点餐档案', html);

  $('sheetBody').querySelectorAll('.pick').forEach((b) => {
    b.onclick = async () => {
      state.profiles = await post('/api/profiles', { action: 'setActive', id: b.dataset.id });
      closeSheet();
      render();
      if (state.cart.length) refreshAdvice();
    };
  });

  $('addProfile').onclick = () => showProfileEditor(null);
}

function showProfileEditor(profile) {
  const p = profile || { name: '', emoji: '🙂', budgetFen: 4000, maxKcal: null, minProtein: null, avoid: [], visitsPerMonth: 8, cardFeeFen: null };
  const emojis = ['🙂', '💪', '🥗', '👨‍👩‍👧', '🧑‍💻', '🎒'];
  const html = `
    <div class="field"><label>档案名</label><input type="text" id="pfName" value="${esc(p.name)}" placeholder="如：减脂期的我 / 爸爸 / 拼单" /></div>
    <div class="field"><label>头像</label><div class="chips" id="pfEmoji">${emojis
      .map((e) => `<button data-e="${e}" class="${e === p.emoji ? 'on' : ''}">${e}</button>`)
      .join('')}</div></div>
    <div class="field"><label>单次预算（元，留空为不限）</label><input type="number" id="pfBudget" step="1" value="${p.budgetFen ? p.budgetFen / 100 : ''}" placeholder="40" /></div>
    <div class="field"><label>热量上限（kcal，留空为不限）</label><input type="number" id="pfKcal" step="10" value="${p.maxKcal ?? ''}" placeholder="700" />
      <div class="hint">设了热量上限后，热量数据缺失的餐品会被排除——我们不会用"未知"冒充"达标"。</div></div>
    <div class="field"><label>蛋白质下限（g，留空为不限）</label><input type="number" id="pfProtein" step="1" value="${p.minProtein ?? ''}" placeholder="20" /></div>
    <div class="field"><label>忌口 / 排除关键词（逗号分隔）</label><input type="text" id="pfAvoid" value="${esc((p.avoid || []).join('，'))}" placeholder="香菜，辣椒" /></div>
    <div class="field"><label>每月大概吃几次（用于算麦金卡回本）</label><input type="number" id="pfVisits" step="1" value="${p.visitsPerMonth ?? 8}" /></div>
  `;
  openSheet(profile ? '编辑档案' : '新建档案', html, `<button class="cta" id="pfSave" style="width:100%">保存</button>`);

  let emoji = p.emoji;
  $('pfEmoji').onclick = (e) => {
    const b = e.target.closest('button[data-e]');
    if (!b) return;
    emoji = b.dataset.e;
    [...$('pfEmoji').children].forEach((x) => x.classList.toggle('on', x === b));
  };

  $('pfSave').onclick = async () => {
    const body = {
      profile: {
        id: profile?.id,
        name: $('pfName').value.trim() || '未命名档案',
        emoji,
        budgetFen: $('pfBudget').value ? Math.round(parseFloat($('pfBudget').value) * 100) : null,
        maxKcal: $('pfKcal').value ? parseInt($('pfKcal').value, 10) : null,
        minProtein: $('pfProtein').value ? parseInt($('pfProtein').value, 10) : null,
        avoid: $('pfAvoid').value.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean),
        visitsPerMonth: $('pfVisits').value ? parseInt($('pfVisits').value, 10) : 8,
        cardFeeFen: profile?.cardFeeFen ?? null,
      },
    };
    await post('/api/profiles', body);
    await loadProfiles();
    closeSheet();
    render();
    if (state.cart.length) refreshAdvice();
    toast('档案已保存');
  };
}

/* --------------------------------- 门店 --------------------------------- */

async function loadStores() {
  $('list').innerHTML = '<div class="loading">正在定位门店…</div>';
  try {
    const r = await api(`/api/stores?mode=${state.mode}&city=${encodeURIComponent('北京')}`);
    const stores = r.stores || [];
    if (!stores.length) {
      $('list').innerHTML = '<div class="empty">附近没有查到门店，点右上角「切换」换个城市试试</div>';
      return;
    }
    state.stores = stores;
    selectStore(stores[0]);
  } catch (e) {
    $('list').innerHTML = `<div class="empty">门店查询失败：${esc(e.message)}</div>`;
  }
}

async function selectStore(s) {
  state.store = s;
  $('storeName').innerHTML = `${esc(s.storeName || '未命名门店')} <span class="sub">${s.distance != null ? Math.round(s.distance) + 'm' : ''}</span>`;
  await loadMenu();
}

async function showStorePicker() {
  const list = state.stores || [];
  openSheet(
    '选择门店',
    list
      .map(
        (s) => `<div class="profile-row ${s.storeCode === state.store?.storeCode ? 'on' : ''}" data-code="${s.storeCode}">
          <div class="av">🏪</div>
          <div class="nm">${esc(s.storeName)}
            <div class="ds">${esc(s.address || '')} · ${s.distance != null ? Math.round(s.distance) + 'm' : ''} · ${s.businessStartTime || ''}-${s.businessEndTime || ''}</div>
          </div>
        </div>`
      )
      .join('') || '<div class="empty">暂无可选门店</div>'
  );
  $('sheetBody').querySelectorAll('[data-code]').forEach((el) => {
    el.onclick = () => {
      const s = list.find((x) => String(x.storeCode) === el.dataset.code);
      closeSheet();
      if (s) selectStore(s);
    };
  });
}

/* --------------------------------- 菜单 --------------------------------- */

async function loadMenu() {
  if (!state.store) return;
  $('list').innerHTML = '<div class="loading">正在读取门店实时菜单与营养数据…<br><span style="font-size:11px">首次加载需补全套餐营养，约 5–10 秒</span></div>';
  $('rail').innerHTML = '';
  try {
    const m = await api(`/api/menu?storeCode=${state.store.storeCode}&mode=${state.mode}`);
    if (m.error) throw new Error(m.error);
    state.menu = m;
    state.activeCat = m.categories[0]?.name || null;
    render();
    const s = m.stats;
    toast(`菜单就绪：${s.sku} 个餐品 · 营养覆盖 ${s.nutritionCoverage} 项`);
  } catch (e) {
    $('list').innerHTML = `<div class="empty">菜单加载失败：${esc(e.message)}</div>`;
  }
}

function render() {
  if (!state.menu) return;
  renderRail();
  renderList();
  renderCart();
}

function renderRail() {
  $('rail').innerHTML = state.menu.categories
    .map((c) => `<button data-cat="${esc(c.name)}" class="${c.name === state.activeCat ? 'on' : ''}">${esc(c.name)}</button>`)
    .join('');
  $('rail').onclick = (e) => {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    state.activeCat = b.dataset.cat;
    renderRail();
    renderList();
  };
}

function itemCard(it) {
  const n = it.nutrition;
  const tags = [];
  if (it.isCardPrice) tags.push('<span class="tag card">麦金卡价</span>');
  if (n?.kcal != null) tags.push(`<span class="tag kcal">${n.kcal} kcal</span>`);
  if (n?.protein != null && n.protein >= 20) tags.push(`<span class="tag">蛋白 ${n.protein}g</span>`);
  if (!n) tags.push('<span class="tag">营养待补全</span>');

  const img = it.image
    ? `<img src="${it.image}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))" />`
    : '<div class="ph"></div>';

  return `<div class="item">
    ${img}
    <div class="info">
      <div class="nm">${esc(it.name)}</div>
      <div class="meta">${tags.join('')}</div>
      <div class="price">
        <span class="now">${yuan(it.price)}</span>
        ${it.isCardPrice ? `<span class="was">${yuan(it.originalPrice)}</span>` : ''}
      </div>
    </div>
    <button class="add" data-add="${it.code}">＋</button>
  </div>`;
}

function renderList() {
  const cat = state.menu.categories.find((c) => c.name === state.activeCat);
  if (!cat) {
    $('list').innerHTML = '<div class="empty">请选择左侧分类</div>';
    return;
  }
  const codes = new Set(cat.codes);
  const items = state.menu.items.filter((i) => codes.has(i.code) && i.price != null);
  $('list').innerHTML = items.length ? items.map(itemCard).join('') : '<div class="empty">该分类暂无可售餐品</div>';
  $('list').onclick = (e) => {
    const b = e.target.closest('[data-add]');
    if (b) addToCart(b.dataset.add);
  };
}

/* -------------------------------- 购物车 -------------------------------- */

function addToCart(code) {
  const hit = state.cart.find((c) => c.code === code);
  if (hit) hit.qty += 1;
  else state.cart.push({ code, qty: 1 });
  renderCart();
  scheduleAdvice();
}

function setQty(code, qty) {
  const hit = state.cart.find((c) => c.code === code);
  if (!hit) return;
  hit.qty = qty;
  state.cart = state.cart.filter((c) => c.qty > 0);
  renderCart();
  if (state.cart.length) scheduleAdvice();
  else {
    state.advice = null;
    $('saveHint').classList.add('hidden');
  }
}

function cartLines() {
  const by = new Map((state.menu?.items || []).map((i) => [i.code, i]));
  return state.cart.map((c) => ({ item: by.get(c.code), qty: c.qty })).filter((x) => x.item);
}

function cartTotals() {
  let payable = 0;
  let list = 0;
  let kcal = 0;
  let kcalPartial = false;
  for (const { item, qty } of cartLines()) {
    payable += (item.price || 0) * qty;
    list += (item.originalPrice ?? item.price ?? 0) * qty;
    if (item.nutrition?.kcal != null) kcal += item.nutrition.kcal * qty;
    else kcalPartial = true;
  }
  return { payable, list, cardSave: list - payable, kcal, kcalPartial, count: state.cart.reduce((s, c) => s + c.qty, 0) };
}

function renderCart() {
  const t = cartTotals();
  $('cartTotal').textContent = yuan(t.payable);
  $('cartSub').textContent = t.count
    ? `${t.count} 件 · ${t.kcalPartial ? '约 ' : ''}${t.kcal} kcal${t.cardSave > 0 ? ` · 麦金卡省 ${yuan(t.cardSave)}` : ''}`
    : '购物车是空的';
  const ico = $('cartIco');
  ico.classList.toggle('empty', !t.count);
  const dot = $('cartDot');
  dot.style.display = t.count ? '' : 'none';
  dot.textContent = t.count;
  $('ctaBtn').disabled = !t.count;
}

let adviceTimer;
function scheduleAdvice() {
  clearTimeout(adviceTimer);
  adviceTimer = setTimeout(refreshAdvice, 350);
}

async function refreshAdvice() {
  if (!state.cart.length || !state.menu) return;
  try {
    const r = await post('/api/advise', { storeCode: state.store.storeCode, mode: state.mode, cart: state.cart });
    state.advice = r;
    const hint = $('saveHint');
    if (r.totalSaveFen > 0) {
      hint.classList.remove('hidden');
      $('saveHintText').textContent = `同样内容还能再省 ${yuan(r.totalSaveFen)}`;
    } else if (r.suggestions.some((s) => s.deltaKcal != null && s.deltaKcal > 0)) {
      hint.classList.remove('hidden');
      const dk = r.suggestions.reduce((s, x) => s + (x.deltaKcal || 0), 0);
      $('saveHintText').textContent = `换个搭配可以少吃 ${dk} kcal`;
    } else {
      hint.classList.add('hidden');
    }
  } catch {
    /* 建议失败不影响点餐 */
  }
}

function showCart() {
  const lines = cartLines();
  if (!lines.length) return;
  const t = cartTotals();
  const html = `
    ${lines
      .map(
        ({ item, qty }) => `<div class="profile-row">
        <div class="av">${item.image ? `<img src="${item.image}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : '🍔'}</div>
        <div class="nm">${esc(item.name)}
          <div class="ds">${yuan(item.price)} ${item.nutrition?.kcal != null ? `· ${item.nutrition.kcal} kcal` : '· 营养待补全'}${
            item.isCardPrice ? ` · <span style="color:#9a6a00">麦金卡价，省 ${yuan(item.originalPrice - item.price)}</span>` : ''
          }</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button data-dec="${item.code}" style="font-size:18px;color:#9a9a9a">−</button>
          <span style="min-width:16px;text-align:center">${qty}</span>
          <button data-inc="${item.code}" style="font-size:18px;color:#db0007">＋</button>
        </div>
      </div>`
      )
      .join('')}
    <div class="kpi" style="margin-top:12px">
      <div><div class="k">实付</div><div class="v" style="color:#db0007">${yuan(t.payable)}</div></div>
      <div><div class="k">原价</div><div class="v" style="font-weight:500;font-size:14px">${yuan(t.list)}</div></div>
      <div><div class="k">热量</div><div class="v">${t.kcalPartial ? '≥' : ''}${t.kcal}<span style="font-size:11px;font-weight:400"> kcal</span></div></div>
    </div>
    ${t.cardSave > 0 ? `<div class="note">其中 ${yuan(t.cardSave)} 来自麦金卡优惠。想确认卡值不值得长期买？<b id="roiLink" style="color:#db0007;cursor:pointer">算一下回本点 →</b></div>` : ''}
    ${t.kcalPartial ? '<div class="note warn" style="margin-top:8px">有餐品热量数据缺失，合计热量仅为已知部分之和，标了「≥」。</div>' : ''}
  `;
  openSheet(
    '购物车',
    html,
    `<div style="display:flex;gap:10px"><button class="cta" id="coBtn" style="flex:1">去结算 ${yuan(t.payable)}</button></div>`
  );

  $('sheetBody').querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => { setQty(b.dataset.inc, (state.cart.find((c) => c.code === b.dataset.inc)?.qty || 0) + 1); showCart(); }));
  $('sheetBody').querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => { setQty(b.dataset.dec, (state.cart.find((c) => c.code === b.dataset.dec)?.qty || 0) - 1); showCart(); }));
  if ($('roiLink')) $('roiLink').onclick = showCardRoi;
  $('coBtn').onclick = showCheckout;
}

/* -------------------------------- 优化建议 -------------------------------- */

async function showOptimizer() {
  if (!state.cart.length) return toast('先加两样东西吧');
  openSheet('省钱与热量优化', '<div class="loading">正在枚举组合并核价…</div>');

  let adv = state.advice;
  let planRes = null;
  try {
    adv = await post('/api/advise', { storeCode: state.store.storeCode, mode: state.mode, cart: state.cart });
    state.advice = adv;
    const wants = state.cart.map((c) => {
      const item = state.menu.items.find((i) => i.code === c.code);
      // 取「最具体」的分类（count 最小）作为替换范围，避免拿奶茶去替换汉堡
      const cats = state.menu.categories.filter((x) => x.codes.includes(c.code)).sort((a, b) => a.count - b.count);
      const cat = cats[0];
      const usable = cat && cat.count > 1;
      return { label: cat?.name || item?.name, category: usable ? cat.name : null, code: usable ? null : c.code, qty: c.qty };
    });
    planRes = await post('/api/solve', { storeCode: state.store.storeCode, mode: state.mode, wants });
  } catch (e) {
    $('sheetBody').innerHTML = `<div class="empty">优化失败：${esc(e.message)}</div>`;
    return;
  }

  const base = adv.baseline;
  const html = `
    <div class="kpi">
      <div><div class="k">当前实付</div><div class="v">${yuan(base.payableFen)}</div></div>
      <div><div class="k">可优化</div><div class="v" style="color:#12a150">−${yuan(adv.totalSaveFen)}</div></div>
      <div><div class="k">当前热量</div><div class="v">${base.nutrition.kcal ?? '—'}<span style="font-size:11px;font-weight:400"> kcal</span></div></div>
    </div>

    <h4 style="font-size:13px;margin:14px 0 8px">最小改动建议</h4>
    <div class="hint" style="font-size:11px;color:#9a9a9a;margin:-4px 0 8px">
      只做「内容不变少」的替换：套餐只能换套餐、单品只能换单品；把单品打包成套餐也是允许的（内容只多不少）。
    </div>
    ${adv.suggestions.length
      ? adv.suggestions
          .map((s, i) => {
            const isBundle = s.type === 'bundle';
            const fromNames = isBundle ? s.from.map((x) => x.name).join(' + ') : s.from.name;
            const btn = isBundle ? '换套餐' : '换';
            return `<div class="swap">
          <div class="txt">
            <span class="tag" style="margin-right:4px">${isBundle ? '打包' : '替换'}</span>
            <span style="color:#9a9a9a">${esc(fromNames)}</span> <span class="arrow">→</span> <b>${esc(s.to.name)}</b>
            <div style="color:#9a9a9a;margin-top:2px">${s.deltaKcal != null && s.deltaKcal > 0 ? `少 ${s.deltaKcal} kcal · ` : ''}${esc(s.reason)}</div>
          </div>
          <div class="sv">−${yuan(s.saveFen)}</div>
          <button data-swap="${i}">${btn}</button>
        </div>`;
          })
          .join('')
      : '<div class="note">这单内容不变的前提下没有更便宜的换法了 —— 挑得不错。</div>'}

    <h4 style="font-size:13px;margin:16px 0 8px">重新搭配的三条路线</h4>
    ${(planRes?.plans || [])
      .map(
        (p, i) => `<div class="plan ${i === 0 ? '' : ''}">
        <div class="ph"><span class="pt">${esc(p.title)}</span><span class="ps">${esc(p.subtitle)}</span><span class="pp">${yuan(p.payableFen)}</span></div>
        <div class="pn"><span class="tag kcal">${p.nutrition.kcal == null ? '热量未知' : p.nutrition.kcal + ' kcal' + (p.nutrition.partial ? '(部分)' : '')}</span>
          <span class="tag">蛋白 ${p.nutrition.protein ?? '?'}g</span>
          ${p.cardSavingsFen > 0 ? `<span class="tag card">含麦金卡省 ${yuan(p.cardSavingsFen)}</span>` : ''}</div>
        <ul>${p.items.map((x) => `<li>${esc(x.name)}${x.qty > 1 ? ' ×' + x.qty : ''} · ${yuan(x.lineFen)}${x.kcal != null ? ` · ${x.kcal} kcal` : ''}</li>`).join('')}</ul>
        <div class="acts"><button class="primary" data-apply="${i}">用这套替换购物车</button></div>
      </div>`
      )
      .join('') || '<div class="note">没有找到可替换的组合。</div>'}
    ${planRes?.note ? `<div class="note warn">${esc(planRes.note)}</div>` : ''}
  `;
  openSheet('省钱与热量优化', html);

  $('sheetBody').querySelectorAll('[data-swap]').forEach((b) => {
    b.onclick = () => {
      const s = adv.suggestions[+b.dataset.swap];
      // 统一成数组：替换是 1 → 1，打包是 N → 1
      const fromList = Array.isArray(s.from) ? s.from : [s.from];
      const totalQty = fromList.reduce((n, f) => n + (state.cart.find((c) => c.code === f.code)?.qty || 0), 0);
      if (!totalQty) return;

      const drop = new Set(fromList.map((f) => f.code));
      state.cart = state.cart.filter((c) => !drop.has(c.code));
      const hit = state.cart.find((c) => c.code === s.to.code);
      // 打包时套餐本身已经覆盖了那些单品，所以只加 1 份；替换时保持原数量
      const addQty = s.type === 'bundle' ? 1 : totalQty;
      if (hit) hit.qty += addQty;
      else state.cart.push({ code: s.to.code, qty: addQty });

      renderCart();
      showOptimizer();
      toast(s.type === 'bundle' ? `已打包成 ${s.to.name}` : `已换成 ${s.to.name}`);
    };
  });

  $('sheetBody').querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = () => {
      const p = planRes.plans[+b.dataset.apply];
      state.cart = p.items.map((i) => ({ code: i.code, qty: i.qty }));
      renderCart();
      closeSheet();
      refreshAdvice();
      toast(`已应用「${p.title}」，实付 ${yuan(p.payableFen)}`);
    };
  });
}

/* -------------------------------- 麦金卡 -------------------------------- */

async function showCardRoi() {
  const prof = activeProfile();
  openSheet('麦金卡 ROI 精算', '<div class="loading">正在用本店真实卡价测算…</div>');
  try {
    const cartQs = encodeURIComponent(JSON.stringify(state.cart));
    const fee = prof?.cardFeeFen ?? '';
    const visits = prof?.visitsPerMonth ?? 8;
    const r = await api(`/api/card-roi?storeCode=${state.store.storeCode}&mode=${state.mode}&cart=${cartQs}&feeFen=${fee}&visits=${visits}`);
    const html = `
      <div class="kpi">
        <div><div class="k">卡价商品</div><div class="v">${r.eligibleCount}<span style="font-size:11px;font-weight:400"> 项</span></div></div>
        <div><div class="k">本单可省</div><div class="v" style="color:#12a150">${yuan(r.basket.saveFen)}</div></div>
        <div><div class="k">盈亏平衡卡费</div><div class="v">${yuan(r.feeCeilingPerVisitFen)}</div></div>
      </div>
      <div class="field">
        <label>你的卡费（元）—— 填了才能算出明确回本次数</label>
        <input type="number" id="feeInput" step="1" value="${prof?.cardFeeFen ? prof.cardFeeFen / 100 : ''}" placeholder="如 19" />
        <div class="hint">MCP 查不到卡费，所以这里让你填；不填也能给出「低于多少就值得买」。</div>
      </div>
      <div class="field">
        <label>每月到店次数</label>
        <input type="number" id="visitsInput" step="1" value="${visits}" />
      </div>
      <div id="roiResult"></div>
      <h4 style="font-size:13px;margin:16px 0 8px">本店麦金卡价 Top ${Math.min(10, r.topItems.length)}</h4>
      ${r.topItems
        .map(
          (i) => `<div class="swap"><div class="txt"><b>${esc(i.name)}</b>
          <div style="color:#9a9a9a;margin-top:2px"><span style="text-decoration:line-through">${yuan(i.listFen)}</span> → ${yuan(i.cardFen)}</div></div>
          <div class="sv">−${yuan(i.saveFen)}</div></div>`
        )
        .join('') || '<div class="note">本店暂无麦金卡价商品。</div>'}
    `;
    openSheet('麦金卡 ROI 精算', html);

    const recompute = async () => {
      const f = $('feeInput').value;
      const v = $('visitsInput').value;
      const rr = await api(`/api/card-roi?storeCode=${state.store.storeCode}&mode=${state.mode}&cart=${cartQs}&feeFen=${f}&visits=${v}`);
      $('roiResult').innerHTML = `<div class="note">${rr.verdict.replace(/\n\n/g, '<br><br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>`;
    };
    $('feeInput').onchange = recompute;
    $('visitsInput').onchange = recompute;
    await recompute();
  } catch (e) {
    $('sheetBody').innerHTML = `<div class="empty">测算失败：${esc(e.message)}</div>`;
  }
}

/* --------------------------------- 结算 --------------------------------- */

async function showCheckout() {
  const lines = cartLines();
  const t = cartTotals();
  const prof = activeProfile();

  openSheet('结算', '<div class="loading">正在调用官方核价…</div>');
  let priced = null;
  try {
    priced = await post('/api/price', {
      storeCode: state.store.storeCode,
      mode: state.mode,
      items: lines.map(({ item, qty }) => ({ code: item.code, qty })),
    });
  } catch { /* 核价失败仍展示本地价 */ }

  const official = priced?.data;
  const html = `
    <div class="kpi">
      <div><div class="k">餐品合计</div><div class="v">${yuan(official ? official.productPrice : t.payable)}</div></div>
      <div><div class="k">优惠</div><div class="v" style="color:#12a150">−${yuan(official ? official.discount : 0)}</div></div>
      <div><div class="k">应付</div><div class="v" style="color:#db0007">${yuan(official ? official.price : t.payable)}</div></div>
    </div>
    <div class="note">${official ? '以上为<b>官方 calculate-price 核价结果</b>（单位已由「分」换算）。' : '官方核价暂不可用，展示的是菜单价，可能与最终价有差异。'}</div>

    ${official?.takeWayList?.length ? `<div class="field" style="margin-top:12px"><label>取餐方式</label><div class="chips" id="takeway">${official.takeWayList
      .map((x, i) => `<button data-code="${x.code}" class="${i === 0 ? 'on' : ''}">${esc(x.title)}<span style="color:#9a9a9a;font-size:11px"> · ${esc(x.subtitle || '')}</span></button>`)
      .join('')}</div></div>` : ''}

    <div class="note">取餐人档案：<b>${esc(prof?.name || '默认')}</b>（可在底部「档案」里切换不同预算/热量目标）</div>
    <div class="note warn" style="margin-top:8px">按下单后订单会真实创建并返回支付链接。本项目<b>不代替你付款</b>，付款始终在麦当劳官方页面完成。</div>
  `;
  openSheet('结算', html, `<button class="cta" id="doOrder" style="width:100%">确认下单</button>`);

  let takeWayCode = official?.takeWayList?.[0]?.code || 'take-in-store';
  const tw = $('takeway');
  if (tw)
    tw.onclick = (e) => {
      const b = e.target.closest('button[data-code]');
      if (!b) return;
      takeWayCode = b.dataset.code;
      [...tw.children].forEach((x) => x.classList.toggle('on', x === b));
    };

  $('doOrder').onclick = async () => {
    if (!confirm('确认下单？这会在你的麦当劳账户创建真实订单，但不会替你付款。')) return;
    $('doOrder').textContent = '创建中…';
    const r = await post('/api/order', {
      confirm: true,
      storeCode: state.store.storeCode,
      mode: state.mode,
      takeWayCode,
      items: lines.map(({ item, qty }) => ({ code: item.code, qty })),
    });
    if (r.ok) {
      const link = findPayLink(r.data);
      openSheet(
        '订单已创建',
        `<div class="note">订单已提交到你的麦当劳账户。${
          link ? `请前往官方页面完成支付：<br><a href="${esc(link)}" target="_blank" rel="noreferrer" style="color:#db0007">打开支付页 →</a>` : '请在麦当劳 App 中完成支付。'
        }</div>
        <div class="note warn" style="margin-top:10px">本项目不代收款项、不代付。</div>`
      );
      state.cart = [];
      renderCart();
      $('saveHint').classList.add('hidden');
    } else {
      $('doOrder').textContent = '确认下单';
      toast('下单失败：' + (r.error?.message || '未知错误'));
    }
  };
}

function findPayLink(data) {
  if (!data) return null;
  const s = JSON.stringify(data);
  const m = s.match(/https?:\/\/[^"\\ ]+/g);
  return m ? m.find((u) => /pay|order|mcd/i.test(u)) || m[0] : null;
}

/* -------------------------------- 顶部入口 -------------------------------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.__state = state;
boot();
