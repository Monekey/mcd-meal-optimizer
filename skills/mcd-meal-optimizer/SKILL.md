---
name: mcd-meal-optimizer
description: 麦麦点餐官。当用户提到麦当劳/麦麦/麦乐送/到店取餐，想点餐、想省钱、想知道怎么搭配最划算或最健康、想算麦金卡值不值得买、想对比不同套餐的价格与热量时使用。基于麦当劳中国官方 MCP，做价格与热量的双目标组合优化，并给出麦金卡回本点。
---

# 麦麦点餐官

一个把「点麦当劳」变成**可计算问题**的 Skill：价格和热量同时优化，并把麦金卡的账算清楚。

## 依赖

- 已配置并信任的麦当劳 MCP 连接器（`https://mcp.mcd.cn`，Streamable HTTP，需要用户自己的 MCP Token）
- 本仓库的 `core/` 与 `server/`（确定性算法层，不需要联网即可跑测试）

> 如果用户还没有 MCP Token：引导去 https://open.mcd.cn/mcp 用手机号登录后在「控制台」激活，然后把生成的 Token 填进 `mcp-config.example.json` 对应的位置，并在 WorkBuddy 的【连接器】页启用 `mcd-mcp`。

## 核心原则（不要违反）

**数值不进 LLM。** 所有价格、热量、优惠计算都由本仓库的确定性算法完成（全部使用整数「分」，无浮点误差）。你的职责是：
1. 把用户的自然语言翻译成结构化请求
2. 调用脚本拿到结果
3. 把结果讲成人话

**不要自己算钱。** 不要口算折扣、不要估算热量、不要"大概能省几十块"。

**热量未知就说未知。** 营养数据缺失的餐品不得按 0 kcal 计入，也不得声称满足热量上限。必须如实标注"数据缺失"。

## 工作流

### 1. 确认门店

用户没指定门店时，先问城市/地标，或用 `query-nearby-stores` 查询。

### 2. 拉菜单与补全营养

```bash
node -e "
  import('./server/index.mjs').then(async m => {
    const menu = await m.getMenu('STORE_CODE', 'takein');
    console.log(JSON.stringify(menu.stats));
  });
"
```
或直接调用本地服务：`GET /api/menu?storeCode=...&mode=takein`

首次加载会补全套餐营养（约 6—14 次 MCP 调用），结果会缓存到 `data/nutrition-cache.json`，之后为 0 次。

### 3. 三件事，按用户意图选

**A. 帮我搭配（组合优化）** —— `POST /api/solve`

```json
{
  "storeCode": "1950564",
  "mode": "takein",
  "wants": [
    { "label": "汉堡", "category": "巨无霸 牛鱼肉堡", "qty": 1 },
    { "label": "饮料", "category": "饮品", "qty": 1 }
  ],
  "constraints": { "budgetFen": 4000, "maxKcal": 700 }
}
```
返回三条路线：**最省 / 最平衡 / 更轻**，每条都带价格、热量、蛋白与逐项明细。

**B. 我的购物车还能不能更省** —— `POST /api/advise`

```json
{ "storeCode": "1950564", "mode": "takein", "cart": [{ "code": "1100", "qty": 1 }] }
```
返回「最小改动建议」：每一项换什么、省多少钱、少摄入多少热量。

**C. 麦金卡值不值得买** —— `GET /api/card-roi`

```
/api/card-roi?storeCode=1950564&mode=takein&cart=[...]&visits=8&feeFen=1900
```
返回：本单可省多少、**盈亏平衡卡费**、以及填了卡费后的回本次数与月净收益。

### 4. 核价与下单

- 核价：`POST /api/price`（内部调 `calculate-price`，返回官方权威价）
- 下单：`POST /api/order`，**必须**显式带 `confirm:true`

⚠️ 下单是写入操作，会真实创建订单。**必须先向用户复述完整清单、金额、取餐方式，得到明确同意后才能执行。**

## 回答用户的姿势

- 先给**一句话结论**，再给拆解。
- 涉及钱的时候，把「原价 → 实付 → 省了多少 → 省在哪」讲清楚。
- 麦金卡的问题，永远先给**盈亏平衡卡费**（这个不需要知道卡费就能算），再问用户卡费是多少。
- 热量相关的问题，如果命中部分数据缺失，在结论里带上「其中 N 项热量待核实」。

## 不要做的事

- 不要调用 `draw-lottery` / `party-order-create` 等与本 Skill 职责无关的写入工具。
- 不要把 MCP Token 写进任何文件、日志或对话里。
- 不要在用户没确认的情况下创建订单。
- 不要声称这是麦当劳官方产品。
