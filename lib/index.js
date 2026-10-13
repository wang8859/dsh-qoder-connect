// (comment restored as ASCII after encoding repair)
// Iron rule: exceptions must never crash the plugin loader (single failure = whole DSH fails to open).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import z from '@deepseek-ai/schemastery';

import {
  chat as qoderChat,
  probe as qoderProbe,
  quota as qoderQuota,
  credsInfo as qoderCredsInfo,
  loginStart as qoderLoginStart,
  loginPoll as qoderLoginPoll,
  refreshCreds as qoderRefreshCreds,
  claimDaily as qoderClaimDaily,
  inferenceInfo as qoderInferenceInfo,
  sleepMs,
} from './qoder.js';
import { readLocalQoderAuth, localAuthStatus } from './locallogin.js';

export const name = 'qoder-connect';
export const inject = ['llm'];

// (comment restored as ASCII after encoding repair)
const SETTINGS_NS = 'qoder-connect';
// (comment restored as ASCII after encoding repair)
const QODER_SECTION = z.object({});

// ---------- section ----------

const DEFAULTS = {
  pollMs: 30 * 60 * 1000,       // claimDaily cadence
  refreshMs: 6 * 60 * 60 * 1000, // (inline note removed during encoding repair)
  enabled: true,
};

function envInt(v, dflt) {
  const n = Number(process.env[v]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---------- section ----------

const CRED_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.qoder-credentials.json');

const emptyVariant = (id, product) => ({
  id,
  product,
  displayName: product === 'cn' ? 'Qoder CN' : 'Qoder',
  creds: { product },
  // Qoder CN bears a region-locked credential: the .sh gateway answers 401 and the CN
  // inference plane is VPC-only, so inference is delegated to the intl account while the
  // CN account still owns quota + daily claim. Set to null to disable delegation.
  inferenceProvider: product === 'cn' ? 'qoder' : null,
  sharedCreds: null,
});

const VARIANTS = [
  emptyVariant('qoder', 'intl'),
  emptyVariant('qoder-cn', 'cn'),
];

let credSaveTimer = null;

function scheduleCredSave() {
  if (credSaveTimer) return;
  credSaveTimer = setTimeout(() => {
    credSaveTimer = null;
    saveCredsNow().catch(() => { /* ignore */ });
  }, 300);
}

async function saveCredsNow() {
  try {
    const payload = {};
    for (const v of VARIANTS) {
      const { _pending, ...rest } = v.creds;
      payload[v.id] = rest;
    }
    const tmp = `${CRED_FILE}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, CRED_FILE);
  } catch { /* best effort */ }
}

async function loadCreds() {
  try {
    const raw = await fsp.readFile(CRED_FILE, 'utf8');
    const j = JSON.parse(raw);
    for (const v of VARIANTS) {
      if (j && typeof j[v.id] === 'object' && j[v.id]) v.creds = j[v.id];
      // Legacy credential files predate the `product` field; without it the
      // CN token would be routed to the intl gateway and rejected with 401.
      if (!v.creds.product) v.creds.product = v.product;
    }
    wireDelegation();
  } catch { /* first run or unreadable: keep empty */ }
  // A signed-in Qoder desktop client is the primary credential source: adopt its
  // session unless the plugin already holds fresher credentials for that region.
  await adoptLocalLogins((m) => {
    try { console.log(`[qoder-connect] ${m}`); } catch { /* ignore */ }
  });
}

// Pick up whatever the local Qoder / Qoder CN clients are signed in as.
// `note` is the plugin's logger; it is injected because this runs before apply().
async function adoptLocalLogins(note) {
  const say = typeof note === 'function' ? note : () => {};
  for (const v of VARIANTS) {
    let local = null;
    try { local = await readLocalQoderAuth(v.product); } catch { /* ignore */ }
    if (!local) { v.localAuth = localAuthStatus(v.product); continue; }
    v.localAuth = localAuthStatus(v.product);
    const c = v.creds || {};
    const localTok = local.securityOauthToken || '';
    const curTok = c.securityOauthToken || c.accessToken || '';
    // Prefer the local session when the plugin has none, or when the plugin's
    // token is expired/expiring and the local one is still valid.
    const curExp = Number(c.expireTime) || 0;
    const localExp = Number(local.expireTime) || 0;
    const curDead = !curTok || curExp < Date.now() + 5 * 60 * 1000;
    const localAlive = localExp > Date.now() + 60 * 1000 || !localExp;
    // Keep the plugin's own session when it is still fresher than the local one
    // (plugin-side refresh rotation runs ahead of the desktop client's own timer).
    if (curTok && !curDead && curExp >= localExp) continue;
    if (curDead && localAlive) {
      v.creds = {
        ...c,
        source: 'local',
        securityOauthToken: localTok,
        accessToken: localTok,
        refreshToken: c.refreshToken || local.refreshToken || '',
        refreshTokenExpireTime: local.refreshTokenExpireTime || c.refreshTokenExpireTime || 0,
        expireTime: localExp || (Date.now() + 30 * 24 * 3600 * 1000),
        machineId: local.machineId || c.machineId || '',
        uid: local.uid || c.uid || '',
        nickname: local.nickname || c.nickname || '',
        email: local.email || c.email || '',
        phone: local.phone || c.phone || '',
        avatarUrl: local.avatarUrl || c.avatarUrl || '',
        plan: c.plan || '',
        userType: c.userType || 'personal_standard',
      };
      delete v.creds.session;
      say(`${v.id}: local Qoder session adopted (${local.nickname || local.uid || 'user'})`);
    }
  }
  wireDelegation();
}

// A delegating variant resolves inference credentials from its provider variant, so both
// halves always read the same live token (rotation on one is immediately visible to the other).
function wireDelegation() {
  const byId = new Map(VARIANTS.map((v) => [v.id, v]));
  for (const v of VARIANTS) {
    if (!v.inferenceProvider) { v.sharedCreds = null; continue; }
    const src = byId.get(v.inferenceProvider);
    v.sharedCreds = src ? src.creds : null;
  }
}

// ---------- section ----------

// Every gateway-legal model key. Catalog snapshots below are decoded from the
// Qoder client's own model cache (catalog-v6) so names match what the desktop
// app shows (e.g. Qwen3.8-Flash = qfmodel). `unstable` marks keys whose
// upstream backend is currently failing for account-level reasons.
const CATALOG = {
  'qoder-cn': [
    { id: 'auto', name: 'Auto', max_input_tokens: 200000, price_factor: 0.5, reasoning: false },
    { id: 'fast', name: 'Fast', max_input_tokens: 200000, price_factor: 0.8, reasoning: false },
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', max_input_tokens: 180000, price_factor: 0.2, reasoning: { default: 'medium', efforts: ['low', 'medium', 'xhigh'] } },
    { id: 'qfmodel', name: 'Qwen3.8-Flash', max_input_tokens: 180000, price_factor: 0, reasoning: { default: 'medium', efforts: ['low', 'medium', 'xhigh'] } },
    { id: 'qmodel_latest', name: 'Qwen3.7-Max', max_input_tokens: 180000, price_factor: 0.5, reasoning: false },
    { id: 'qmodel', name: 'Qwen3.7-Plus', max_input_tokens: 180000, price_factor: 0.04, reasoning: false },
    { id: 'q37fmodel', name: 'Qwen3.7-Flash', max_input_tokens: 180000, price_factor: 0.1, reasoning: false },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', max_input_tokens: 96000, price_factor: 0.5, reasoning: { default: 'max', efforts: ['high', 'max'] } },
    { id: 'dfmodel', name: 'DeepSeek-Flash', max_input_tokens: 180000, price_factor: 0.1, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'gmodel', name: 'GLM-5.3', max_input_tokens: 180000, price_factor: 0.8, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'gfmodel', name: 'GLM-5.3-Flash', max_input_tokens: 1000000, price_factor: 0.1, reasoning: { default: 'max', efforts: ['high', 'max'] } },
    { id: 'gm51model', name: 'GLM-5.2', max_input_tokens: 180000, price_factor: 0.6, reasoning: { default: 'max', efforts: ['high', 'max'] } },
    { id: 'kmodel_latest', name: 'Kimi-K3', max_input_tokens: 180000, price_factor: 1.4, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'kmodel', name: 'Kimi-K2.8-Preview', max_input_tokens: 180000, price_factor: 0.8, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'mmodel', name: 'MiniMax-M2.7', max_input_tokens: 180000, price_factor: 0.2, reasoning: false },
  ],
  qoder: [
    { id: 'auto', name: 'Auto', max_input_tokens: 200000, price_factor: 0.5, reasoning: false },
    { id: 'ultimate', name: 'Ultimate', max_input_tokens: 1000000, price_factor: 2, reasoning: { default: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    { id: 'fast', name: 'Fast', max_input_tokens: 200000, price_factor: 0.8, reasoning: false },
    { id: 'performance', name: 'Performance', max_input_tokens: 1000000, price_factor: 1.1, reasoning: { default: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    { id: 'efficient', name: 'Efficient', max_input_tokens: 200000, price_factor: 0.3, reasoning: false },
    { id: 'smodel', name: 'Sonus', max_input_tokens: 180000, price_factor: 8, reasoning: { default: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    { id: 'cmodel', name: 'Cantus', max_input_tokens: 180000, price_factor: 4, reasoning: { default: 'high', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', max_input_tokens: 180000, price_factor: 0.2, reasoning: { default: 'xhigh', efforts: ['low', 'medium', 'xhigh'] } },
    { id: 'qfmodel', name: 'Qwen3.8-Flash', max_input_tokens: 180000, price_factor: 0, reasoning: { default: 'medium', efforts: ['low', 'medium', 'xhigh'] } },
    { id: 'qmodel_latest', name: 'Qwen3.7-Max', max_input_tokens: 1000000, price_factor: 0.5, reasoning: false },
    { id: 'qmodel', name: 'Qwen3.7-Plus', max_input_tokens: 1000000, price_factor: 0.04, reasoning: false },
    { id: 'kmodel_latest', name: 'Kimi-K3', max_input_tokens: 180000, price_factor: 1.4, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'kmodel', name: 'Kimi-K2.8-Preview', max_input_tokens: 180000, price_factor: 0.8, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'gmodel', name: 'GLM-5.3', max_input_tokens: 180000, price_factor: 0.8, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'gfmodel', name: 'GLM-5.3-Flash', max_input_tokens: 1000000, price_factor: 0.1, reasoning: { default: 'max', efforts: ['high', 'max'] } },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', max_input_tokens: 1000000, price_factor: 0.5, reasoning: { default: 'max', efforts: ['high', 'max'] } },
    { id: 'dfmodel', name: 'DeepSeek-Flash', max_input_tokens: 1000000, price_factor: 0.1, reasoning: { default: 'max', efforts: ['high', 'low', 'max'] } },
    { id: 'mmodel', name: 'MiniMax-M3', max_input_tokens: 180000, price_factor: 0.2, reasoning: false },
  ],
};

const DEFAULT_MAX_TOKENS = 32768;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function reasoningFields(m) {
  const r = m.reasoning;
  if (!r || r === false || !Array.isArray(r.efforts) || !r.efforts.length) return { reasoning: false };
  const pick = (k) => (r.efforts.includes(k) ? k : null);
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: 'off',
      minimal: null,
      low: pick('low'),
      medium: pick('medium'),
      high: pick('high'),
      xhigh: pick('xhigh'),
      max: pick('max'),
    },
  };
}

function toPiModel(m, baseUrl, providerId) {
  return {
    id: m.id,
    name: m.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: ['text'],
    cost: NO_COST,
    contextWindow: m.max_input_tokens || 180000,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { maxTokensField: 'max_tokens' },
    ...reasoningFields(m),
  };
}

// ---------- section ----------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOfHost(host) {
  if (!host) return '';
  const at = host.lastIndexOf(':');
  if (host.startsWith('[') && host.includes(']')) {
    const end = host.indexOf(']');
    return host.slice(0, end + 1);
  }
  if (at > 0 && !/^\[/.test(host) && host.includes(':')) return host.slice(0, at);
  return host;
}

function hostIsLoopback(host) {
  return LOOPBACK_HOSTS.has(hostnameOfHost(String(host || '')).toLowerCase());
}

function originIsLoopback(origin) {
  if (!origin) return true; // (inline note removed during encoding repair)
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase())
      || LOOPBACK_HOSTS.has(`[${new URL(origin).hostname.toLowerCase()}]`);
  } catch {
    return false;
  }
}

const REQUEST_BODY_LIMIT = 67108864;

function writeJson(res, status, body) {
  if (res.writableEnded) return;
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function openaiError(status, message, type) {
  return { error: { message: String(message || 'error'), type: type || 'upstream_error', code: status } };
}

function createShim(variant, log) {
  const token = `sk-qoder-${randomBytes(24).toString('base64url')}`;
  let server = null;
  let port = 0;

  async function handleChat(req, res, rawBody) {
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch (e) {
      return writeJson(res, 400, openaiError(400, `bad json: ${e.message}`, 'invalid_request_error'));
    }
    const messages = payload?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return writeJson(res, 400, openaiError(400, 'messages is required', 'invalid_request_error'));
    }
    const clientWantsStream = !!payload.stream;
    const abort = new AbortController();
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    // ---------- model catalog (static snapshot; enable=true entries only) ----------
    const rawModel = String(payload.model || '');
    let upstreamModel = rawModel;
    for (const p of [`${variant.id}:`, `${name}:`]) {
      if (rawModel.startsWith(p)) { upstreamModel = rawModel.slice(p.length); break; }
    }
    const known = CATALOG[variant.id] || [];
    if (!known.some((m) => m.id === upstreamModel)) {
      // ---------- model catalog (static snapshot; enable=true entries only) ----------
      if (upstreamModel === 'auto') upstreamModel = 'auto';
    }

    const chatId = `chatcmpl-qoder-${randomBytes(10).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const stats = { usage: null, finish: null };

    let prepared;
    try {
      prepared = await qoderChat(variant, upstreamModel, payload, clientWantsStream, abort.signal);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'client aborted' : String(e.message || e);
      log(`chat prepare failed: ${msg}${e.code ? ` [code=${e.code}]` : ''}`);
      const status = e.config ? 400 : (Number(e.status) || 502);
      return writeJson(res, status, openaiError(status, `${variant.displayName}: ${msg}`));
    }

    const { resp, onData } = prepared;
    if (resp.status >= 400) {
      let detail = `HTTP ${resp.status}`;
      try {
        const d = await resp.json();
        detail = String(d?.message || d?.error?.message || detail);
      } catch { /* ignore */ }
      return writeJson(res, resp.status, openaiError(resp.status, `${variant.displayName}: ${detail}`));
    }

    const emitChunk = (raw, evName) => {
      if (raw === '[DONE]') return null;
      const obj = onData(raw, evName); // throws = upstream error
      if (!obj) return null;
      if (!obj.id) obj.id = chatId;
      if (!obj.created) obj.created = created;
      if (!obj.model) obj.model = rawModel;
      if (obj.usage) stats.usage = obj.usage;
      for (const ch of obj.choices || []) if (ch.finish_reason) stats.finish = ch.finish_reason;
      // sawContent is an internal marker; never leak it to the client.
      delete obj.sawContent;
      return obj;
    };

    const pump = async (onChunk) => {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let eventName = null;
      res.on('close', () => { try { reader.cancel(); } catch { /* ignore */ } });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.trim()) { eventName = null; continue; }
          if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          const out = emitChunk(line.slice(5).trim(), eventName);
          if (out) await onChunk(out);
        }
      }
      // (comment restored as ASCII after encoding repair)
      const eofOut = (() => { try { return emitChunk(null, 'eof'); } catch (e) { throw e; } })();
      if (eofOut) await onChunk(eofOut);
    };

    if (clientWantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try {
        await pump(async (obj) => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        });
        const tail = { id: chatId, object: 'chat.completion.chunk', created, model: rawModel, choices: [{ index: 0, delta: {}, finish_reason: stats.finish || 'stop' }] };
        res.write(`data: ${JSON.stringify(tail)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        if (e.name !== 'AbortError') {
          log(`stream error: ${e.message}${e.code ? ` [code=${e.code}]` : ''}`);
          try {
            const errPayload = { error: { message: String(e.message || 'stream interrupted'), type: 'upstream_error', code: e.code || resp.status || 502 } };
            res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch { /* ignore */ }
        }
      }
      return;
    }

    // (comment restored as ASCII after encoding repair)
    const contentParts = [];
    const reasoningParts = [];
    const toolCalls = new Map();
    try {
      await pump(async (obj) => {
        for (const ch of obj.choices || []) {
          const d = ch.delta || {};
          if (d.reasoning_content) reasoningParts.push(d.reasoning_content);
          if (d.content) contentParts.push(d.content);
          for (const tc of d.tool_calls || []) {
            const i = Number(tc.index) || 0;
            const slot = toolCalls.get(i) || { id: null, name: null, arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            toolCalls.set(i, slot);
          }
        }
      });
    } catch (e) {
      return writeJson(res, 502, openaiError(502, `${variant.displayName}: ${e.message || 'aggregation error'}`));
    }
    const tcs = toolCalls.size
      ? [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id || `call_${i0()}`, type: 'function', function: { name: v.name, arguments: v.arguments } }))
      : null;
    const message = { role: 'assistant', content: contentParts.join('') || null };
    if (reasoningParts.length) message.reasoning_content = reasoningParts.join('');
    if (tcs) message.tool_calls = tcs;
    return writeJson(res, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model: rawModel,
      choices: [{ index: 0, message, finish_reason: stats.finish || (tcs ? 'tool_calls' : 'stop') }],
      usage: stats.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    function i0() { return randomBytes(6).toString('hex'); }
  }

  async function handler(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden host' });
      const origin = req.headers.origin;
      if (!originIsLoopback(origin)) return writeJson(res, 403, { error: 'forbidden origin' });
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${token}`;
      if (auth.length !== expected.length || auth !== expected) {
        return writeJson(res, 401, openaiError(401, 'invalid api key', 'authentication_error'));
      }
      const urlPath = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && urlPath === '/healthz') {
        return writeJson(res, 200, { ok: true, variant: variant.id });
      }
      if (req.method === 'GET' && urlPath === '/v1/models') {
        const models = (CATALOG[variant.id] || []).map((m) => ({ id: m.id, object: 'model', owned_by: variant.id }));
        return writeJson(res, 200, { object: 'list', data: models });
      }
      if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
        const ct = String(req.headers['content-type'] || '');
        if (!/application\/json/i.test(ct)) return writeJson(res, 415, openaiError(415, 'content-type must be application/json'));
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > REQUEST_BODY_LIMIT) return writeJson(res, 413, openaiError(413, 'payload too large'));
          chunks.push(chunk);
        }
        return await handleChat(req, res, Buffer.concat(chunks));
      }
      return writeJson(res, 404, openaiError(404, 'not found', 'invalid_request_error'));
    } catch (e) {
      log(`handler error: ${e.message}`);
      try { writeJson(res, 502, openaiError(502, 'internal error')); } catch { /* ignore */ }
    }
  }

  return {
    variant,
    token,
    get port() { return port; },
    get baseUrl() { return `http://127.0.0.1:${port}/v1`; },
    ready: new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { handler(req, res).catch(() => { /* swallow */ }); });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    }),
    close() {
      try { server?.close(); } catch { /* ignore */ }
    },
  };
}

// ---------- pi-ai adapter ----------

// Inert pi-ai credential seam: this plugin auths only via the shim shared secret (resolveApiKey); pi-ai credential lifecycle must stay untouched. INERT_AUTH, required by dsh-llm-pi-ai >= 0.1.1-rc.2.
const INERT_AUTH = {
  credentials: {
    async read() { return undefined; },
    async list() { return []; },
    async modify() { throw new Error('dsh-qoder-connect: the qoder route has no pi-ai credential lifecycle'); },
    async delete() { return undefined; },
  },
  authContext: {
    async env() { return undefined; },
    async fileExists() { return false; },
  },
};

// Request image budgets (dsh-llm-pi-ai profile defaults); qoder is text-only, using default caps.
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

function createQoderAdapter(options) {
  const { variantId, displayName, shim } = options;
  const baseUrl = shim.baseUrl;

  const buildModels = () => (CATALOG[variantId] || []).map((m) => toPiModel(m, baseUrl, variantId));

  const provider = {
    ...createProvider({
      id: variantId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'Qoder API Key',
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey ? { auth: { apiKey }, source: 'Qoder' } : undefined;
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: variantId,
    displayName,
    streamIdleTimeoutMs: 600000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qoder-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  const profiles = new Map([[variantId, profile]]);

  const adapter = new QoderPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token,
  });
  return adapter;
}

class QoderPiAiAdapter extends PiAiAdapter {
  // ---------- model catalog (static snapshot; enable=true entries only) ----------
}

// ---------- section ----------

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const pollMs = envInt('DSH_QODER_POLL_MS', cfg.pollMs);
  const refreshMs = envInt('DSH_QODER_REFRESH_MS', cfg.refreshMs);
  const log = (msg) => {
    try { ctx.logger?.info?.(`[qoder-connect] ${msg}`); } catch { /* ignore */ }
    try { console.log(`[qoder-connect] ${msg}`); } catch { /* ignore */ }
  };

  const runts = new Map(); // variantId -> runtime
  const timers = [];
  let stopped = false;

  const guard = (label, fn) => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => log(`${label} async error: ${e.message}`));
    } catch (e) {
      log(`${label} error: ${e.message}`);
    }
  };

  async function claimVariant(v, manual = false) {
    const res = await qoderClaimDaily(v).catch((e) => ({ ok: false, detail: e.message }));
    v.lastClaim = { at: Date.now(), ...(res || {}) };
    if (res?.ok && !res.skipped && res.claimed > 0) log(`${v.id}: ${res.detail}`);
    else if (manual) log(`${v.id}: claim: ${res?.detail || 'no result'}`);
    return res;
  }

  async function refreshVariant(v) {
    const res = await qoderRefreshCreds(v).catch((e) => ({ ok: false, message: e.message }));
    v.lastRefresh = { at: Date.now(), ...(res || {}) };
    if (res?.fatal) log(`${v.id}: ${res.message}`);
    if (res?.ok && !res.skipped) { scheduleCredSave(); log(`${v.id}: ${res.message}`); }
    return res;
  }

  async function quotaVariant(v) {
    try {
      const q = await qoderQuota(v);
      v.lastQuota = { at: Date.now(), ...(q || {}) };
      return q;
    } catch (e) {
      v.lastQuota = { at: Date.now(), error: e.message };
      return { error: e.message };
    }
  }

  async function startVariant(v) {
    const shim = createShim(v, log);
    await shim.ready;
    const adapter = createQoderAdapter({
      variantId: v.id,
      displayName: v.displayName,
      shim,
    });
    let releaseAdapter = null;
    try {
      releaseAdapter = ctx.llm.registerAdapter([v.id], adapter);
    } catch (e) {
      log(`${v.id}: registerAdapter failed: ${e.message}`);
      shim.close();
      return;
    }
    ctx.effect(() => () => {
      try { releaseAdapter?.(); } catch { /* ignore */ }
      shim.close();
    });
    try { ctx.emit('llm/adapters-updated'); } catch { /* ignore */ }
    log(`${v.id}: adapter registered (shim 127.0.0.1:${shim.port}, models=${(CATALOG[v.id] || []).length})`);
    runts.set(v.id, { shim, adapter });
  }

  async function init() {
    await loadCreds();

    for (const v of VARIANTS) {
      if (!cfg.enabled) break;
      await startVariant(v);
    }

    // timers: cred keepalive + daily claim + quota poll.
    timers.push(setInterval(() => guard('tick', async () => {
      if (stopped) return;
      for (const v of VARIANTS) {
        await refreshVariant(v);
        await claimVariant(v);
        await quotaVariant(v);
      }
      scheduleCredSave();
    }), pollMs));

    timers.push(setInterval(() => guard('refresh-tick', async () => {
      if (stopped) return;
      for (const v of VARIANTS) await refreshVariant(v);
      scheduleCredSave();
    }), refreshMs));

    // loopback guards: Host must be loopback; Origin must be loopback when present.
    guard('webServer', () => {
      ctx.inject(['webServer'], (webCtx) => {
        if (typeof webCtx.webServer?.register !== 'function' && typeof webCtx.register !== 'function') {
          log('webServer.register unavailable; status routes skipped');
          return;
        }
        const register = (opts) => (typeof webCtx.webServer?.register === 'function' ? webCtx.webServer.register(opts) : webCtx.register(opts));
        const basePath = '/plugins/dsh-qoder-connect';
        const routes = [
          { path: `${basePath}/status`, handler: statusHandler },
          { path: `${basePath}/login/start`, handler: loginStartHandler },
          { path: `${basePath}/login/poll`, handler: loginPollHandler },
          { path: `${basePath}/claim`, handler: claimHandler },
          { path: `${basePath}/quota`, handler: quotaHandler },
          { path: `${basePath}/logout`, handler: logoutHandler },
        ];
        for (const r of routes) {
          const dispose = register({ kind: 'exact', path: r.path, handler: r.handler });
          ctx.effect(() => () => {
            try { dispose?.(); } catch { /* ignore */ }
          }, `dsh-qoder-connect: ${r.path}`);
        }
        async function statusHandler(req, res) {
          try {
            if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
            const method = (req.method || 'GET').toUpperCase();
            const urlPath = (req.url || '/').split('?')[0];
            const sub = urlPath.slice(basePath.length) || '/status';

              if (method === 'GET' && (sub === '/status' || sub === '/')) {
                const variants = {};
                for (const v of VARIANTS) {
                  variants[v.id] = {
                    product: v.product,
                    displayName: v.displayName,
                    creds: qoderCredsInfo(v.creds),
                    quota: v.lastQuota || null,
                    lastClaim: v.lastClaim || null,
                    lastRefresh: v.lastRefresh || null,
                    adapterActive: runts.has(v.id),
                    inference: qoderInferenceInfo(v),
                  };
                }
                return writeJson(res, 200, { ok: true, plugin: name, variants, credFile: CRED_FILE });
              }
              if (method === 'POST' && sub === '/login/start') {
                const body = await readBody(req, 8192);
                const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
                const v = VARIANTS.find((x) => x.product === mode);
                if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
                const r = qoderLoginStart(v, mode);
                scheduleCredSave();
                return writeJson(res, 200, { ok: true, ...r });
              }
              if (method === 'POST' && sub === '/login/poll') {
                const body = await readBody(req, 8192);
                const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
                const v = VARIANTS.find((x) => x.product === mode);
                if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
                const r = await qoderLoginPoll(v);
                if (r?.state === 'done') { scheduleCredSave(); await startVariant(v); }
                return writeJson(res, 200, { ok: r?.state !== 'error', ...r });
              }
              if (method === 'POST' && sub === '/claim') {
                const body = await readBody(req, 8192);
                const mode = String(body?.product || body?.mode || '') === 'cn' ? 'cn' : (body?.product || body?.mode) === 'intl' ? 'intl' : null;
                const targets = mode ? VARIANTS.filter((x) => x.product === mode) : VARIANTS;
                const out = {};
                for (const v of targets) out[v.id] = await claimVariant(v, true);
                scheduleCredSave();
                return writeJson(res, 200, { ok: true, results: out });
              }
              if (method === 'POST' && sub === '/quota') {
                const body = await readBody(req, 8192);
                const mode = String(body?.product || body?.mode || '') === 'cn' ? 'cn' : (body?.product || body?.mode) === 'intl' ? 'intl' : null;
                const targets = mode ? VARIANTS.filter((x) => x.product === mode) : VARIANTS;
                const out = {};
                for (const v of targets) out[v.id] = await quotaVariant(v);
                scheduleCredSave();
                return writeJson(res, 200, { ok: true, results: out });
              }
              if (method === 'POST' && sub === '/logout') {
                const body = await readBody(req, 8192);
                const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
                const v = VARIANTS.find((x) => x.product === mode);
                if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
                v.creds = {};
                const rt = runts.get(v.id);
                if (rt) { runts.delete(v.id); }
                scheduleCredSave();
                return writeJson(res, 200, { ok: true, message: `${v.displayName} credentials cleared` });
              }
              return writeJson(res, 404, { error: 'not found' });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }

          async function loginStartHandler(req, res) {
            try {
              if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
              const body = await readBody(req, 8192);
              const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
              const v = VARIANTS.find((x) => x.product === mode);
              if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
              const r = qoderLoginStart(v, mode);
              scheduleCredSave();
              return writeJson(res, 200, { ok: true, ...r });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }

          async function loginPollHandler(req, res) {
            try {
              if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
              const body = await readBody(req, 8192);
              const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
              const v = VARIANTS.find((x) => x.product === mode);
              if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
              const r = await qoderLoginPoll(v);
              if (r?.state === 'done') { scheduleCredSave(); await startVariant(v); }
              return writeJson(res, 200, { ok: r?.state !== 'error', ...r });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }

          async function claimHandler(req, res) {
            try {
              if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
              const body = await readBody(req, 8192);
              const mode = String(body?.product || body?.mode || '') === 'cn' ? 'cn' : (body?.product || body?.mode) === 'intl' ? 'intl' : null;
              const targets = mode ? VARIANTS.filter((x) => x.product === mode) : VARIANTS;
              const out = {};
              for (const v of targets) out[v.id] = await claimVariant(v, true);
              scheduleCredSave();
              return writeJson(res, 200, { ok: true, results: out });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }

          async function quotaHandler(req, res) {
            try {
              if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
              const body = await readBody(req, 8192);
              const mode = String(body?.product || body?.mode || '') === 'cn' ? 'cn' : (body?.product || body?.mode) === 'intl' ? 'intl' : null;
              const targets = mode ? VARIANTS.filter((x) => x.product === mode) : VARIANTS;
              const out = {};
              for (const v of targets) out[v.id] = await quotaVariant(v);
              scheduleCredSave();
              return writeJson(res, 200, { ok: true, results: out });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }

          async function logoutHandler(req, res) {
            try {
              if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
              const body = await readBody(req, 8192);
              const mode = String(body?.product || body?.mode || 'intl') === 'cn' ? 'cn' : 'intl';
              const v = VARIANTS.find((x) => x.product === mode);
              if (!v) return writeJson(res, 400, { ok: false, error: 'unknown product' });
              v.creds = {};
              const rt = runts.get(v.id);
              if (rt) { runts.delete(v.id); }
              scheduleCredSave();
              return writeJson(res, 200, { ok: true, message: `${v.displayName} credentials cleared` });
            } catch (e) {
              return writeJson(res, 500, { ok: false, error: e.message });
            }
          }
      });
    });

    // (comment restored as ASCII after encoding repair)
    guard('settings', () => {
      ctx.inject(['settings'], (settingsCtx) => {
        try {
          if (typeof settingsCtx.settings?.installSection !== 'function') {
            try { ctx.logger?.warn?.('dsh-qoder-connect: host settings service has no installSection API; status card unavailable'); } catch { /* ignore */ }
            return;
          }
          settingsCtx.settings.installSection(ctx, SETTINGS_NS, QODER_SECTION, {}, {
            setSource() { /* no-op */ },
            onChange() { /* no-op */ },
          });
        } catch (e) {
          log(`settings installSection skipped: ${e.message}`);
        }
      });
    });

    log('apply complete');
  }

  guard('init', () => { init(); });

  return () => {
    stopped = true;
    for (const t of timers) { try { clearInterval(t); } catch { /* ignore */ } }
    for (const [, rt] of runts) { try { rt.shim.close(); } catch { /* ignore */ } }
    runts.clear();
    if (credSaveTimer) { clearTimeout(credSaveTimer); credSaveTimer = null; }
    saveCredsNow().catch(() => { /* ignore */ });
  };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}
