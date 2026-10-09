# WorkBuddy 开发上下文记录

本文件用于说明本项目**在腾讯 WorkBuddy 中完成开发**的对话上下文与过程，供活动方核验 WorkBuddy 专项奖励条件。

- **开发时间**：2026-10-09
- **开发工具**：腾讯 WorkBuddy（Agent 模式）
- **参与环节**：赛前调研 → 选题 → MCP 探测 → 核心算法 → 服务与前端 → 测试 → 文档

---

## 一、对话上下文一览

### 1. 赛前调研

**用户输入**：

> WorkBuddy 和麦当劳，欢迎你来开发大赛！2026 麦当劳程序员创意开发大赛正式开启……我想参加这个活动，想获得第一名！调研一下路径和创意方向

**WorkBuddy 的动作**：
- 读取官方仓库 `M-China/mcd-developer-innovation-challenge` 的 README / activityGuidelines.md / RANKING.md / CONTEST_DECLARATION.md
- 读取 `M-China/mcd-mcp-server` 的工具文档
- 抓取实时排行榜与全部已报名项目的 Star 数据、语言、方向
- 逐个扒开 11 个竞品仓库的真实文件树与 README，做功能占有矩阵
- 产出：《麦当劳 1024 开发大赛 · 夺冠路径与创意方向调研》

**关键结论**：排名 100% 由 GitHub Star 数决定（无评委打分）；当时榜首仅 11★；省钱（5 家）与营养（4 家）是红海，麦金卡 ROI 与 APP 级界面是空位。

### 2. 竞品拆解与竞争力评估

**用户输入**：

> 我觉得最优价值的就是省钱组合（包含麦麦卡 ROI 精算师）+ 麦麦消费年报 Wrapped……页面尽量还原麦当劳官方 APP 的麦乐送和到店取餐，以及二级页面，相当于增强官方 APP……看看现在的竞品解决了哪些问题，看下我的想法竞争力如何

**WorkBuddy 的动作**：
- 用用户提供的 MCP Token 真实调用 `https://mcp.mcd.cn`，完成 initialize / tools/list / tools/call
- 发现工具实数 **35 个**（官方文档只写 33 个），多出 `query-promotions`、`query-survey-coupon`
- 实测门店 `1950564`，拿到 114 个在售 SKU 的完整菜单结构
- 发现 **「麦金卡专享」是菜单里的一个独立分类**，卡价商品带 `discountType: "麦金卡优惠"`
- 实测 `calculate-price` 返回单位为**整数分**
- 发现三个必须先砍/先验证的坑：**团购券不在 MCP 能力范围内**、**"切换人"架构上不成立**、**字段名 `code`→`productCode` 的静默失败**
- 产出：《竞品拆解与你的方案竞争力评估》

### 3. 开发

**用户输入**：

> 就按你说的来，可以动手开发了。形式小程序是不是最适合的？

**WorkBuddy 的动作**：按"可以先跑起来"的顺序，依次完成 MCP 客户端 → 解析层 → 双目标求解器 → 麦金卡 ROI → 后端服务 → 前端界面 → 测试。

---

## 二、WorkBuddy 在本项目中承担的具体工作

| 环节 | 具体工作 |
|---|---|
| **信息检索** | 拉取官方规则原文、GitHub API 实时数据、竞品仓库文件树 |
| **接口探测** | 手写 MCP Streamable HTTP 握手（initialize → notifications/initialized → tools/list → tools/call），验证 35 个工具与真实返回结构 |
| **数据分析** | 114 SKU 菜单结构分析、麦金卡价差统计、营养覆盖率核算（67/114） |
| **代码生成** | 9 个源文件（MCP 客户端、解析层、套餐营养补全、档案存储、HTTP 服务、三个算法模块、前端） |
| **测试编写** | 24 项确定性断言，覆盖金额换算、解析容错、约束求解、卡 ROI、券建模 |
| **调试** | 定位并修复 5 个真实缺陷（见下） |
| **文档撰写** | README、MCP_INTEGRATION、SKILL.md 及本文件 |

---

## 三、WorkBuddy 在开发过程中定位并修复的缺陷

这些缺陷都是**先写测试、跑挂、再定位**发现的：

1. **`solve()` 读不到约束** —— 约束既可能挂在 `req` 上也可能挂在 `ctx` 上，导致"传了预算但静默不生效"。修复：在 `solve` 入口合并成 `resolved` 对象。
2. **营养伪表格解析失败** —— `list-nutrition-foods` 把 160 行塞在一个字符串里，行分隔是**字面量 `\n`** 而非真实换行。修复：解析前先归一化转义换行。
3. **未知热量被当成 0** —— 会导致"0 kcal 套餐"在"更轻"路线里胜出。修复：全部未知时返回 `null`，部分未知时返回 `knownRatio` 并加置信度惩罚。
4. **热量约束被"未知"绕过** —— 数据缺失的餐品可以伪造达标。修复：设了热量/钠/蛋白上限时，`unknown > 0` 的组合直接判为不可行。
5. **非食品被当成小食** —— "薯条脆卜卜毛绒周边"被当作薯条的替代品。修复：加入 `NON_MEAL` 过滤（蘸酱、餐具、周边、玩具等）。

另外修复了若干接口层问题：门店查询空关键词返回空数组（加三级兜底）、`products` 字段名映射、价格单位（元字符串 vs 整数分）统一。

---

## 四、WorkBuddy 输出的实际文件

```
server/mcp-client.mjs      MCP Streamable HTTP 客户端
server/parse.mjs           混合响应解析层
server/enrich.mjs          套餐营养补全 + 缓存
server/store.mjs           点餐档案持久化
server/index.mjs           HTTP 服务
core/menu.mjs              金额/菜单/营养
core/optimizer.mjs         双目标求解器
core/card-roi.mjs          麦金卡 ROI
web/{index.html,app.js,style.css}   前端
tests/run.mjs              24 项测试
scripts/build-demo.mjs     离线 demo 构建
```

所有文件均在本对话中由 WorkBuddy 生成，并经 WorkBuddy 实际运行验证。

---

## 五、验证记录

```bash
$ node server/index.mjs
✔ 麦当劳 MCP 已连接：35 个工具 · serverInfo={"name":"mcd-mcp","version":"1.0.0"}

  麦麦点餐官已启动 →  http://127.0.0.1:8791

$ curl -s localhost:8791/api/menu?storeCode=1950564&mode=takein
{"stats":{"sku":116,"categories":16,"nutritionCoverage":69,"comboEnriched":33,"mcCalls":1}}

$ curl -s -X POST localhost:8791/api/price -d '{"storeCode":"1950564","items":[{"code":"1100","qty":1},{"code":"4810","qty":1}]}'
{"ok":true,"data":{"productPrice":3900,"discount":0,"price":3900,
 "productList":[{"productName":"巨无霸","subtotal":2550},{"productName":"中薯条","subtotal":1350}],
 "takeWayList":[{"code":"eat-in","title":"堂食"},{"code":"take-in-store","title":"外带"}]}}

$ npm test
24 通过 / 0 失败 / 共 24 项
```

---

## 六、关于"用 WorkBuddy 开发"这件事本身

这个项目恰好在两个地方用到了 WorkBuddy 的真实能力：

1. **WorkBuddy 的 MCP 连接器机制**：本项目作为一个 Skill 时，正是通过 WorkBuddy 的自定义连接器接入麦当劳 MCP —— 也就是说，WorkBuddy 既是开发工具，也是运行宿主。
2. **WorkBuddy 的文件与命令能力**：从写文件、跑 Node 脚本、起本地服务到 curl 验证，全流程都在同一个会话里闭环完成，没有切换工具。

顺带一提：本文件之外的全部算法代码，**不依赖任何大模型**。这是刻意的设计 ——
价格与热量必须可复现、可解释、可回归测试，不能靠概率模型"猜"。大模型适合理解意图和表达结果，不适合算钱。
