import http from 'node:http';
import { createServer as createMockUpstreamServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { bearerToken, verifyTastingToken } from '../shared/token.js';
import { decryptJsonFromSubtext, encryptJsonToSubtext, hasSubtext } from '../subtext/index.js';

const HOST = process.env.LUCKRIG_PROXY_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.LUCKRIG_PROXY_PORT ?? '8788', 10);
const NODE_ID = process.env.LUCKRIG_NODE_ID ?? 'local-poc-node';
const TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-dev-secret-change-me';
const UPSTREAM_URL = process.env.LUCKRIG_UPSTREAM_URL ?? '';

function json(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
  for (const message of messages) {
    if (typeof message?.content === 'string' && hasSubtext(message.content)) return message.content;
  }
  throw Object.assign(new Error('encrypted subtext prompt not found in messages[].content'), { statusCode: 400 });
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

  const upstreamBody = {
    ...body,
    stream: false,
    messages: [
      ...(Array.isArray(body.messages) ? body.messages.filter((m) => !hasSubtext(m?.content)) : []),
      { role: 'user', content: prompt.prompt ?? JSON.stringify(prompt) },
    ],
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
} = {}) {
  const token = bearerToken(authHeader);
  if (!token) throw Object.assign(new Error('missing bearer token'), { statusCode: 401 });
  const tokenPayload = verifyTastingToken(token, { secret: trackerSecret, expectedNodeId: nodeId, nowMs });

  const encryptedPromptText = extractSubtextMessage(body);
  const prompt = decryptJsonFromSubtext(encryptedPromptText, { sessionSecret: tokenPayload.session_secret });

  const queuedAt = performance.now();
  // POC queue UX: buffer upstream response fully, then emit pseudo SSE in one pass.
  const generationStartedAt = performance.now();
  const upstream = await callUpstream({ body, prompt, upstreamUrl, fetchImpl });
  const generationSec = (performance.now() - generationStartedAt) / 1000;
  const queueWaitSec = (generationStartedAt - queuedAt) / 1000;

  const responseEnvelope = {
    schema_version: 1,
    node_id: nodeId,
    prompt,
    response: upstream.text,
    queue_wait_sec: Number(queueWaitSec.toFixed(3)),
    generation_sec: Number(generationSec.toFixed(3)),
    upstream: upstream.upstream,
  };
  const encryptedResponseText = encryptJsonToSubtext(responseEnvelope, {
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
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        node_id: options.nodeId ?? NODE_ID,
        engine: { name: 'luckrig-proxy', version: '0.0.0', backend: options.upstreamUrl || UPSTREAM_URL ? 'openai-compatible' : 'mock' },
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
        res.writeHead(result.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
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
