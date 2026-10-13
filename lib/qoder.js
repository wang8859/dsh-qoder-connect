// qoder.js — Qoder 协议适配器（ESM 移植自 codebuddy-proxy/backend/ext-qoder.cjs）
// 聊天（COSY 签名 + SSE 剥壳）、设备码登录、凭据保活、额度查询、每日积分领取。

import crypto from 'node:crypto';
import { QODER_TEMPLATE_B64 } from './template.js';

// ---------- 常量 ----------

export const QODER_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
export const QODER_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const QODER_SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
export const QODER_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCq9m3KbBBYLXDKDPfbQGD/hH9E
pFmvOs2B7AEKiTQVdFZzXibWJ7F1ZBGpC/o2yXvubIZIkkzKQAsYDTJHhlDoEITC
L1jQB0S5LDJvYApZfMHcVDv4MG5Y5YgWXTdCspvUXx1aZlKUlZSJETL1d6FT7qCw
DAE1GzKItGpMKJZHBwIDAQAB
-----END PUBLIC KEY-----`;

export const QODER_JOBTOKEN_URL = 'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1';
export const QODER_CHAT_URL = 'https://api2-v2.qoder.sh/model/v1/chat/completions';
export const QODER_CHAT_PATHSIG = '/model/v1/chat/completions';
export const QODER_INFER_PATH = '/model/v1/chat/completions';
export const COSY_VERSION = '0.1.43';

export const QODER_PRODUCTS = {
  intl: {
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  },
  cn: {
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  },
};

export const INFER_HOSTS = {
  intl: 'https://api2-v2.qoder.sh',
  cn: 'https://api2-v2.qoder.sh',
};
export const ME_JOBTOKEN_PATH = '/api/v1/me/jobToken';
export const DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';
export const DEVICE_REFRESH_PATH = '/api/v1/deviceToken/refresh';
export const USERINFO_PATH = '/api/v1/userinfo';
export const SASH_USAGE_PATH = '/sash/api/v2/me/usage';
export const SASH_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const POLL_MAX_FAILURES = 5;
export const QUEUE_MAX_RETRIES = 3;
export const QUEUE_SINGLE_CAP_MS = 10000;
export const QUEUE_TOTAL_CAP_MS = 30000;
export const CODE_QUEUE = '10605';
export const CODE_BILLING = '110';

// ---------- 小工具 ----------

function tsMs(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // 秒级时间戳（10 位）→ 毫秒
  const ms = n < 1e12 ? n * 1000 : n;
  return ms < Date.now() - 86400 * 1000 ? fallback : ms;
}

function sessExpireMs(creds) {
  return tsMs(creds?.session?.expireTime, 0);
}

function qoderMd5(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

// Qoder 私有 base64 变体：标准 base64 → 三段旋转（尾 a/中/头）→ 逐字符映射
export function qoderEncode(input) {
  const std = Buffer.from(input, 'utf8').toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) {
    const idx = QODER_STD.indexOf(ch);
    if (ch === '=') { out += '$'; continue; }
    if (idx < 0) throw new Error('qoderEncode: unexpected character');
    out += QODER_ALPHABET[idx];
  }
  return out;
}

function ensureMachineIds(c) {
  if (!c.machineId) c.machineId = crypto.randomUUID();
  if (!c.machineToken) {
    const raw = (c.machineId + c.machineId).replace(/-/g, '').slice(0, 50);
    c.machineToken = Buffer.from(raw).toString('base64url');
  }
  if (!c.machineType) {
    c.machineType = c.machineId.replace(/-/g, '').slice(0, 18);
  }
}

// ---------- 会话（jobToken） ----------

const sessionLocks = new Map();

// A variant may declare `inferenceProvider` to borrow another variant's credential and
// gateway. Used by Qoder CN: its bearer is region-locked to a VPC-only inference plane, so
// inference is served by the intl channel while quota/claim stay on the CN account.
function effectiveCreds(prov) {
  const scoped = prov?.inferenceProvider;
  if (scoped && prov.sharedCreds && typeof prov.sharedCreds === 'object') return prov.sharedCreds;
  return prov?.creds || {};
}

export async function qoderSession(prov, force = false) {
  const c = effectiveCreds(prov);
  const existing = c.session;
  if (!force && existing && sessExpireMs(c) > Date.now() + 5 * 60 * 1000) return existing;

  const oauthTok = c.securityOauthToken || c.accessToken || '';
  if (!oauthTok) {
    const e = new Error('qoder: no credentials (need OAuth/device token)');
    e.config = true;
    throw e;
  }

  // The inference gateway accepts the OAuth device token directly as a bearer.
  // No COSY signature, no machine fingerprint, no jobToken needed.
  const session = {
    accessToken: oauthTok,
    refreshToken: c.refreshToken || '',
    expireTime: c.expireTime || Date.now() + 3600 * 1000,
    uid: c.uid || '',
    name: c.nickname || '',
    email: '',
    plan: c.plan || '',
    userType: c.userType || 'personal_standard',
  };
  c.session = session;
  return session;
}

// Fetch a jobToken for CN (and any region that requires it). Kept as an optional path:
// the plugin tries the direct bearer first, and only calls this if the gateway rejects it.
export async function fetchJobToken(prov) {
  const c = effectiveCreds(prov);
  const oauthTok = c.securityOauthToken || c.accessToken || '';
  if (!oauthTok) {
    const e = new Error('qoder: no credentials for jobToken');
    e.config = true;
    throw e;
  }
  const product = QODER_PRODUCTS[c.product === 'cn' ? 'cn' : 'intl'];
  const resp = await fetch(`${product.openApiBase}${ME_JOBTOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${oauthTok}`,
    },
    body: JSON.stringify({ clientId: product.clientId }),
  });
  if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
    const e = new Error(`me/jobToken rejected: HTTP ${resp.status}`);
    e.config = true;
    throw e;
  }
  if (!resp.ok) throw new Error(`me/jobToken HTTP ${resp.status}`);
  const j = await resp.json().catch(() => ({}));
  const token = j.token || j.job_token;
  if (!token) throw new Error('me/jobToken response missing token');
  c.jobToken = token;
  c.jobTokenExpire = tsMs(j.expires_at, Date.now() + 6 * 60 * 60 * 1000);
  c.jobTokenRefresh = j.refresh_token || '';
  return token;
}

// ---------- COSY Bearer ----------

// ---------- 排队 / 计费错误解析 ----------

function parseQueueError(payload) {
  const nodes = [];
  const visit = (v, depth) => {
    if (v == null || depth > 6) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try { visit(JSON.parse(s), depth + 1); } catch { /* keep as string */ }
      }
      return;
    }
    if (typeof v !== 'object') return;
    nodes.push(v);
    for (const k of ['data', 'result', 'message', 'body']) visit(v[k], depth + 1);
  };
  visit(payload, 0);
  const n = nodes.find((x) => x.isQueued !== undefined || x.serviceAvailable !== undefined) || {};
  return {
    isQueued: n.isQueued === true || n.isQueued === 'true',
    serviceAvailable: n.serviceAvailable,
    modelKey: n.modelKey,
    queueType: n.queueType,
    queueCount: n.queueCount,
    retry_after_ms: n.retry_after_ms,
    retryAfterMs: n.retryAfterMs,
    retryAfterSeconds: n.retryAfterSeconds,
    waitTime: n.waitTime,
  };
}

function queueRetryAfterSec(q) {
  const ms = Number(q.retry_after_ms) || Number(q.retryAfterMs) || 0;
  if (ms > 0) return Math.ceil(ms / 1000);
  const s = Number(q.retryAfterSeconds) || 0;
  if (s > 0) return s;
  return 5;
}

function queueWaitMs(q) {
  const ms = Number(q.retry_after_ms) || Number(q.retryAfterMs) || 0;
  let wait = ms > 0 ? ms : (Number(q.retryAfterSeconds) || 0) * 1000;
  if (wait <= 0) wait = 2000;
  return Math.min(wait, QUEUE_SINGLE_CAP_MS);
}

export function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function queueError(q, msg) {
  const e = new Error(msg || 'qoder: queued upstream, retry later');
  e.code = CODE_QUEUE;
  e.retryAfter = queueRetryAfterSec(q);
  e.queue = q;
  e.noCooldown = true;
  e.retryable = true;
  return e;
}

function nextUtc8DayStartMs() {
  const nowSec = Math.floor(Date.now() / 1000);
  const utc8Sec = nowSec + 8 * 3600;
  const dayIdx = Math.floor(utc8Sec / 86400);
  const nextDayStartUtc8 = (dayIdx + 1) * 86400;
  return nextDayStartUtc8 * 1000 - 8 * 3600 * 1000;
}

function billingError(msg) {
  const e = new Error(msg || 'qoder: daily billing count exceeded');
  e.code = 4008;
  e.retryAfter = Math.max(60, Math.ceil((nextUtc8DayStartMs() - Date.now()) / 1000));
  return e;
}

function isQueueCode(v) {
  return String(v) === CODE_QUEUE;
}

function isBillingCode(v) {
  return String(v) === CODE_BILLING;
}

function looksLikeBilling(text) {
  return /billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error/i.test(String(text || ''));
}

function hasAuthError105(payload) {
  let found = false;
  const visit = (v, depth) => {
    if (found || v == null || depth > 6) return;
    if (typeof v === 'string') {
      if (v.trim().startsWith('{')) { try { visit(JSON.parse(v), depth + 1); } catch { /* ignore */ } }
      return;
    }
    if (typeof v !== 'object') return;
    if (Number(v.code) === 105 || v.type === 'auth_error') { found = true; return; }
    for (const k of ['data', 'result', 'message', 'body', 'error']) visit(v[k], depth + 1);
  };
  visit(payload, 0);
  return found;
}

// ---------- 模板渲染 ----------

let templateCache = null;

export function qoderTemplate() {
  if (!templateCache) {
    if (!QODER_TEMPLATE_B64 || QODER_TEMPLATE_B64.length < 1000) {
      const e = new Error('qoder: baseprompt template missing');
      e.config = true;
      throw e;
    }
    templateCache = Buffer.from(QODER_TEMPLATE_B64, 'base64').toString('utf8');
  }
  const rendered = templateCache
    .replace(/\{UUID\d\}/g, () => crypto.randomUUID())
    .replace(/\{TIME1\}/g, () => String(Date.now()));
  return JSON.parse(rendered);
}

// ---------- SSE 帧剥壳 ----------

function onDataFrame(raw, state) {
  if (raw === '[DONE]') { state.sawDone = true; return null; }
  let wrap;
  try { wrap = JSON.parse(raw); } catch { return null; }
  let inner = wrap?.body ?? wrap?.data ?? wrap;
  for (let i = 0; i < 3; i++) {
    if (typeof inner === 'string') {
      try { inner = JSON.parse(inner); } catch { break; }
      continue;
    }
    if (inner && typeof inner === 'object' && (inner.body !== undefined || inner.data !== undefined)
        && (typeof inner.body === 'string' || typeof inner.data === 'string')) {
      const next = inner.body ?? inner.data;
      try { inner = JSON.parse(next); } catch { break; }
      continue;
    }
    break;
  }
  // 错误帧 A：{code, message, type}
  if (inner && typeof inner === 'object' && inner.code !== undefined && inner.message !== undefined && !inner.choices) {
    if (isQueueCode(inner.code)) {
      const q = parseQueueError(inner);
      throw queueError(q);
    }
    if (isBillingCode(inner.code) || looksLikeBilling(inner.message)) {
      throw billingError(inner.message);
    }
    const e = new Error(String(inner.message || `upstream code ${inner.code}`));
    e.code = inner.code;
    throw e;
  }
  // 错误帧 B：网关形态
  if (inner && typeof inner === 'object'
      && ((inner.statusCodeValue !== undefined && Number(inner.statusCodeValue) >= 400)
        || inner.stackTrace
        || inner.type === 'model_error')) {
    const e = new Error(String(inner.message || inner.errorMessage || 'qoder gateway error'));
    if (inner.statusCodeValue) e.status = Number(inner.statusCodeValue);
    throw e;
  }
  // 常规帧：choices[]
  const choices = [];
  if (inner && Array.isArray(inner.choices)) {
    for (const ch of inner.choices) {
      // Two upstream shapes reach this point:
      //   streaming  -> { index, delta: { content } }
      //   non-stream -> { index, message: { content }, finish_reason }
      // Fold the non-stream message into a delta so one aggregator serves both.
      const delta = ch.delta || ch.message || {};
      choices.push({
        index: Number(ch.index) || 0,
        delta: {
          ...(delta.role ? { role: delta.role } : {}),
          ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning_content ? { reasoning_content: delta.reasoning_content } : {}),
          ...(Array.isArray(delta.tool_calls) && delta.tool_calls.length ? { tool_calls: delta.tool_calls } : {}),
        },
        ...(ch.finish_reason ? { finish_reason: ch.finish_reason } : {}),
      });
    }
  }
  let out = null;
  if (choices.length) {
    out = { choices };
  } else if (state.sawDone) {
    return null;
  }
  if (inner?.usage) {
    out = out || { choices: [] };
    out.usage = inner.usage;
  }
  // `sawContent` stays on the frame only while prescreenStream decides whether the
  // stream is empty; the caller strips it before the frame reaches a client.
  if (out && choices.length) out.sawContent = true;
  if (out?.sawContent) state.sawContent = true;
  return out;
}

// ---------- 请求体构建 ----------

// 客户端 UI 的模型 key 与 api2-v2 网关的真实推理模型 ID 不同（catalog-v6
// 只存 UI key，实时模型列表才返回服务端 ID）。以下映射来自实测：
// qfmodel(Qwen3.8-Flash) -> qwen-flash，qmodel(Qwen3.7-Plus) -> qwen-plus，
// auto -> auto。未列出的 key 原样透传，由网关决定是否支持。
export const MODEL_ID_ALIAS = {
  qfmodel: 'qwen-flash',
  qmodel: 'qwen-plus',
  auto: 'auto',
};

function meta() {
  return { id: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

export function buildChatBody(upstreamModel, payload, sess) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    const entry = { role, content: text };
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      entry.tool_calls = m.tool_calls;
    }
    if (role === 'tool' && m.tool_call_id) entry.tool_call_id = m.tool_call_id;
    out.push(entry);
  }
  const resolvedModel = MODEL_ID_ALIAS[upstreamModel] || upstreamModel || 'auto';
  const body = {
    model: resolvedModel,
    messages: out,
    stream: payload?.stream !== false,
  };
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(payload?.tools) && payload.tools.length) body.tools = payload.tools;
  if (payload?.max_tokens) body.max_tokens = Number(payload.max_tokens);
  if (payload?.temperature !== undefined) body.temperature = payload.temperature;
  if (payload?.top_p !== undefined) body.top_p = payload.top_p;
  if (payload?.stop) body.stop = payload.stop;
  // Pass the client's reasoning effort through unchanged (e.g. "off",
  // "low", "medium", "high", "xhigh"). The upstream gateway decides how to
  // interpret it; the shim must not rewrite the user's thinking level.
  if (payload?.reasoning_effort !== undefined) body.reasoning_effort = payload.reasoning_effort;
  return body;
}

export function buildChatHeaders(c, sess, modelKey) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${sess.accessToken || c.securityOauthToken || c.accessToken || ''}`,
    'user-agent': 'Qoder',
    'x-model-key': modelKey || 'auto',
  };
}

export function inferUrl(c, prov) {
  const region = prov?.inferenceProvider ? 'intl' : (c?.product === 'cn' ? 'cn' : 'intl');
  return INFER_HOSTS[region] + QODER_INFER_PATH;
}

// The gateway speaks plain OpenAI. Bearer = OAuth/device token (verified 200 OK).
export async function sendChat(c, sess, bodyStr, modelKey, prov) {
  const headers = buildChatHeaders(c, sess, modelKey);
  return fetch(inferUrl(c, prov), { method: 'POST', headers, body: bodyStr });
}

// 偷看 SSE 首帧判排队（排队帧可能藏在 200 流里）；非排队则把已读原文接回流。
// 注意：reader 只在 body 存活期间拿一次，之后统一交给 replayFrom 复用。
// prescreenStream 只负责「首帧不是错误帧」这件事，解析结果只写进 state.firstChunk
// 用于空流判定；原文一律通过 replayFrom 交还给调用方的 pump 重新解析，避免双解析
// 造成 sawContent 提前置位、后续帧被误判为空。
async function prescreenStream(resp, state) {
  let reader;
  try {
    reader = resp.body.getReader();
  } catch {
    return resp;
  }
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '');
        pending = pending.slice(idx + 1);
        if (!line.trim()) { state.eventName = null; continue; }
        if (line.startsWith('event:')) { state.eventName = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        // 只判错，不消费：原文留给 replayFrom 回放。
        onDataFrame(line.slice(5).trim(), { sawDone: false, sawContent: false, eventName: state.eventName, firstChunk: null });
        return replayFrom(resp, reader, pending);
      }
    }
  } catch (e) {
    try { reader.cancel(); } catch { /* ignore */ }
    throw e;
  }
  return replayFrom(resp, reader, pending);
}

// 把已读走的 reader 与 pending 文本拼接成一个可继续消费的 Response。
// reader 必须是尚未释放的那个（由 prescreenStream 传入），绝不能重新 getReader()。
function replayFrom(origResp, reader, pendingText) {
  const encoder = new TextEncoder();
  let pushed = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!pushed) {
        if (pendingText) controller.enqueue(encoder.encode(pendingText));
        pushed = true;
        return;
      }
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel() {
      try { reader.cancel(); } catch { /* ignore */ }
    },
  });
  return new Response(stream, {
    status: origResp.status,
    statusText: origResp.statusText,
    headers: origResp.headers,
  });
}

// ---------- 对外主入口：chat ----------

// The gateway replies with a single non-SSE JSON object when the client did not ask
// for a stream. Detect that shape before prescreening so the shim can serve it as-is.
function looksLikeJsonObjectBody(resp, raw) {
  if (!resp.headers.get('content-type')?.includes('application/json')) return false;
  const t = raw.trimStart();
  return t.startsWith('{');
}

export async function chat(prov, upstreamModel, payload, wantStream, signal) {
  const c = effectiveCreds(prov);
  state: for (;;) {
    const sess = await qoderSession(prov);
    const bodyObj = buildChatBody(upstreamModel, payload, sess);
    const encoded = JSON.stringify(bodyObj);
    let resp;
    try {
      resp = await sendChat(c, sess, encoded, upstreamModel || 'auto', prov);
    } catch (e) {
      if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
      throw e;
    }
    if (resp.status === 401) {
      delete c.session;
      await qoderSession(prov, true);
      continue state; // 换会话重试一次由外部冷却兜底，这里直接重走
    }
    if (resp.status === 403 || resp.status === 429) {
      const text = await resp.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      const q = parsed ? parseQueueError(parsed) : null;
      if (q && q.isQueued) throw queueError(q);
      if (hasAuthError105(parsed ?? text)) {
        delete c.session;
        await qoderSession(prov, true);
        continue state;
      }
      if (looksLikeBilling(text)) throw billingError(text);
      const e = new Error(`HTTP ${resp.status}: ${String(text).slice(0, 200)}`);
      e.status = resp.status;
      throw e;
    }
    if (resp.status >= 400) {
      const text = await resp.text().catch(() => '');
      const e = new Error(`HTTP ${resp.status}: ${String(text).slice(0, 200)}`);
      e.status = resp.status;
      if (resp.status === 402) e.code = 4008;
      throw e;
    }

    // Clone once so both the JSON-object probe and the SSE path can read the body.
    let head = '';
    try {
      const cloned = resp.clone();
      head = (await cloned.text()).slice(0, 4096);
    } catch { /* clone unsupported: fall through to SSE handling */ }

    if (looksLikeJsonObjectBody(resp, head)) {
      // Upstream answered with a complete OpenAI-shaped object. Wrap it so the shim's
      // pump sees exactly one data frame and its aggregator produces the same shape.
      let obj = null;
      try { obj = JSON.parse(head); } catch { /* fall through to SSE handling */ }
      if (obj && obj.choices) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        const state = { sawDone: true, sawContent: true, eventName: null, firstChunk: null };
        return {
          resp: new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers }),
          onData: (raw, evName) => onDataFrame(raw, state),
          state,
          nonStreamJson: obj,
        };
      }
    }

    const state = { sawDone: false, sawContent: false, eventName: null, firstChunk: null };
    const screened = await prescreenStream(resp, state);
    if (state.firstChunk === null && !state.sawContent) {
      // 首帧即错误已抛出；走到这里说明首帧正常或流提前结束
    }
    return {
      resp: screened,
      onData: (raw, evName) => onDataFrame(raw, state),
      state,
    };
  }
}

export function probe(prov) {
  return qoderSession(prov);
}

// True when a variant is configured to borrow another variant's inference channel.
export function isDelegated(prov) {
  return !!prov?.inferenceProvider;
}

// Snapshot of the resolved inference source, for the status endpoint.
export function inferenceInfo(prov) {
  const c = effectiveCreds(prov);
  return {
    delegated: !!prov?.inferenceProvider,
    inferenceProvider: prov?.inferenceProvider || null,
    endpoint: inferUrl(c, prov),
    region: prov?.inferenceProvider ? 'intl' : (c?.product === 'cn' ? 'cn' : 'intl'),
  };
}

// ---------- OAuth / 设备码登录 ----------

function productOf(c, prov) {
  // The product/region may live on the stored credentials or on the variant
  // object itself. Fall back to the variant id so a legacy credentials file
  // without `product` still routes CN tokens to the .com.cn gateway.
  const region = c?.product || prov?.product || (prov?.id === 'qoder-cn' ? 'cn' : '');
  return QODER_PRODUCTS[region === 'cn' ? 'cn' : 'intl'];
}

function oauthToken(c) {
  return c?.securityOauthToken || c?.accessToken || '';
}

export function makePkce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let verifier = '';
  const len = 64;
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) verifier += chars[bytes[i] % chars.length];
  const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

function clearPending(c) {
  delete c._pending;
}

export function loginStart(prov, mode) {
  const c = prov.creds || (prov.creds = {});
  const product = QODER_PRODUCTS[mode === 'cn' ? 'cn' : 'intl'];
  const { verifier, challenge } = makePkce();
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  c._pending = {
    flow: 'device',
    product: mode === 'cn' ? 'cn' : 'intl',
    nonce, verifier, challenge, machineId,
    failures: 0,
    deadline: Date.now() + LOGIN_TIMEOUT_MS,
  };
  const params = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: product.clientId,
  });
  return { url: `${product.authBase}/device/selectAccounts?${params.toString()}`, nonce, product: c._pending.product };
}

export async function loginPoll(prov) {
  const c = prov.creds || {};
  const p = c._pending;
  if (!p || p.flow !== 'device') return { state: 'error', message: '没有进行中的登录' };
  if (Date.now() > p.deadline) {
    clearPending(c);
    return { state: 'error', message: '登录超时，请重新发起' };
  }
  const product = QODER_PRODUCTS[p.product];
  let resp;
  try {
    resp = await fetch(`${product.openApiBase}${DEVICE_POLL_PATH}?${new URLSearchParams({
      nonce: p.nonce,
      verifier: p.verifier,
      challenge_method: 'S256',
    })}`);
  } catch (e) {
    p.failures += 1;
    if (p.failures >= POLL_MAX_FAILURES) {
      clearPending(c);
      return { state: 'error', message: `网络连续失败 ${POLL_MAX_FAILURES} 次，登录终止` };
    }
    return { state: 'pending', message: `网络波动，重试中 (${p.failures}/${POLL_MAX_FAILURES})` };
  }
  if (resp.status === 404) return { state: 'pending', message: '等待授权确认…' };
  if (!resp.ok) {
    p.failures += 1;
    if (p.failures >= POLL_MAX_FAILURES) {
      clearPending(c);
      return { state: 'error', message: `轮询 HTTP ${resp.status}，登录终止` };
    }
    return { state: 'pending', message: `轮询 HTTP ${resp.status}，重试中` };
  }
  const j = await resp.json().catch(() => ({}));
  const token = j.token || j.device_token || j.access_token;
  if (!token) {
    clearPending(c);
    return { state: 'error', message: '授权响应缺少 token' };
  }
  c.securityOauthToken = token;
  c.accessToken = token;
  c.refreshToken = j.refresh_token || '';
  c.expireTime = tsMs(j.expires_at, Date.now() + 3600 * 1000);
  c.refreshExpireTime = tsMs(j.refresh_expires_at, 0);
  c.machineId = p.machineId;
  c.uid = j.user_id || '';
  c.nickname = j.user_name || '';
  c.product = p.product;
  delete c.session;
  clearPending(c);
  // 补昵称（失败不阻断）
  try {
    const ui = await fetch(`${product.openApiBase}${USERINFO_PATH}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (ui.ok) {
      const u = await ui.json().catch(() => ({}));
      c.nickname = u.nickname || u.name || u.user_name || c.nickname;
      c.uid = u.uid || u.user_id || c.uid;
    }
  } catch { /* ignore */ }
  return { state: 'done', message: `登录成功：${c.nickname || c.uid || 'Qoder 用户'}（${p.product === 'cn' ? 'CN' : 'INTL'}）` };
}

export async function refreshCreds(prov) {
  const c = prov.creds || {};
  const oauth = oauthToken(c);
  if (!oauth) {
    // PAT 凭据：会话过期就重换
    if (c.personalToken && sessExpireMs(c) && sessExpireMs(c) < Date.now() + 3600 * 1000) {
      await qoderSession(prov, true);
      return { ok: true, skipped: false, message: 'PAT 会话已重换' };
    }
    return { ok: true, skipped: true, message: 'PAT 凭据无需刷新' };
  }
  if (c.refreshExpireTime && c.refreshExpireTime < Date.now()) {
    return { ok: false, fatal: true, message: 'refresh_token 已过期，请重新登录' };
  }
  if (c.expireTime && c.expireTime > Date.now() + 3600 * 1000) {
    return { ok: true, skipped: true, message: '凭据仍新鲜（>1h）' };
  }
  if (!c.refreshToken) {
    return { ok: false, fatal: true, message: '缺少 refresh_token，请重新登录' };
  }
  const product = productOf(c, prov);
  const resp = await fetch(`${product.openApiBase}${DEVICE_REFRESH_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: c.refreshToken, machine_id: c.machineId || '' }),
  });
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, fatal: true, message: `刷新被拒（HTTP ${resp.status}），请重新登录` };
  }
  if (!resp.ok) return { ok: false, message: `刷新失败 HTTP ${resp.status}` };
  const j = await resp.json().catch(() => ({}));
  const token = j.device_token || j.token || j.access_token;
  if (!token) return { ok: false, message: '刷新响应缺少 token' };
  c.securityOauthToken = token;
  c.accessToken = token;
  if (j.refresh_token) c.refreshToken = j.refresh_token;
  c.expireTime = tsMs(j.expires_at, Date.now() + 3600 * 1000);
  delete c.session;
  return { ok: true, skipped: false, message: '凭据已刷新' };
}

// ---------- 额度 ----------

function sashHeaders(c) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${oauthToken(c)}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
    'Cosy-MachineToken': c.machineToken || '',
    'Cosy-MachineType': c.machineType || '',
  };
}

function fmtQuota(seg) {
  if (!seg) return null;
  const total = Number(seg.total) || 0;
  const used = Number(seg.used) || 0;
  const remaining = seg.remaining !== undefined ? Number(seg.remaining) : Math.max(0, total - used);
  return { total, used, remaining, unit: seg.unit || 'credits' };
}

export async function quota(prov) {
  const c = prov.creds || {};
  const oauth = oauthToken(c);
  if (!oauth) {
    const sess = await qoderSession(prov).catch(() => null);
    return {
      mode: 'pat',
      nickname: c.nickname || sess?.name || '',
      plan: sess?.plan || '',
      lines: ['PAT 凭据无余额接口，仅显示会话身份'],
    };
  }
  ensureMachineIds(c);
  const product = productOf(c, prov);
  const resp = await fetch(`${product.openApiBase}${SASH_USAGE_PATH}`, { headers: sashHeaders(c) });
  if (!resp.ok) {
    const e = new Error(`usage HTTP ${resp.status}`);
    if (resp.status === 401 || resp.status === 403) e.config = true;
    throw e;
  }
  const j = await resp.json().catch(() => ({}));
  const u = j.qoderUsage || j.usage || {};
  const displayMode = u.displayMode || j.displayMode || '';
  const segments = [];
  if (u.userQuota) segments.push({ key: 'userQuota', ...fmtQuota(u.userQuota) });
  if (u.addOnQuota) segments.push({ key: 'addOnQuota', ...fmtQuota(u.addOnQuota) });
  if (Array.isArray(u.dedicatedResourcePackages)) {
    u.dedicatedResourcePackages.forEach((p, i) => {
      const f = fmtQuota(p);
      if (f) segments.push({ key: `dedicated_${i}`, ...f });
    });
  }
  return {
    mode: displayMode === 'enterprise' ? 'enterprise' : 'personal',
    nickname: c.nickname || '',
    plan: c.plan || '',
    expiresAt: u.expiresAt || null,
    segments,
  };
}

// ---------- 每日积分领取 ----------

export async function claimDaily(prov) {
  const c = prov.creds || {};
  const oauth = oauthToken(c);
  if (!oauth) return { ok: false, skipped: true, detail: '仅 OAuth 登录可领取积分' };
  ensureMachineIds(c);
  const product = productOf(c, prov);
  const resp = await fetch(`${product.openApiBase}${SASH_CAMPAIGNS_PATH}`, { headers: sashHeaders(c) });
  if (!resp.ok) return { ok: false, detail: `活动列表 HTTP ${resp.status}` };
  const j = await resp.json().catch(() => ({}));
  const camps = j?.list?.campaigns || j?.campaigns || [];
  const targets = camps.filter((t) => t.actionType === 'CLAIM_BENEFIT' && t.claimStatus === 'CLAIMABLE' && t.campaignId);
  if (!targets.length) {
    const claimedExists = camps.some((t) => t.claimStatus === 'CLAIMED');
    return { ok: true, claimed: 0, detail: claimedExists ? '今天已领取' : '当前没有可领取的活动' };
  }
  let total = 0;
  let replayed = 0;
  for (const t of targets) {
    let r2;
    try {
      r2 = await fetch(`${product.openApiBase}${SASH_CAMPAIGNS_PATH}/${t.campaignId}/claim`, {
        method: 'POST',
        headers: { ...sashHeaders(c), 'content-type': 'application/json' },
        body: '',
      });
    } catch (e) {
      return { ok: false, claimed: total, detail: `领取请求失败: ${e.message}` };
    }
    if (!r2.ok) return { ok: false, claimed: total, detail: `领取 HTTP ${r2.status}` };
    const b = await r2.json().catch(() => ({}));
    if (b.replayed === true) { replayed += 1; continue; }
    if (b.status && b.status !== 'CLAIMED') return { ok: false, claimed: total, detail: `领取异常 status=${b.status}` };
    total += Number(b?.benefit?.amount) || Number(t.amount) || 0;
  }
  const detail = replayed === targets.length ? '今天已领取' : `领取成功 +${total} credits`;
  return { ok: true, claimed: total, detail };
}

// ---------- 凭据摘要 ----------

export function credsInfo(c) {
  c = c || {};
  const hasOAuth = !!(c.securityOAuthToken || c.accessToken);
  const tokenValid = hasOAuth && (!c.expireTime || c.expireTime > Date.now());
  return {
    hasPat: !!c.personalToken,
    hasOAuth,
    hasRefreshToken: !!c.refreshToken,
    nickname: c.nickname || '',
    uid: c.uid || '',
    product: c.product || '',
    expireTime: c.expireTime || null,
    // Account is usable when an OAuth token exists and has not expired.
    // The desktop client also stores a "session" envelope, but a refreshed
    // credential set may legitimately lack it, so it is not required here.
    sessionActive: tokenValid,
    machineId: c.machineId || '',
  };
}

