import http from 'node:http';
import { createServer as createMockUpstreamServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertPromptAllowed } from '../shared/filter.js';
import { bearerToken, verifyTastingToken } from '../shared/token.js';
import {
  decryptJsonFromSubtext,
  decryptJsonFromSubtextWithPrivateKey,
  encryptJsonToSubtext,
  encryptJsonToSubtextForPublicKey,
  hasSubtext,
} from '../subtext/index.js';

const HOST = process.env.LUCKRIG_PROXY_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.LUCKRIG_PROXY_PORT ?? '8788', 10);
const NODE_ID = process.env.LUCKRIG_NODE_ID ?? 'local-poc-node';
const TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-dev-secret-change-me';
const UPSTREAM_URL = process.env.LUCKRIG_UPSTREAM_URL ?? '';
const NODE_PRIVATE_KEY = process.env.LUCKRIG_NODE_PRIVATE_KEY ?? '';

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    ...extra,
  };
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, corsHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function extractSubtextMessage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    throw Object.assign(new Error('messages[] is empty'), { statusCode: 400 });
  }

  let subtextMessage = null;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      throw Object.assign(new Error('every message must be an object'), { statusCode: 400 });
    }
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    const content = typeof message.content === 'string' ? message.content : '';
    if (role !== 'user') {
      throw Object.assign(new Error(`only role="user" is allowed via luckrig proxy; got role="${message.role ?? ''}"`), { statusCode: 400 });
    }
    if (!hasSubtext(content)) {
      throw Object.assign(new Error('plaintext content is not allowed: all user messages must carry a subtext-encrypted payload'), { statusCode: 400 });
    }
    if (subtextMessage === null) subtextMessage = content;
  }

  if (subtextMessage === null) {
    throw Object.assign(new Error('encrypted subtext prompt not found in messages[].content'), { statusCode: 400 });
  }
  return subtextMessage;
}

function completionTextFromUpstreamResponse(responseBody) {
  const choice = responseBody?.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? responseBody?.response ?? '';
}

async function mockGenerate({ prompt }) {
  const userText = typeof prompt?.prompt === 'string'
    ? prompt.prompt
    : JSON.stringify(prompt);
  return {
    text: `mock:${userText}`,
    upstream: 'mock',
  };
}

async function callUpstream({ body, prompt, upstreamUrl = UPSTREAM_URL, fetchImpl = fetch }) {
  if (!upstreamUrl) return mockGenerate({ prompt });

  const promptText = typeof prompt?.prompt === 'string' ? prompt.prompt : JSON.stringify(prompt);
  // Only forward the decrypted user prompt. Never relay other client-side message
  // entries: extractSubtextMessage already rejects plaintext, but we defense-in-depth
  // here so even if extraction is broadened later we do not leak plaintext upstream.
  const upstreamBody = {
    model: body?.model,
    stream: false,
    messages: [{ role: 'user', content: promptText }],
  };

  const res = await fetchImpl(upstreamUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamBody),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const responseBody = await res.json();
  return {
    text: completionTextFromUpstreamResponse(responseBody),
    upstream: upstreamUrl,
  };
}

function applyTierPolicy(text, tokenPayload) {
  if (tokenPayload?.tier !== 'limited') return { text, limited: false };
  const limit = Number.parseInt(process.env.LUCKRIG_LIMITED_OUTPUT_CHARS ?? '240', 10);
  if (!Number.isFinite(limit) || limit <= 0 || String(text).length <= limit) return { text, limited: false };
  return {
    text: `${String(text).slice(0, limit)}

[limited tasting output truncated]`,
    limited: true,
  };
}

function buildPseudoSseChunks(encryptedResponseText, { created = Math.floor(Date.now() / 1000), model = 'luckrig-proxy' } = {}) {
  const id = `chatcmpl-luckrig-${created}`;
  return [
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: encryptedResponseText }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

export async function processChatCompletion({
  body,
  authHeader,
  nodeId = NODE_ID,
  trackerSecret = TRACKER_SECRET,
  upstreamUrl = UPSTREAM_URL,
  fetchImpl = fetch,
  nowMs = Date.now(),
  nodePrivateKey = NODE_PRIVATE_KEY,
} = {}) {
  const token = bearerToken(authHeader);
  if (!token) throw Object.assign(new Error('missing bearer token'), { statusCode: 401 });
  const tokenPayload = verifyTastingToken(token, { secret: trackerSecret, expectedNodeId: nodeId, nowMs });

  const encryptedPromptText = extractSubtextMessage(body);
  const cryptoMode = tokenPayload.crypto_mode ?? 'session-secret';
  const prompt = cryptoMode === 'public-key'
    ? decryptJsonFromSubtextWithPrivateKey(encryptedPromptText, { privateKey: nodePrivateKey })
    : decryptJsonFromSubtext(encryptedPromptText, { sessionSecret: tokenPayload.session_secret });

  const promptPolicy = assertPromptAllowed(prompt);

  const queuedAt = performance.now();
  // POC queue UX: buffer upstream response fully, then emit pseudo SSE in one pass.
  const generationStartedAt = performance.now();
  const upstream = await callUpstream({ body, prompt, upstreamUrl, fetchImpl });
  const tiered = applyTierPolicy(upstream.text, tokenPayload);
  const generationSec = (performance.now() - generationStartedAt) / 1000;
  const queueWaitSec = (generationStartedAt - queuedAt) / 1000;

  const responseEnvelope = {
    schema_version: 1,
    node_id: nodeId,
    prompt,
      prompt_policy: promptPolicy,
    response: tiered.text,
    limited_output_truncated: tiered.limited,
    queue_wait_sec: Number(queueWaitSec.toFixed(3)),
    generation_sec: Number(generationSec.toFixed(3)),
    upstream: upstream.upstream,
  };
  const encryptedResponseText = cryptoMode === 'public-key'
    ? encryptJsonToSubtextForPublicKey(responseEnvelope, {
      publicKey: tokenPayload.user_public_key,
      coverText: 'luckrig response payload',
    })
    : encryptJsonToSubtext(responseEnvelope, {
      sessionSecret: tokenPayload.session_secret,
      coverText: 'luckrig response payload',
    });

  if (body?.stream) {
    return {
      kind: 'sse',
      status: 200,
      token_payload: tokenPayload,
      prompt,
      response_envelope: responseEnvelope,
      chunks: buildPseudoSseChunks(encryptedResponseText, { model: body.model ?? 'luckrig-proxy' }),
    };
  }

  return {
    kind: 'json',
    status: 200,
    token_payload: tokenPayload,
    prompt,
    response_envelope: responseEnvelope,
    body: {
      id: `chatcmpl-luckrig-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'luckrig-proxy',
      choices: [{ index: 0, message: { role: 'assistant', content: encryptedResponseText }, finish_reason: 'stop' }],
    },
  };
}

export async function handleProxyRequest(req, res, options = {}) {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        node_id: options.nodeId ?? NODE_ID,
        engine: { name: 'luckrig-proxy', version: '0.0.0', backend: options.upstreamUrl || UPSTREAM_URL ? 'openai-compatible' : 'mock' },
        crypto_modes: ['public-key', 'session-secret'],
        queue: { depth: 0, active: 0 },
        error_rate: 0,
      });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const body = await readJsonBody(req);
      const result = await processChatCompletion({
        body,
        authHeader: req.headers.authorization,
        ...options,
      });
      if (result.kind === 'sse') {
        res.writeHead(result.status, corsHeaders({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        }));
        for (const chunk of result.chunks) res.write(chunk);
        res.end();
      } else {
        json(res, result.status, result.body);
      }
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, error?.statusCode ?? 500, { error: String(error?.message ?? error) });
  }
}

export function createProxyServer(options = {}) {
  return http.createServer((req, res) => handleProxyRequest(req, res, options));
}

export function startProxyServer(options = {}) {
  const server = createProxyServer(options);
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  server.listen(port, host, () => {
    console.log(`[proxy] listening on http://${host}:${port}`);
    console.log(`[proxy] node_id=${options.nodeId ?? NODE_ID}`);
  });
  return server;
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntrypoint) startProxyServer();

export { createMockUpstreamServer };
