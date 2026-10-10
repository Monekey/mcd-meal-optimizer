/**
 * 麦当劳 MCP Streamable HTTP 客户端
 *
 * 端点：https://mcp.mcd.cn   协议：2025-06-18   限流：600 次/分钟
 *
 * 设计要点（来自实测）：
 *  1) 响应是 SSE（text/event-stream），需要逐块读并在拿到目标 id 的消息后立即停止，
 *     否则连接可能长期挂住。
 *  2) initialize 的响应头里可能没有 mcp-session-id（实测 serverInfo 返回 200 但无 session），
 *     因此 sessionId 全程按「可选」处理。
 *  3) 实测存在「返回空文本」的抖动（同一 session 连续 5 次调用全空），
 *     所以 tools/call 默认带重试。
 *  4) Token 只从环境变量或本机 WorkBuddy 配置「读取」，任何情况下不写入、不落库、不打印。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENDPOINT = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn';
export const PROTOCOL_VERSION = '2025-06-18';

let _cachedToken;

/** 读取 Token：仅读取，绝不写入。优先环境变量，其次本机 WorkBuddy MCP 配置。 */
export function getToken() {
  if (_cachedToken !== undefined) return _cachedToken;

  const env = (process.env.MCD_MCP_TOKEN || '').trim();
  if (env) return (_cachedToken = env);

  try {
    const p = path.join(os.homedir(), '.workbuddy', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const auth = cfg?.mcpServers?.['mcd-mcp']?.headers?.Authorization || '';
    const t = auth.replace(/^Bearer\s+/i, '').trim();
    if (t) return (_cachedToken = t);
  } catch {
    /* 读不到就当作未配置 */
  }
  return (_cachedToken = null);
}

export const hasToken = () => !!getToken();

/** 把 SSE / 纯 JSON 响应体拆成 JSON-RPC 消息数组 */
export function parseSseMessages(raw) {
  const out = [];
  if (!raw) return out;

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* 分块截断，忽略 */
    }
  }

  if (!out.length) {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        out.push(JSON.parse(t));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function hasMessageWithId(raw, id) {
  return parseSseMessages(raw).some((m) => m && m.id === id);
}

async function readStream(res, wantId, timeoutMs) {
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;

  try {
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;

      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ __timeout: true }), remain)),
      ]);

      if (chunk.__timeout) break;
      if (chunk.done) break;

      buf += dec.decode(chunk.value, { stream: true });
      if (wantId != null && hasMessageWithId(buf, wantId)) break;
    }
  } catch {
    /* 网络中断 / 主动取消，保留已读内容 */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return buf;
}

export class McdMcpClient {
  constructor({ token } = {}) {
    this.token = token || getToken();
    this.sessionId = null;
    this._id = 0;
    this.stats = { requests: 0, retries: 0, failures: 0, startedAt: null };
  }

  get configured() {
    return !!this.token;
  }

  async #post(body, { timeoutMs = 45000 } = {}) {
    if (!this.token) throw new Error('MCD_MCP_TOKEN 未配置');

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs + 5000);

    let res;
    try {
      this.stats.requests += 1;
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const text = await readStream(res, body.id, timeoutMs);
    return { status: res.status, text, messages: parseSseMessages(text), sid };
  }

  async #rpc(method, params, opts = {}) {
    const id = ++this._id;
    return this.#post({ jsonrpc: '2.0', id, method, params }, opts);
  }

  async #notify(method, params = {}) {
    return this.#post({ jsonrpc: '2.0', method, params });
  }

  /** 建立会话。幂等。 */
  async initialize() {
    if (this._ready) return this.serverInfo;
    const { status, messages } = await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-meal-optimizer', version: '1.0.0' },
    });

    const result = messages.find((m) => m?.result?.serverInfo)?.result || {};
    this.serverInfo = result.serverInfo || null;
    this.protocolVersion = result.protocolVersion || null;

    if (status !== 200) throw new Error(`initialize 失败：HTTP ${status}`);

    await this.#notify('notifications/initialized');
    this._ready = true;
    this.stats.startedAt = new Date().toISOString();
    return this.serverInfo;
  }

  async listTools() {
    await this.initialize();
    const { messages } = await this.#rpc('tools/list');
    return messages.find((m) => m?.result?.tools)?.result.tools || [];
  }

  /**
   * 调用工具。返回 { ok, text, json, error }
   * 实测 MCP 会间歇性返回空文本，故默认重试。
   */
  async call(name, args = {}, { retries = 3, timeoutMs = 45000 } = {}) {
    await this.initialize();

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        this.stats.retries += 1;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }

      let messages;
      try {
        ({ messages } = await this.#rpc('tools/call', { name, arguments: args }, { timeoutMs }));
      } catch (e) {
        lastErr = e;
        continue;
      }

      const msg = messages.find((m) => m?.id != null && (m.result || m.error));
      if (!msg) {
        lastErr = new Error('空响应');
        continue;
      }
      if (msg.error) {
        this.stats.failures += 1;
        return { ok: false, error: msg.error, text: '' };
      }

      const text = (msg.result?.content || [])
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');

      if (!text) {
        lastErr = new Error('返回空文本');
        continue;
      }
      return { ok: true, text, json: msg.result };
    }

    this.stats.failures += 1;
    return { ok: false, error: { message: lastErr?.message || '调用失败' }, text: '' };
  }
}

export default McdMcpClient;
