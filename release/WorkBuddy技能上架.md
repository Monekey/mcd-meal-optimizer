# WorkBuddy 技能市场上架指南

> 这是**目前最值得做的一个渠道**。
> 原因：WorkBuddy 是本届比赛（麦当劳程序员创意开发大赛）的**官方合作伙伴**，
> 而技能市场的用户 = 全体 WorkBuddy 用户 = **参赛者 + 开发者**，受众精准度远超任何外部社区。
> 而且这是一条**官方渠道**，不是"自己找地方发广告"。

---

## 一、已经替你准备好的东西

| 产物 | 说明 |
|---|---|
| `skills/mcd-meal-optimizer/` | 已符合技能市场目录结构的技能包（含 `SKILL.md` / `scripts/` / `references/`） |
| `dist/mcd-meal-optimizer-1.0.0.zip` | **可直接上传的 ZIP**（约 50 KB，远低于 3 MB 上限） |
| `scripts/build-snapshot.mjs` | 把门店真实菜单固化成 `scripts/snapshot.json`（**没有 Token 的用户靠它用上技能**） |
| `scripts/build-skill.mjs` | 打包脚本，改完代码重跑一次即可（自检 frontmatter / 关键资源 / 跨目录引用 / 语法） |

重新打包（改完代码或菜单变动后）：

```bash
node scripts/export-demo-data.mjs   # ① 先刷门店真实菜单快照
node scripts/build-snapshot.mjs     # ② 生成技能包内置快照
node scripts/build-skill.mjs        # ③ 打包 + 全量自检
```

`build-skill.mjs` 会在这几处直接报错退出，别绕过它：
- frontmatter 缺 `description_zh` / `description_en` / `version` / `author` / `category`
- `scripts/snapshot.json` 缺失或不是合法 JSON
- `SKILL.md` 里 `@references/xxx.md` 引用了不存在的文件
- 打包后会出现跨目录引用（`../`）导致断链

---

## 二、上架流程（两条路，选一条）

### 路线 A：客户端内「创建技能」（更快，无需实名认证）

1. 打开 WorkBuddy，左侧菜单【专家 · 技能 · 连接器】→ 切到【技能】页签 → 进入【技能市场】
2. 点击市场**右上角【添加技能】→【创建技能】**
3. 会跳转进对话，补全提示词后开始创建

> 这条路适合快速试跑。但**它是新建一个技能，不是上传我们打好的包**。
> 如果你要走「我这份代码原样上架」，用路线 B。

### 路线 B：开放平台上传 ZIP（正式上架，需实名认证）

1. 访问 **<https://open.workbuddy.cn/>**（或 <https://skillhub.cn> → 右上角「发布团队 skill」）
2. 完成**入驻 / 实名认证 / 开发者信息审核**（个人开发者即可）
3. 新建 Skill → 上传 `dist/mcd-meal-optimizer-1.0.0.zip`
4. 填写元信息（名称、简介、分类、触发词）
5. 提交审核：**平台安全审核** → （企业账号还要管理员审核）
6. 审核通过后，在【技能列表】里点**上架**
7. 之后用户在 WorkBuddy 的技能市场里就能搜到并安装了

> ⚠️ 上传的 ZIP 里**不要包含任何真实凭证**（MCP Token、API Key、Cookie）。
> 本技能包只读环境变量 / 本机配置，不含任何凭证 —— 已用脚本自检过。

---

## 三、技能市场要求的字段（已全部满足）

官方文档要求的 `SKILL.md` frontmatter 必填字段：

| 字段 | 必填 | 我们的值 |
|---|:---:|---|
| `description` | 是 | 写清用途与触发词（麦当劳/点餐/省钱/麦金卡…） |
| `description_zh` | 是 | 简短中文介绍 |
| `description_en` | 是 | 简短英文介绍 |
| `version` | 是 | `1.0.0` |
| `author` | 是 | `Monekey` |
| `name` | 否 | `mcd-meal-optimizer` |
| `display_name` | 否 | `麦麦点餐官` |
| `category` | 建议 | `life` |

`node scripts/build-skill.mjs` 会在打包前自动校验这几个字段，缺任何一个都会直接报错退出。

目录结构（我们的包）：

```
mcd-meal-optimizer/
├── SKILL.md
├── references/
│   ├── mcp-quirks.md      # 麦当劳 MCP 的 10 个实测坑
│   └── faq.md             # 常见问答与排错
└── scripts/
    ├── cli.mjs            # 命令行入口（AI 通过它调用）
    ├── mcp-client.mjs     # MCP Streamable HTTP 客户端（含 SSE 解析与重试）
    ├── parse.mjs          # 「Markdown + 内嵌 JSON」解析层
    ├── enrich.mjs         # 套餐营养补全
    ├── menu.mjs           # 菜单归一 + 营养匹配
    ├── optimizer.mjs      # 双目标组合求解 + 购物车建议
    ├── card-roi.mjs       # 麦金卡 ROI
    └── snapshot.json      # 门店真实菜单快照（离线兜底，见下）
```

**零第三方依赖**（只用 Node 内置模块），所以包体极小、不会因为依赖装不上而挂。

---

## 四、用户装完之后怎么用

### ✅ 第一步就能用，不需要任何配置

技能内置了一份门店**真实菜单快照**（`scripts/snapshot.json`，96 个在售 SKU + 71 项营养数据，
取自北京建外 SOHO 店）。**没有 MCP Token 也能立刻跑**：

```bash
node scripts/cli.mjs solve --store 1950564 --wants "麦满分,饮品,小食" --budget 35
node scripts/cli.mjs advise --store 1950564 --cart "1254:1,4437:1,3757:1"
node scripts/cli.mjs card-roi --store 1950564 --fee 19
```

> 这一条是刻意设计的：技能市场用户绝大多数没有麦当劳 Token。
> 如果没 Token 就直接报错退出，装了等于没装，安装后评分也会掉。
> 现在**没 Token 也能看到真实算法跑出来的结果**，SKILL.md 里也要求 AI 必须如实说明
> 「这是快照、价格可能已变」。

### 🔑 要实时价 / 核价 / 下单，才需要 Token

1. 去 <https://open.mcd.cn/mcp> 用手机号登录 → 控制台 → 激活 → 复制 MCP Token
2. 在 WorkBuddy 的【连接器】里启用 `mcd-mcp`（技能会自动读取，无需手动传参）
3. 然后直接说话：

> 「我今天想在国贸那家麦当劳点个汉堡加饮料，40 块以内别太胖」

技能会调用 `scripts/cli.mjs` 拿确定性结果，再讲成人话。

**需要 Token 的命令**：`stores` / `tools` / `price` / `order` / `addresses` / 麦乐送全链路。
其余（`solve` / `advise` / `card-roi` / `menu`）无 Token 时自动走快照。

---

## 五、上架后要做的两件事

1. **在比赛报名 Issue 里补一句**：本作品已在 WorkBuddy 技能市场上架，搜索「麦麦点餐官」即可安装
   —— 这是很强的可信度信号，而且**是官方渠道，不算外部导流**
2. **README 里加一行**安装指引（同上），让人进仓库后就能用

---

## 六、如果审核不通过

常见原因与对策：

| 现象 | 原因 | 对策 |
|---|---|---|
| 上传 ZIP 后解析失败 | 目录层级多了一层（`mcd-meal-optimizer/mcd-meal-optimizer/SKILL.md`） | 用 `scripts/build-skill.mjs` 生成，它在 `skills/` 目录下打包，根目录就是 `mcd-meal-optimizer/` |
| 提示缺少字段 | frontmatter 少了 `description_zh` / `description_en` / `version` / `author` 之一 | 打包脚本会提前拦住 |
| 提示含敏感信息 | 包里混入了 Token / 缓存 | `.cache/` 已在打包时排除；确认没有手工塞过凭证。快照 `snapshot.json` 只含商品与价格，可自行核查 |
| 装上后报错说找不到 Token | 用户没配 Token | 已内置快照兜底，`solve`/`advise`/`card-roi`/`menu` 无需 Token；如仍报错请反馈 |
| 菜单价格与实际不符 | 快照是某一时点的真实数据，门店会换季 | 属预期行为，配 Token 后自动走实时价；快照与实时永远以实时为准 |
| 安全审核不过 | 技能里有写入类操作 | 本技能**只读**，不调用 `create-order` / `draw-lottery` 等写操作，已写进 SKILL.md 的「不要做的事」 |

> 官方文档说明：解析失败可发邮件到 **openworkbuddy@tencent.com**，
> 或扫开放平台首页下方二维码进社群沟通。

---

## 七、一句话总结

**这是唯一一个「官方合作方 + 受众全是参赛者 + 免费 + 能写进报名材料」的渠道。**
优先级排在 V2EX / 掘金 **之前或同等**。
