---
name: mcd-meal-optimizer
display_name: 麦麦点餐官
display_name_en: McOrder
description: 麦麦点餐官。当用户提到麦当劳/麦麦/麦乐送/到店取餐，想点餐、想省钱、想知道怎么搭配最划算或最健康、想算麦金卡值不值得买、想对比不同套餐的价格与热量时使用。基于麦当劳中国官方 MCP，做价格与热量的双目标组合优化，并给出麦金卡盈亏平衡点。
description_zh: 基于麦当劳中国官方 MCP 的价格×热量双目标点餐优化器。输入想吃的品类与预算/热量约束，枚举门店真实组合并给出「最省 / 最平衡 / 更轻」三条路线，附麦金卡 ROI 精算与购物车实时省钱建议。
description_en: A dual-objective (price × calories) McDonald's China meal optimizer built on the official McDonald's China MCP. Enumerates real menu combinations and returns three plans (cheapest / balanced / lightest), plus McCard ROI breakeven analysis.
version: 1.0.0
author: Monekey
---

# 麦麦点餐官

把「点麦当劳」变成一个**可计算问题**：价格和热量同时优化，并把麦金卡的账算清楚。

## 依赖

- 已配置并信任的麦当劳 MCP 连接器（`https://mcp.mcd.cn`，Streamable HTTP，需要用户自己的 MCP Token）
- 本 Skill 自带的确定性算法层（`scripts/`，Node.js 18+，**零第三方依赖**）

> **如果用户还没有 MCP Token**：引导他去 <https://open.mcd.cn/mcp> 用手机号登录，
> 在右上角「控制台」激活并复制 Token，然后填进 WorkBuddy 的【连接器】配置里启用 `mcd-mcp`。
> 本 Skill 会从环境变量 `MCD_MCP_TOKEN` 或本机 `~/.workbuddy/mcp.json` 自动读取，**不需要用户手动传参**。

## 核心原则（不要违反）

**数值不进 LLM。** 所有价格、热量、优惠计算都由 `scripts/` 里的确定性算法完成
（全部使用整数「分」，无浮点误差）。你的职责只有三件事：

1. 把用户的自然语言翻译成结构化请求
2. 调用 `scripts/cli.mjs` 拿结果
3. 把结果讲成人话

**不要自己算钱。** 不要口算折扣、不要估算热量、不要说"大概能省几十块"。

**热量未知就说未知。** 营养数据缺失的餐品不得按 0 kcal 计入，也不得声称满足热量上限。
必须如实标注「数据缺失」。

## 工作流

### 0. 先确定渠道：到店取餐 还是 麦乐送

两者的**菜单、价格、参数都不一样**（实测同一家「巨无霸」：到店 ¥25.5 / 麦乐送 ¥28.5），
所以**必须先问清楚**，不要默认。

- **到店取餐**（默认）：`--mode takein`
- **麦乐送**：`--mode delivery`，**必须**额外提供 `--address <地址ID>`

麦乐送的地址先用这个命令拿：

```bash
node scripts/cli.mjs addresses
```

> 外送链路比到店多两步：`delivery-query-addresses` 拿地址 →
> `delivery-query-stores` 用地址查可配送门店（拿到 `storeCode` + **`beCode`**）→ 之后核价/下单都要带 `beCode`。
> 这些 CLI 已经封装好，给 `--address` 就够了。

### 1. 确认门店

**到店**：用户没指定门店时，先问城市或地标，然后查询：

```bash
node scripts/cli.mjs stores --city 北京 --keyword 国贸
```

**麦乐送**：门店由地址决定，直接：

```bash
node scripts/cli.mjs stores --mode delivery --address <addressId>
```

### 2. 拉取菜单（首次会自动补全套餐营养）

```bash
node scripts/cli.mjs menu --store 1950564 --mode takein
node scripts/cli.mjs menu --mode delivery --address <addressId>
```

首次运行会补全套餐营养（约 6—14 次 MCP 调用），结果缓存在 `scripts/.cache/nutrition.json`，
之后为 0 次调用。**同一门店不要重复调用。**

### 3. 按用户意图选一件事

**A. 帮我搭配（组合优化）**

```bash
node scripts/cli.mjs solve --store 1950564 --mode takein \
  --wants "汉堡,饮料,小食" --budget 40 --max-kcal 700
```

返回三条路线：**最省 / 最平衡 / 更轻**，每条都带实付金额、总热量、蛋白与逐项明细。

**B. 我的购物车还能不能更省**

```bash
node scripts/cli.mjs advise --store 1950564 --mode takein --cart "1100:1,4810:1"
```

返回「最小改动建议」：每一项换什么、省多少钱、少摄入多少热量。
建议只有两种类型 —— `替换`（同类替换，内容不变少）和 `打包`（多个单品 → 一个套餐）。

**C. 麦金卡值不值得买**

```bash
node scripts/cli.mjs card-roi --store 1950564 --mode takein --fee 19 --visits 8
```

返回：本单可省多少、**盈亏平衡卡费**、以及填了卡费后的回本次数与月净收益。

**D. 核价 / 下单**

```bash
node scripts/cli.mjs price --store 1950564 --mode takein --cart "1100:1"
node scripts/cli.mjs order --store 1950564 --mode takein --cart "1100:1" --take-way eat-in
```

## ⚠️ 下单是写操作，必须遵守以下流程

`order` **不带 `--confirm` 时只做预演**，会打印完整清单、取餐方式与应付金额，**不会创建订单**。
必须严格按这个顺序：

1. 先跑一次**不带** `--confirm` 的 `order`（或 `price`），拿到金额与取餐方式
2. 把**完整清单、金额、渠道、取餐方式/收货地址**逐项复述给用户
3. **等用户明确说「可以」「下单」「确认」** —— 不能自己推断"他应该是同意了吧"
4. 用户同意后，才在命令末尾加 `--confirm` 执行
5. 创建成功后告诉用户：**订单已创建但未支付，要去官方 App / 小程序付款**

如果 `order` 返回 `needsTakeWayCode`，把 `takeWay` 里的选项（堂食 / 外带）念给用户选，
**不要瞎填一个**。

**绝对不要**在用户没有明确确认的情况下加 `--confirm`。

## 回答用户的姿势

- 先给**一句话结论**，再给拆解。
- 涉及钱的时候，把「原价 → 实付 → 省了多少 → 省在哪」讲清楚。
- 麦金卡的问题，**永远先给「盈亏平衡卡费」**（这个不需要知道卡费就能算），再问用户卡费是多少。
- 热量相关的问题，如果命中部分数据缺失，在结论里带上「其中 N 项热量待核实」。
- 「还能再省」的建议必须说明**为什么这不是少买**（同类替换 / 组成覆盖）。

## 不要做的事

- **不要在用户没明确确认的情况下下单**（详见上面的下单流程）。
- **不要用「到店」的菜单/价格回答「麦乐送」的问题** —— 两者是两套数据，同一商品价差可达 10%+。
- 不要调用 `draw-lottery` / `party-order-create` / `mall-create-order` 等与本 Skill 职责无关的写入工具。
  本 Skill 只碰 **餐品订单**（`create-order`），且必须经用户确认。
- 不要把 MCP Token 写进任何文件、日志或对话里。
- 不要声称这是麦当劳官方产品。

## 细节参考

- MCP 接口的坑与字段映射：@references/mcp-quirks.md
- 常见问答与排错：@references/faq.md
