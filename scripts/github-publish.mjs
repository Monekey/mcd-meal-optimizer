#!/usr/bin/env node
/**
 * GitHub 侧一键发布脚本
 * ---------------------------------------------------------------------------
 * 用途：拿到一个 GitHub Token 后，把「需要 GitHub API 才能做」的动作一次做完：
 *   1. 提交麦当劳官方报名 Issue
 *   2. 在 M-China/mcd-mcp-server 分享实测发现（官方可见 + 长尾流量）
 *   3. 设置仓库 About（description / homepage）
 *   4. 设置仓库 Topics
 *   5. 创建 Release v1.0.0
 *
 * 用法：
 *   GH_TOKEN=ghp_xxx node scripts/github-publish.mjs
 *   GH_TOKEN=ghp_xxx node scripts/github-publish.mjs --dry-run     # 只打印不提交
 *   GH_TOKEN=ghp_xxx node scripts/github-publish.mjs --only=issue  # 只做某一步
 *
 * Token 需求（经典 Token）：
 *   - public_repo  （在别人仓库建 Issue、建 Release、改 Topics/About）
 * 若用 fine-grained token，需要：
 *   - M-China/mcd-developer-innovation-challenge: Issues = Read and write
 *   - M-China/mcd-mcp-server: Issues = Read and write
 *   - Monekey/mcd-meal-optimizer: Contents = Read and write,
 *     Administration = Read and write（改 Topics/About 用）
 *
 * ⚠️ 安全：Token 只从环境变量读取，绝不被写入任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const OWNER = 'Monekey';
const REPO = 'mcd-meal-optimizer';
const CHALLENGE_REPO = 'M-China/mcd-developer-innovation-challenge';
const MCP_REPO = 'M-China/mcd-mcp-server';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------- 内容 ------------------------------- */

const ISSUE_TITLE = '【参赛申请】麦麦点餐官 · 基于麦当劳官方 MCP 的价格×热量双目标点餐优化器';

function registrationBody() {
  const f = path.join(ROOT, 'release', '报名Issue.md');
  if (!fs.existsSync(f)) throw new Error('找不到 release/报名Issue.md');
  const md = fs.readFileSync(f, 'utf8');
  // 取「## Issue 正文（整段复制）」后面那个围栏代码块
  const m = md.split('## Issue 正文（整段复制）')[1];
  if (!m) throw new Error('报名Issue.md 里找不到正文代码块');
  const fence = m.match(/```\n([\s\S]*?)```/);
  if (!fence) throw new Error('报名Issue.md 的正文档没找到');
  return fence[1].trim();
}

function mcpFeedback() {
  const f = path.join(ROOT, 'release', '官方仓库分享.md');
  if (!fs.existsSync(f)) return null;
  const md = fs.readFileSync(f, 'utf8');
  const titleM = md.match(/## 标题\s*\n+```\n([\s\S]*?)```/);
  const bodyM = md.match(/## 正文\s*\n+```\n([\s\S]*?)```/);
  return {
    title: titleM ? titleM[1].trim() : '[Documentation] tools/list 返回 35 个工具，文档列了 33 个',
    body: bodyM ? bodyM[1].trim() : null,
  };
}

const ABOUT = {
  description: '基于麦当劳官方 MCP 的价格×热量双目标点餐优化器｜麦金卡 ROI 精算｜27 项断言测试可回归',
  homepage: 'https://monekey.github.io/mcd-meal-optimizer/',
};

const TOPICS = [
  'mcdonalds',
  'mcp',
  'model-context-protocol',
  '1024',
  'workbuddy',
  'meal-optimizer',
];

const RELEASE = {
  tag_name: 'v1.0.0',
  name: 'v1.0.0 — 麦麦点餐官',
  body: [
    '第一个可用版本。基于麦当劳中国官方 MCP 的点餐决策优化器。',
    '',
    '## 核心能力',
    '',
    '- **价格 × 热量双目标求解**：枚举真实组合，输出「最省 / 最平衡 / 更轻」三条可解释路线',
    '- **购物车实时优化**：只做「内容不变少」的建议；支持把多个单品打包成套餐',
    '- **麦金卡 ROI 精算**：从菜单反推卡价，输出「盈亏平衡卡费」',
    '- **多份点餐档案**：同一会员账户下的预算 / 热量 / 忌口',
    '',
    '## 技术要点',
    '',
    '- 全部算术在本地以「整数分」完成，无浮点误差；**大模型不参与计算**',
    '- 独立解析层：MCP 返回是「Markdown 说明 + 内嵌 JSON」混合体',
    '- 套餐营养由 `query-meal-detail` 的默认组成求和补全，落盘缓存',
    '- 数据缺失不当成 0：热量未知的商品不得用于满足热量/钠/蛋白上限',
    '- 27 项确定性断言测试，`npm test` 一键回归',
    '',
    '## 在线演示（零 Token，内置真实门店数据快照）',
    '',
    'https://monekey.github.io/mcd-meal-optimizer/',
    '',
    '## 数据',
    '',
    '- 门店：麦当劳北京建外SOHO(A座)餐厅（`storeCode=1950564`）',
    '- 122 个在售 SKU / 16 个分类 / 14 项带麦金卡价',
    '- 官方营养接口直接匹配 53/122（43%），补全后 87/122（71%）：套餐由 query-meal-detail 组成求和',
    '',
    '> 非官方项目，麦当劳程序员创意开发大赛参赛作品。',
  ].join('\n'),
  draft: false,
  prerelease: false,
};

/* ------------------------------ HTTP ------------------------------- */

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'mcd-meal-optimizer-publish',
  };
}

async function gh(method, url, body) {
  if (DRY && method !== 'GET') {
    return { __dry: true, method, url, body };
  }
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, data: json };
}

const line = (s = '') => console.log(s);
const step = (n, s) => line(`\n[${n}] ${s}`);
const ok = (s) => line(`    ✔ ${s}`);
const warn = (s) => line(`    ⚠ ${s}`);
const bad = (s) => line(`    ✘ ${s}`);

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  line('麦麦点餐官 · GitHub 侧一键发布');
  line('='.repeat(60));
  if (DRY) line('模式：DRY-RUN（不会真的提交任何东西）');
  if (ONLY) line(`只执行：${ONLY}`);
  line();

  if (!TOKEN && !DRY) {
    bad('缺少 GH_TOKEN 环境变量。用法：GH_TOKEN=ghp_xxx node scripts/github-publish.mjs');
    process.exit(1);
  }

  const want = (k) => !ONLY || ONLY === k;
  let failures = 0;

  /* 0. 验证身份 ------------------------------------------------ */
  if (!DRY) {
    step(0, '验证 Token 与身份');
    const me = await gh('GET', '/user');
    if (!me.ok) {
      bad(`Token 无效或权限不足（HTTP ${me.status}）：${me.data?.message}`);
      process.exit(1);
    }
    ok(`已认证为 ${me.data.login}（${me.data.name || '无姓名'}）`);
    if (me.data.login !== OWNER) {
      warn(`当前身份是 ${me.data.login}，与预期 Owner「${OWNER}」不一致 —— 请确认这是你的号`);
    }
    const scopes = '';
    line(`    Token scopes: ${scopes || '（无法读取，可能是 fine-grained token）'}`);
  }

  /* 1. 报名 Issue ---------------------------------------------- */
  if (want('issue')) {
    step(1, `提交报名 Issue → ${CHALLENGE_REPO}`);
    const body = registrationBody();
    line(`    标题：${ISSUE_TITLE}`);
    line(`    正文长度：${body.length} 字符`);
    line('    ---- 正文预览 ----');
    line(body.slice(0, 400) + (body.length > 400 ? ' …' : ''));
    line('    ------------------');

    // 先查重，避免重复报名
    const existing = await gh('GET', `/repos/${CHALLENGE_REPO}/issues?state=all&per_page=100`);
    const dup = Array.isArray(existing.data)
      ? existing.data.find((i) => i.user?.login === OWNER && (i.title || '').includes('参赛申请'))
      : null;
    if (dup) {
      warn(`检测到你已经有报名 Issue：#${dup.number} ${dup.title}`);
      warn(`跳过报名（如需重新报名，请先手动关闭旧 Issue）`);
      line(`    ${dup.html_url}`);
    } else {
      const r = await gh('POST', `/repos/${CHALLENGE_REPO}/issues`, {
        title: ISSUE_TITLE,
        body,
      });
      if (DRY) ok('DRY-RUN：将提交上面的 Issue');
      else if (r.ok) {
        ok(`报名 Issue 已提交：#${r.data.number}`);
        line(`    ${r.data.html_url}`);
      } else {
        bad(`提交失败（HTTP ${r.status}）：${r.data?.message}`);
        failures++;
      }
    }
  }

  /* 2. 官方 MCP 仓库分享 ---------------------------------------- */
  if (want('mcp-issue')) {
    step(2, `在 ${MCP_REPO} 分享实测发现`);
    const fb = mcpFeedback();
    if (!fb?.body) {
      warn('没找到 release/官方仓库分享.md 的正文，跳过');
    } else {
      const existing = await gh('GET', `/repos/${MCP_REPO}/issues?state=all&per_page=100`);
      const dup = Array.isArray(existing.data)
        ? existing.data.find((i) => i.user?.login === OWNER)
        : null;
      if (dup) {
        warn(`检测到你在该仓库已有 Issue：#${dup.number}，跳过`);
      } else {
        const r = await gh('POST', `/repos/${MCP_REPO}/issues`, {
          title: fb.title,
          body: fb.body,
        });
        if (DRY) ok('DRY-RUN：将提交反馈 Issue');
        else if (r.ok) {
          ok(`已提交：#${r.data.number}`);
          line(`    ${r.data.html_url}`);
        } else {
          bad(`提交失败（HTTP ${r.status}）：${r.data?.message}`);
          if (r.status === 410) warn('该仓库可能已关闭 Issues —— 可改到 Discussions 手动发');
          failures++;
        }
      }
    }
  }

  /* 3. 仓库 About ---------------------------------------------- */
  if (want('about')) {
    step(3, '设置仓库 About（description / homepage）');
    const r = await gh('PATCH', `/repos/${OWNER}/${REPO}`, ABOUT);
    if (DRY) ok(`DRY-RUN：description="${ABOUT.description}" homepage="${ABOUT.homepage}"`);
    else if (r.ok) ok('About 已更新（网页刷新即可看到）');
    else {
      bad(`更新失败（HTTP ${r.status}）：${r.data?.message}`);
      if (r.status === 404 || r.status === 403) warn('Token 缺少 Administration 权限 —— 可手工改');
      failures++;
    }
  }

  /* 4. Topics -------------------------------------------------- */
  if (want('topics')) {
    step(4, '设置仓库 Topics');
    const r = await gh('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: TOPICS });
    if (DRY) ok(`DRY-RUN：topics=${TOPICS.join(', ')}`);
    else if (r.ok) ok(`Topics 已设置：${(r.data.names || TOPICS).join(', ')}`);
    else {
      bad(`设置失败（HTTP ${r.status}）：${r.data?.message}`);
      failures++;
    }
  }

  /* 5. Release ------------------------------------------------- */
  if (want('release')) {
    step(5, '创建 Release v1.0.0');
    // 先看有没有
    const exist = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${RELEASE.tag_name}`);
    if (exist.ok) {
      warn(`Release ${RELEASE.tag_name} 已存在，跳过`);
      line(`    ${exist.data.html_url}`);
    } else {
      const r = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, RELEASE);
      if (DRY) ok(`DRY-RUN：创建 Release ${RELEASE.tag_name}`);
      else if (r.ok) {
        ok(`Release 已创建：${r.data.html_url}`);
      } else {
        bad(`创建失败（HTTP ${r.status}）：${r.data?.message}`);
        if (r.status === 422) warn('通常是 tag 已存在但没有 Release —— 可先 git push --delete origin 再重试');
        failures++;
      }
    }
  }

  /* 汇总 ------------------------------------------------------- */
  line();
  line('='.repeat(60));
  if (DRY) line('DRY-RUN 结束，没有做任何修改。去掉 --dry-run 即可真正执行。');
  else if (failures === 0) line('全部完成 ✅');
  else line(`完成，但有 ${failures} 项失败（见上面 ✘）`);
  line();
  line('接下来只能手工做的：');
  line('  1. Settings → General → Social preview 上传 docs/social-preview.png');
  line('     （GitHub API 不提供社交预览图上传接口，只能网页端传）');
  line('  2. 去 V2EX / 掘金发帖（文案见 release/ 目录）');
  line('  3. 在仓库 About 面板确认 Topics 与描述显示正常');

  if (failures) process.exit(2);
}

main().catch((e) => {
  bad(`脚本异常：${e.message}`);
  process.exit(1);
});
