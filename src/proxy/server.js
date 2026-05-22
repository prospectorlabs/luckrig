import http from 'node:http';
import { createServer as createMockUpstreamServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertPromptAllowed } from '../shared/filter.js';
import { runModeration, moderationError } from '../shared/moderation.js';
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
const MAX_ACTIVE_REQUESTS = Math.max(1, Number.parseInt(process.env.LUCKRIG_MAX_ACTIVE_REQUESTS ?? '1', 10));
const MODERATION_ENDPOINT = process.env.LUCKRIG_MODERATION_ENDPOINT ?? '';
const MODERATION_AUTH = process.env.LUCKRIG_MODERATION_AUTH ?? '';
const MODERATION_MODEL = process.env.LUCKRIG_MODERATION_MODEL ?? 'omni-moderation-latest';
const MODERATION_TIMEOUT_MS = Math.max(500, Number.parseInt(process.env.LUCKRIG_MODERATION_TIMEOUT_MS ?? '5000', 10));
const MODERATE_OUTPUT = process.env.LUCKRIG_MODERATE_OUTPUT !== '0';

const queueState = { active: 0, waiting: 0, max_active: MAX_ACTIVE_REQUESTS };
const queueWaiters = [];

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

function extractPlainPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    throw Object.assign(new Error('messages[] is empty'), { statusCode: 400 });
  }
  let firstUserContent = null;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      throw Object.assign(new Error('every message must be an object'), { statusCode: 400 });
    }
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    if (role !== 'user') {
      // Reject system/assistant messages to keep this POC minimal and to avoid
      // ambiguity about whose role is being injected.
      throw Object.assign(new Error(`only role="user" is allowed via luckrig proxy; got role="${message.role ?? ''}"`), { statusCode: 400 });
    }
    if (firstUserContent === null) {
      firstUserContent = typeof message.content === 'string' ? message.content : '';
    }
  }
  if (firstUserContent === null || firstUserContent.length === 0) {
    throw Object.assign(new Error('plain mode requires non-empty user prompt content'), { statusCode: 400 });
  }
  return firstUserContent;
}


function queueSnapshot() {
  return { ...queueState, depth: queueState.waiting };
}

async function acquireQueueSlot() {
  if (queueState.active < queueState.max_active) {
    queueState.active += 1;
    return;
  }
  queueState.waiting += 1;
  await new Promise((resolve) => queueWaiters.push(resolve));
  queueState.waiting -= 1;
  // The releasing request transfers its active slot directly to this waiter.
}

function releaseQueueSlot() {
  const next = queueWaiters.shift();
  if (next) {
    queueMicrotask(next);
    return;
  }
  queueState.active = Math.max(0, queueState.active - 1);
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
    upstream_ttft_ms: 0,
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

  const started = performance.now();
  const res = await fetchImpl(upstreamUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamBody),
  });
  const upstreamTtftMs = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const responseBody = await res.json();
  return {
    text: completionTextFromUpstreamResponse(responseBody),
    upstream: upstreamUrl,
    upstream_ttft_ms: upstreamTtftMs,
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

function splitForRealSse(text, { maxPieces = 32, minPieceChars = 2 } = {}) {
  const str = String(text ?? '');
  if (str.length === 0) return [];
  // Split on whitespace boundaries to approximate token-like chunks, then pack
  // into pieces of at least `minPieceChars` chars (avoid emitting hundreds of
  // single-char chunks for short responses while still letting the client
  // measure tok/s from arrival deltas).
  const parts = str.split(/(\s+)/).filter((s) => s.length > 0);
  const pieces = [];
  let buf = '';
  for (const part of parts) {
    buf += part;
    if (buf.length >= minPieceChars) {
      pieces.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) pieces.push(buf);
  if (pieces.length <= maxPieces) return pieces;
  // If we ended up with too many pieces, glue adjacent ones to stay under cap.
  const out = [];
  const groupSize = Math.ceil(pieces.length / maxPieces);
  for (let i = 0; i < pieces.length; i += groupSize) {
    out.push(pieces.slice(i, i + groupSize).join(''));
  }
  return out;
}

function buildPlainSseChunks(responseText, { created = Math.floor(Date.now() / 1000), model = 'luckrig-proxy', timing = {} } = {}) {
  const id = `chatcmpl-luckrig-${created}`;
  const pieces = splitForRealSse(responseText);
  const chunks = [];
  chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  if (pieces.length === 0) {
    chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] })}\n\n`);
  } else {
    for (const piece of pieces) {
      chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
    }
  }
  chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  // Trailing non-OpenAI luckrig metadata frame so the client can pick up
  // proxy-side timing without needing a separate endpoint. Unknown fields are
  // ignored by vanilla OpenAI SSE parsers.
  chunks.push(`data: ${JSON.stringify({ id, object: 'luckrig.timing', created, ...timing })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return chunks;
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
  moderationEndpoint = MODERATION_ENDPOINT,
  moderationAuth = MODERATION_AUTH,
  moderationModel = MODERATION_MODEL,
  moderationTimeoutMs = MODERATION_TIMEOUT_MS,
  moderateOutput = MODERATE_OUTPUT,
  moderationFetchImpl = null,
} = {}) {
  const token = bearerToken(authHeader);
  if (!token) throw Object.assign(new Error('missing bearer token'), { statusCode: 401 });
  const tokenPayload = verifyTastingToken(token, { secret: trackerSecret, expectedNodeId: nodeId, nowMs });

  const cryptoMode = tokenPayload.crypto_mode ?? 'plain';
  let prompt;
  if (cryptoMode === 'plain') {
    // plain mode (baseline): OpenAI-compatible plaintext path. Forward upstream
    // and stream real SSE. No subtext encode/decode.
    const plainText = extractPlainPrompt(body);
    prompt = { prompt: plainText };
  } else if (cryptoMode === 'public-key') {
    const encryptedPromptText = extractSubtextMessage(body);
    prompt = decryptJsonFromSubtextWithPrivateKey(encryptedPromptText, { privateKey: nodePrivateKey });
  } else if (cryptoMode === 'session-secret') {
    const encryptedPromptText = extractSubtextMessage(body);
    prompt = decryptJsonFromSubtext(encryptedPromptText, { sessionSecret: tokenPayload.session_secret });
  } else {
    throw Object.assign(new Error(`unsupported crypto_mode in token: ${cryptoMode}`), { statusCode: 400 });
  }

  const promptPolicy = assertPromptAllowed(prompt);

  // External moderation hook (input). The local regex filter above catches
  // obvious patterns; the moderation endpoint, when configured, catches
  // contextual and adversarial cases. If unreachable the call FAILS CLOSED.
  const promptText = typeof prompt?.prompt === 'string' ? prompt.prompt : JSON.stringify(prompt);
  const inputModeration = await runModeration({
    text: promptText,
    endpoint: moderationEndpoint,
    authToken: moderationAuth,
    model: moderationModel,
    fetchImpl: moderationFetchImpl ?? fetchImpl,
    timeoutMs: moderationTimeoutMs,
  });
  if (inputModeration.flagged) {
    throw moderationError({
      stage: 'input',
      categories: inputModeration.categories,
      reason: inputModeration.reason,
    });
  }

  const queuedAt = performance.now();
  await acquireQueueSlot();
  // Queue UX: wait for the node's available generation slot, then buffer upstream
  // response fully before emitting encrypted pseudo SSE.
  const generationStartedAt = performance.now();
  let upstream;
  try {
    upstream = await callUpstream({ body, prompt, upstreamUrl, fetchImpl });
  } finally {
    releaseQueueSlot();
  }
  const tiered = applyTierPolicy(upstream.text, tokenPayload);

  // External moderation hook (output). Catches model jailbreaks that produce
  // disallowed content even when the input was clean. Optional but on by
  // default; can be disabled with LUCKRIG_MODERATE_OUTPUT=0 for low-latency
  // setups where the operator trusts the model.
  let outputModeration = { skipped: true, flagged: false, categories: [] };
  if (moderateOutput) {
    outputModeration = await runModeration({
      text: tiered.text,
      endpoint: moderationEndpoint,
      authToken: moderationAuth,
      model: moderationModel,
      fetchImpl: moderationFetchImpl ?? fetchImpl,
      timeoutMs: moderationTimeoutMs,
    });
    if (outputModeration.flagged) {
      throw moderationError({
        stage: 'output',
        categories: outputModeration.categories,
        reason: outputModeration.reason,
      });
    }
  }

  const generationSec = (performance.now() - generationStartedAt) / 1000;
  const queueWaitSec = (generationStartedAt - queuedAt) / 1000;

  const responseEnvelope = {
    schema_version: 1,
    node_id: nodeId,
    prompt,
    prompt_policy: promptPolicy,
    moderation: {
      input: { checked: !inputModeration.skipped, flagged: inputModeration.flagged, categories: inputModeration.categories },
      output: { checked: !outputModeration.skipped, flagged: outputModeration.flagged, categories: outputModeration.categories },
    },
    response: tiered.text,
    model_name: body?.model ?? '',
    limited_output_truncated: tiered.limited,
    queue_wait_sec: Number(queueWaitSec.toFixed(3)),
    generation_sec: Number(generationSec.toFixed(3)),
    proxy_ttft_ms: upstream.upstream_ttft_ms ?? null,
    crypto_mode: cryptoMode,
    queue_snapshot: queueSnapshot(),
    upstream: upstream.upstream,
  };

  if (cryptoMode === 'plain') {
    const timing = {
      node_id: nodeId,
      crypto_mode: cryptoMode,
      queue_wait_sec: responseEnvelope.queue_wait_sec,
      generation_sec: responseEnvelope.generation_sec,
      proxy_ttft_ms: responseEnvelope.proxy_ttft_ms,
      limited_output_truncated: tiered.limited,
    };
    if (body?.stream) {
      return {
        kind: 'plain-sse',
        status: 200,
        token_payload: tokenPayload,
        prompt,
        response_envelope: responseEnvelope,
        chunks: buildPlainSseChunks(tiered.text, { model: body.model ?? 'luckrig-proxy', timing }),
      };
    }
    return {
      kind: 'plain-json',
      status: 200,
      token_payload: tokenPayload,
      prompt,
      response_envelope: responseEnvelope,
      body: {
        id: `chatcmpl-luckrig-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'luckrig-proxy',
        choices: [{ index: 0, message: { role: 'assistant', content: tiered.text }, finish_reason: 'stop' }],
        luckrig_timing: timing,
      },
    };
  }

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
        crypto_modes: ['plain', 'public-key', 'session-secret'],
        queue: queueSnapshot(),
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
      if (result.kind === 'sse' || result.kind === 'plain-sse') {
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

export { createMockUpstreamServer, queueSnapshot, acquireQueueSlot, releaseQueueSlot };
