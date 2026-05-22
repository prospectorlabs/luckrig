import http from 'node:http';
import { createServer as createMockUpstreamServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
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
const MODERATION_FLAGS_PATH = process.env.LUCKRIG_MODERATION_FLAGS_PATH
  ?? path.resolve(process.cwd(), 'data/moderation-flags.jsonl');
// Output moderation modes:
//   'record' (default) — non-blocking. The proxy emits the upstream stream as
//                        it arrives (true SSE in plain mode) and runs the
//                        moderation classifier afterwards, then records the
//                        outcome in data/moderation-flags.jsonl. Flagged
//                        output is still delivered to the requesting user
//                        once, but the operator gets evidence for ban review.
//   'block'            — fail-closed. The proxy fully buffers, then runs
//                        moderation, then returns 451 if flagged. Loses real
//                        SSE in plain mode; choose this when policy
//                        compliance must be enforced before the user sees
//                        any output.
//   'off' / '0'        — skip output moderation entirely.
const MODERATE_OUTPUT_MODE = normalizeOutputModerationMode(process.env.LUCKRIG_MODERATE_OUTPUT);

function normalizeOutputModerationMode(value) {
  const s = String(value ?? '').toLowerCase();
  if (s === 'block') return 'block';
  if (s === '0' || s === 'off' || s === 'disabled' || s === 'false') return 'off';
  // boolean true / 'true' / '1' / unset / 'record' / anything else: default to record.
  return 'record';
}

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
  // Note: this is total request time, not true TTFT. Pre-stream upstream
  // does not expose a separate first-byte signal. True per-token TTFT is
  // measured only on the streaming path (streamUpstream).
  const upstreamTtftMs = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const responseBody = await res.json();
  return {
    text: completionTextFromUpstreamResponse(responseBody),
    upstream: upstreamUrl,
    upstream_ttft_ms: upstreamTtftMs,
    upstream_ttft_is_true_first_byte: false,
  };
}

// Real streaming pass-through for plain mode. Yields { kind: 'delta', text }
// for each upstream content delta, and returns final summary via the iterator
// return value. The caller is expected to assemble the full text from the
// deltas and to record the timing markers exposed via the shared `progress`
// object (we populate `progress.first_byte_at` on the first delta).
async function* streamUpstream({
  body,
  prompt,
  upstreamUrl = UPSTREAM_URL,
  fetchImpl = fetch,
  progress = {},
}) {
  const promptText = typeof prompt?.prompt === 'string' ? prompt.prompt : JSON.stringify(prompt);
  if (!upstreamUrl) {
    // Mock streaming: split the mock text into pieces and yield them with a
    // microtask in between so the consumer's chunk_timestamps differ. This
    // lets the e2e suite and the browser POC exercise the real-streaming
    // path without a live llama.cpp upstream.
    const text = `mock:${promptText}`;
    const pieces = splitForRealSse(text, { maxPieces: 16, minPieceChars: 1 });
    let first = true;
    for (const piece of pieces) {
      // Yield to the event loop so server.write() actually flushes to the
      // client between chunks.
      await new Promise((resolve) => setImmediate(resolve));
      if (first) {
        progress.first_byte_at = performance.now();
        first = false;
      }
      yield { kind: 'delta', text: piece };
    }
    return { upstream: 'mock' };
  }

  const upstreamBody = {
    model: body?.model,
    stream: true,
    messages: [{ role: 'user', content: promptText }],
  };

  const res = await fetchImpl(upstreamUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(upstreamBody),
  });
  if (!res.ok) {
    throw new Error(`upstream HTTP ${res.status}`);
  }
  if (!res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
    // Some fetch shims don't expose a stream body. Fall back to buffered
    // parsing of the response text.
    const responseText = await res.text();
    progress.first_byte_at = performance.now();
    for (const piece of splitForRealSse(completionTextFromSseTranscript(responseText), { maxPieces: 16, minPieceChars: 1 })) {
      yield { kind: 'delta', text: piece };
    }
    return { upstream: upstreamUrl };
  }

  let buffer = '';
  for await (const chunk of res.body) {
    if (progress.first_byte_at === null || progress.first_byte_at === undefined) {
      progress.first_byte_at = performance.now();
    }
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let sepIdx;
    while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice('data: '.length).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield { kind: 'delta', text: delta };
        }
      }
    }
  }
  return { upstream: upstreamUrl };
}

function completionTextFromSseTranscript(transcript) {
  // Salvage helper for non-streaming fallback: extract concatenated content
  // deltas from a buffered SSE transcript string.
  let out = '';
  for (const line of String(transcript).split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice('data: '.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') out += delta;
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

async function appendModerationFlag(record, { flagsPath = MODERATION_FLAGS_PATH } = {}) {
  try {
    await mkdir(path.dirname(flagsPath), { recursive: true });
    await appendFile(flagsPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.error('[proxy] failed to append moderation flag', error);
  }
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
  moderateOutput = MODERATE_OUTPUT_MODE,
  moderationFetchImpl = null,
  moderationFlagsPath = MODERATION_FLAGS_PATH,
} = {}) {
  const outputModerationMode = normalizeOutputModerationMode(moderateOutput);
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

  const moderationCommon = {
    endpoint: moderationEndpoint,
    authToken: moderationAuth,
    model: moderationModel,
    fetchImpl: moderationFetchImpl ?? fetchImpl,
    timeoutMs: moderationTimeoutMs,
  };

  // -------- streaming plain mode (B): real upstream SSE pass-through --------
  //
  // The reviewer's correct observation: when output moderation has to run
  // before any byte is emitted to the user (block mode), we MUST buffer, and
  // plain-mode "real SSE" is a lie. The streaming path below runs only when
  // the user asked for plain mode + stream:true AND output moderation is not
  // in block mode. In that case we:
  //   1) pass upstream chunks through to the user as they arrive (true SSE,
  //      client-side chunk_timestamps reflect real generation),
  //   2) accumulate the full text for post-hoc moderation,
  //   3) after the stream completes, call the moderation endpoint and append
  //      the result to data/moderation-flags.jsonl for the operator to act
  //      on (manual ban). The user already saw the response once; the
  //      operator's ban window prevents repetition.
  if (cryptoMode === 'plain' && body?.stream === true && outputModerationMode !== 'block') {
    return startStreamedPlainCompletion({
      body,
      prompt,
      tokenPayload,
      promptPolicy,
      inputModeration,
      nodeId,
      cryptoMode,
      upstreamUrl,
      fetchImpl,
      moderationCommon,
      outputModerationMode,
      moderationFlagsPath,
    });
  }

  // -------- buffered path (subtext, non-stream plain, block-moderation plain) --------
  const queuedAt = performance.now();
  await acquireQueueSlot();
  // Queue UX: wait for the node's available generation slot, then buffer the
  // full upstream response before further processing (required for subtext
  // wrapping and for block-mode output moderation).
  const generationStartedAt = performance.now();
  let upstream;
  try {
    upstream = await callUpstream({ body, prompt, upstreamUrl, fetchImpl });
  } finally {
    releaseQueueSlot();
  }
  const tiered = applyTierPolicy(upstream.text, tokenPayload);

  const outputModeration = await runOutputModerationForBuffered({
    text: tiered.text,
    mode: outputModerationMode,
    moderationCommon,
    nodeId,
    cryptoMode,
    moderationFlagsPath,
  });

  const generationSec = (performance.now() - generationStartedAt) / 1000;
  const queueWaitSec = (generationStartedAt - queuedAt) / 1000;

  const responseEnvelope = {
    schema_version: 1,
    node_id: nodeId,
    prompt,
    prompt_policy: promptPolicy,
    moderation: {
      input: { checked: !inputModeration.skipped, flagged: inputModeration.flagged, categories: inputModeration.categories },
      output: {
        checked: !outputModeration.skipped,
        flagged: outputModeration.flagged,
        categories: outputModeration.categories,
        mode: outputModerationMode,
      },
    },
    response: tiered.text,
    model_name: body?.model ?? '',
    limited_output_truncated: tiered.limited,
    queue_wait_sec: Number(queueWaitSec.toFixed(3)),
    generation_sec: Number(generationSec.toFixed(3)),
    proxy_ttft_ms: upstream.upstream_ttft_ms ?? null,
    proxy_ttft_is_true_first_byte: upstream.upstream_ttft_is_true_first_byte === true,
    streamed: false,
    crypto_mode: cryptoMode,
    queue_snapshot: queueSnapshot(),
    upstream: upstream.upstream,
  };

  if (cryptoMode === 'plain') {
    const timing = plainTimingFromEnvelope(responseEnvelope, tiered.limited);
    if (body?.stream) {
      // Buffered plain SSE only happens when block-mode output moderation is
      // enabled. We pass tiered.text through buildPlainSseChunks which fakes
      // multiple chunks for client-side parsing, but this is NOT real
      // streaming and chunk_timestamps must not be treated as authoritative
      // generation timing. proxy_ttft_ms (request round-trip) is used.
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

function plainTimingFromEnvelope(envelope, limited) {
  return {
    node_id: envelope.node_id,
    crypto_mode: envelope.crypto_mode,
    streamed: envelope.streamed === true,
    queue_wait_sec: envelope.queue_wait_sec,
    generation_sec: envelope.generation_sec,
    proxy_ttft_ms: envelope.proxy_ttft_ms,
    proxy_ttft_is_true_first_byte: envelope.proxy_ttft_is_true_first_byte === true,
    limited_output_truncated: limited === true,
    moderation: envelope.moderation?.output ?? null,
  };
}

async function runOutputModerationForBuffered({
  text,
  mode,
  moderationCommon,
  nodeId,
  cryptoMode,
  moderationFlagsPath,
}) {
  if (mode === 'off' || !moderationCommon.endpoint) {
    return { skipped: true, flagged: false, categories: [] };
  }
  const outcome = await runModeration({ text, ...moderationCommon });
  if (outcome.flagged && mode === 'record') {
    await appendModerationFlag({
      schema_version: 1,
      stage: 'output',
      node_id: nodeId,
      crypto_mode: cryptoMode,
      streamed: false,
      categories: outcome.categories,
      hard_fail: outcome.hard_fail === true,
      reason: outcome.reason ?? null,
      at: new Date().toISOString(),
    }, { flagsPath: moderationFlagsPath });
    // record mode: do NOT throw. The classifier outcome is surfaced inside
    // the response envelope and persisted to moderation-flags.jsonl so the
    // operator can ban the node / user after the fact.
    return outcome;
  }
  if (outcome.flagged && mode === 'block') {
    throw moderationError({
      stage: 'output',
      categories: outcome.categories,
      reason: outcome.reason,
    });
  }
  return outcome;
}

function startStreamedPlainCompletion({
  body,
  prompt,
  tokenPayload,
  promptPolicy,
  inputModeration,
  nodeId,
  cryptoMode,
  upstreamUrl,
  fetchImpl,
  moderationCommon,
  outputModerationMode,
  moderationFlagsPath,
}) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-luckrig-${created}`;
  const model = body?.model ?? 'luckrig-proxy';

  // Limited tier in streaming mode: stop yielding deltas after `limit` chars
  // and append the truncation footer instead of buffering then truncating.
  const limit = tokenPayload?.tier === 'limited'
    ? Number.parseInt(process.env.LUCKRIG_LIMITED_OUTPUT_CHARS ?? '240', 10)
    : null;

  // The response_envelope object is shared with the caller. The async
  // generator below fills in time-dependent fields as the stream completes.
  const responseEnvelope = {
    schema_version: 1,
    node_id: nodeId,
    prompt,
    prompt_policy: promptPolicy,
    moderation: {
      input: { checked: !inputModeration.skipped, flagged: inputModeration.flagged, categories: inputModeration.categories },
      output: { checked: false, flagged: false, categories: [], mode: outputModerationMode },
    },
    response: '',
    model_name: body?.model ?? '',
    limited_output_truncated: false,
    queue_wait_sec: 0,
    generation_sec: 0,
    proxy_ttft_ms: null,
    proxy_ttft_is_true_first_byte: true,
    streamed: true,
    crypto_mode: cryptoMode,
    queue_snapshot: queueSnapshot(),
    upstream: upstreamUrl || 'mock',
  };

  async function* chunks() {
    yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`;

    const queuedAt = performance.now();
    await acquireQueueSlot();
    const generationStartedAt = performance.now();
    const progress = { first_byte_at: null };
    let assembled = '';
    let truncated = false;
    try {
      for await (const event of streamUpstream({ body, prompt, upstreamUrl, fetchImpl, progress })) {
        if (!event || event.kind !== 'delta') continue;
        let piece = event.text;
        if (typeof piece !== 'string' || piece.length === 0) continue;
        if (limit !== null && assembled.length + piece.length > limit) {
          // Trim this delta so the assembled output exactly hits the limit,
          // then stop forwarding further upstream tokens.
          const allowed = Math.max(0, limit - assembled.length);
          piece = piece.slice(0, allowed);
          truncated = true;
        }
        if (piece.length > 0) {
          assembled += piece;
          yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`;
        }
        if (truncated) break;
      }
    } finally {
      releaseQueueSlot();
    }

    if (truncated) {
      const footer = `\n\n[limited tasting output truncated]`;
      assembled += footer;
      yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: footer }, finish_reason: null }] })}\n\n`;
    }

    // Post-hoc output moderation. Runs after the user has already received
    // the stream; persisted to moderation-flags.jsonl so the operator has a
    // ban target. In 'off' mode we skip entirely.
    let outputModeration = { skipped: true, flagged: false, categories: [] };
    if (outputModerationMode !== 'off' && moderationCommon.endpoint) {
      outputModeration = await runModeration({ text: assembled, ...moderationCommon });
      if (outputModeration.flagged) {
        await appendModerationFlag({
          schema_version: 1,
          stage: 'output',
          node_id: nodeId,
          crypto_mode: cryptoMode,
          streamed: true,
          categories: outputModeration.categories,
          hard_fail: outputModeration.hard_fail === true,
          reason: outputModeration.reason ?? null,
          at: new Date().toISOString(),
        }, { flagsPath: moderationFlagsPath });
      }
    }

    const generationSec = (performance.now() - generationStartedAt) / 1000;
    const queueWaitSec = (generationStartedAt - queuedAt) / 1000;
    const proxyTtftMs = progress.first_byte_at !== null
      ? Math.round(progress.first_byte_at - generationStartedAt)
      : null;

    responseEnvelope.response = assembled;
    responseEnvelope.limited_output_truncated = truncated;
    responseEnvelope.queue_wait_sec = Number(queueWaitSec.toFixed(3));
    responseEnvelope.generation_sec = Number(generationSec.toFixed(3));
    responseEnvelope.proxy_ttft_ms = proxyTtftMs;
    responseEnvelope.moderation.output = {
      checked: !outputModeration.skipped,
      flagged: outputModeration.flagged,
      categories: outputModeration.categories,
      mode: outputModerationMode,
    };
    responseEnvelope.queue_snapshot = queueSnapshot();

    yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }] })}\n\n`;
    yield `data: ${JSON.stringify({ id, object: 'luckrig.timing', created, ...plainTimingFromEnvelope(responseEnvelope, truncated) })}\n\n`;
    yield 'data: [DONE]\n\n';
  }

  return {
    kind: 'plain-sse-stream',
    status: 200,
    token_payload: tokenPayload,
    prompt,
    response_envelope: responseEnvelope,
    chunks: chunks(),
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
      if (result.kind === 'sse' || result.kind === 'plain-sse' || result.kind === 'plain-sse-stream') {
        res.writeHead(result.status, corsHeaders({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        }));
        if (Array.isArray(result.chunks)) {
          for (const chunk of result.chunks) res.write(chunk);
        } else {
          for await (const chunk of result.chunks) res.write(chunk);
        }
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
