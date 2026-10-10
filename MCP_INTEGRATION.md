# 麦当劳 MCP 接入说明

本文档说明本项目**实际使用了哪些 MCP 工具、按什么顺序调用、解决了什么业务问题**，以及实测踩到的坑。

- **MCP Server**：`https://mcp.mcd.cn`（麦当劳中国官方远程托管）
- **传输协议**：Streamable HTTP
- **协议版本**：`2025-06-18`
- **serverInfo（实测）**：`{"name":"mcd-mcp","version":"1.0.0"}`
- **认证**：请求头 `Authorization: Bearer <MCD_MCP_TOKEN>`
- **限流**：600 次/分钟（超限返回 429）
- **实测工具总数**：**35 个**（官方 README 列示 33 个）

---

## 一、用到的工具

### 1. 门店定位

| Tool | 用途 | 关键参数 |
|---|---|---|
| `query-nearby-stores` | 到店取餐场景查门店，拿 `storeCode`（来得速才会给 `beCode`） | `beType=1`、`searchType=2`、`city`、`keyword` |
| `delivery-query-addresses` | **麦乐送第一步**：拿用户的收货地址列表 `addressId` | 无（⚠️ 工具名是**复数**） |
| `delivery-query-stores` | 麦乐送第二步：用 `addressId` 查可配送门店，拿 `storeCode` + **`beCode`** | `beType=2`、**`addressId`（必填）** |

### 2. 菜单与营养

| Tool | 用途 | 关键参数 |
|---|---|---|
| `query-meals` | 拉取门店实时菜单（分类 + 122 个在售 SKU + 价格 + 麦金卡标记） | `storeCode`、`orderType`、`beType`；**外送还要带 `beCode`** |
| `query-meal-detail` | 解析套餐默认组成，用于补全套餐营养 | `storeCode`、`code` |
| `list-nutrition-foods` | 160 个餐品的能量/蛋白/脂肪/碳水/钠/钙 | 无 |

### 3. 优惠与账户

| Tool | 用途 |
|---|---|
| `query-my-coupons` | 解析用户券列表（券名、券码、有效期、"到店专用/外送专用"标签） |
| `available-coupons` | 麦麦省可领取券 |
| `auto-bind-coupons` | 一键领取麦麦省全部可领券 |
| `query-store-coupons` | 门店维度真实可用券（与"账户权益"区分） |
| `query-my-account` | 积分账户（可用/累计/即将过期/已过期） |

### 4. 核价与下单（写入类，均需用户二次确认）

| Tool | 用途 | 关键参数 |
|---|---|---|
| `calculate-price` | **权威核价**，返回商品价/优惠/应付/取餐方式 | `storeCode`、`orderType`、`beType`、`items[{productCode,quantity}]`；**外送还要带 `beCode`** |
| `create-order` | 创建订单（未支付，需去官方 App 付款） | **到店**：必传 `takeWayCode`（值只能来自 `takeWayList[].code`，如 `eat-in` / 外带）；**外送**：必传 `addressId` + `beCode`，**不传** `takeWayCode` |

### 5. 发现但未使用

`query-promotions`、`query-survey-coupon`、积分抽奖三件套、麦麦商城、主题活动/派对系列、`query-meal-assistance` —— 与"点餐决策优化"主线无关，本项目不调用，以保证 MCP 调用量最小、每次调用都有明确业务目的。

---

## 二、调用流程

### 主流程（到店取餐，一次完整会话）

```text
① query-nearby-stores(beType=1, searchType=2, city, keyword)
      ↓ 拿到 storeCode / beCode
② query-meals(storeCode, orderType=1, beType=1)
      ↓ 拿到 classifications[16] + meals{code→SKU} + 麦金卡价标记
③ list-nutrition-foods()
      ↓ 拿到 160 条单品营养
④ query-meal-detail(storeCode, code)   ← 仅对"进入候选的套餐"调用，且结果落盘缓存
      ↓ 把套餐默认组成的营养相加
⑤ 本地求解器：价格 × 热量双目标枚举 + 券建模 + 麦金卡价 → Top-3 方案
⑥ calculate-price(storeCode, orderType, beType, items[{productCode,quantity, couponId?}])
      ↓ 官方权威核价（返回单位为「分」）
⑦ create-order(..., takeWayCode)       ← 需 confirm:true，返回支付链接
```

**调用量控制**：一次完整会话约 **6—14 次** MCP 调用（套餐营养补全的结果会落盘缓存，第二次起为 0 次）。相比"对每个候选组合都调一次核价"的做法（数千次），本方案对 600 次/分钟的限流非常友好。

### 麦乐送流程（比到店多两步，且参数不同）

```text
① delivery-query-addresses()
      ↓ 拿到 addressId（工具名是复数！）
② delivery-query-stores(beType=2, addressId)
      ↓ 拿到可配送门店的 storeCode + beCode
③ query-meals(storeCode, orderType=2, beType=2, beCode)   ← 必须带 beCode
      ↓ 外送菜单与到店是**两套**：同一门店「巨无霸」到店 ¥25.5 / 外送 ¥28.5
④ 本地求解器（同上）
⑤ calculate-price(..., beCode)
      ↓ 外送核价含配送费（实测商品价 ¥15.50 → 应付 ¥21.50），且 takeWayList 为空
⑥ create-order(..., beCode, addressId)   ← 外送**不传** takeWayCode
```

> ⚠️ 三个最容易错的点：
> ① `delivery-query-stores` 的必填参数是 `beType` + **`addressId`**，不是 city/keyword；
> ② 工具名是 `delivery-query-addresses`（**复数**），文档提到的单数形式会返回 `unknown tool`；
> ③ 外送的 `beCode` 是核价与下单的必传参数，缺了会拿不到正确价格。

### 下单的安全边界

`create-order` 是**唯一的写操作**，因此在三个层面都做了拦截：

| 层 | 拦截 |
|---|---|
| CLI / Skill | `order` 不带 `--confirm` 时**只预演**，打印清单与金额，不创建订单 |
| 服务端 | `/api/order` 必须带 `confirm:true`；到店缺 `takeWayCode` → 400；外送缺 `addressId` → 400 |
| 前端 | 二次 `confirm()` 弹窗，且明确告知「会在你的账户创建真实订单，但不会替你付款」 |

**本项目不代收款项、不代付。** 订单创建后是「未支付」状态，付款始终在麦当劳官方 App / 小程序完成。

### 麦金卡 ROI 流程

```text
query-meals → 筛选 discountType === "麦金卡优惠" 且 originalPrice > currentPrice 的 SKU
      ↓
按用户购物车聚合：当前这单用卡能省多少
      ↓
输出「盈亏平衡卡费」= 本单卡价节省额（不依赖任何未知量）
```

---

## 三、业务价值

| 能力 | 官方 APP 有吗 | 本项目如何做到 |
|---|---|---|
| 组合最优（价格） | ❌ | 本地枚举 + 官方核价交叉验证 |
| 组合最优（价格 × 热量双目标） | ❌ | 同一目标函数，三条可解释路线 |
| **麦金卡 ROI / 盈亏平衡卡费** | ❌ | 从菜单 `discountType` 反推卡价，纯数据驱动 |
| 购物车实时"还能再省多少" | ❌ | 同品类替代扫描 + Δ价格 / Δ热量 |
| 多份点餐档案（预算/热量/忌口） | ❌ | 本地档案层（同一会员账户下） |
| 点餐、核价、下单 | ✅ | 复用官方 MCP，不改变用户既有习惯 |

---

## 四、实测踩到的坑（供后来者参考）

1. **字段名映射**：`query-meals` 返回的键是 `code`，但 `calculate-price` 的入参字段是 **`productCode`**。传错**不报错**，会静默返回 `price: 0` 和空 `productList`。

2. **价格单位不统一**：`query-meals` 的价格是**元字符串**（`"33.5"`），`calculate-price` 的价格是**整数分**（`4850`）。本项目一律在入口处换算成整数分。

3. **返回是混合体**：每个响应的结构是「给 LLM 看的 Markdown 说明 + `## Original Response` 里的原始 JSON」。部分工具（如 `query-store-coupons`）**只返回 Markdown 表格**，没有 JSON 行 —— 必须写解析层。

4. **转义换行**：`list-nutrition-foods` 把整张 160 行的表塞在一个字符串里，行分隔用的是字面量 `\n`。直接 `split('\n')` 会解析失败。

5. **下单有隐藏必填项**：`create-order` 必传 `takeWayCode`，取值来自 `calculate-price` 返回的 `takeWayList[].code`（实测为 `eat-in` 堂食 / `take-in-store` 外带）。

6. **返回抖动**：实测 `list-nutrition-foods` 首次成功返回 160 条，同一 session 连续 5 次重试**全部返回空文本**。必须做重试 + 本地快照降级。

7. **空关键词查不到门店**：`query-nearby-stores` 在 `searchType=2` + 空 `keyword` 时返回空数组，需要兜底（收藏餐厅 / 用城市名当关键词）。

8. **`query-promotions` 只对企业团餐开放**：`beType=6` 才能查满减/满折规则。**个人点餐场景没有任何满减规则查询工具**，因此第三方团购券（抖音/美团）不在 MCP 能力范围内。

9. **卡费查不到**：麦金卡本身不是菜单 SKU（实测门店菜单里 `canWithOrder` 全为 `false`），也没有"查询会员卡"的工具。所以本项目输出的是「盈亏平衡卡费」而不是"值不值" —— 这是一个不依赖未知量的、可验证的结论。

---

## 五、安全与合规

- **Token 绝不入库**：`.gitignore` 排除 `mcp-config.json` / `.env`；仓库里只有 `mcp-config.example.json`（环境变量占位符）。运行时 Token 只从 `MCD_MCP_TOKEN` 环境变量或本机配置**读取**，任何情况下不打印、不写回。
- **写入类操作全部二次确认**：`create-order`、`auto-bind-coupons`、`draw-lottery` 等一律要求显式确认。
- **不代付**：订单创建后返回官方支付链接，付款始终在麦当劳官方渠道完成。
- **只读优先**：除用户主动点击"确认下单"外，本项目全部使用只读工具。
