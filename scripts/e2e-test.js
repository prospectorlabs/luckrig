import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.LUCKRIG_TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-e2e-secret';
process.env.LUCKRIG_METRICS_PATH = process.env.LUCKRIG_METRICS_PATH ?? `/tmp/luckrig-e2e-metrics-${process.pid}.jsonl`;
process.env.LUCKRIG_TOKEN_USAGE_PATH = process.env.LUCKRIG_TOKEN_USAGE_PATH ?? `/tmp/luckrig-e2e-token-usage-${process.pid}.jsonl`;
process.env.LUCKRIG_DB_PATH = process.env.LUCKRIG_DB_PATH ?? `/tmp/luckrig-e2e-${process.pid}.sqlite`;
process.env.LUCKRIG_HEALTH_TIMEOUT_MS = process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '200';

const tracker = await import('../src/tracker/server.js');
const { processChatCompletion } = await import('../src/proxy/server.js');
const { buildEncryptedChatBody, replayFromProxyResult } = await import('../src/client/tasting.js');
const { loadReplayRecord, saveReplayRecord } = await import('../src/client/replay.js');
const {
  decryptJsonFromSubtext,
  decryptJsonFromSubtextWithPrivateKey,
  encryptJsonToSubtext,
  encryptJsonToSubtextForPublicKey,
  hasSubtext,
} = await import('../src/subtext/index.js');
const { verifyTastingToken } = await import('../src/shared/token.js');
const { generateBoxKeyPair, publicKeyFingerprint } = await import('../src/shared/keyhandshake.js');
const { buildRegisterRequest } = await import('../src/cli/luckrig.js');

function makeReq({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
  const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0);
  const req = Readable.from(payload.length ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'luckrig.test', ...headers };
  return req;
}

function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = headers;
    return res;
  };
  const done = new Promise((resolve) => {
    const originalEnd = res.end.bind(res);
    res.end = (chunk, enc, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
      originalEnd(null, null, cb);
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      });
      return res;
    };
  });
  return { res, done };
}

async function requestTracker(input) {
  const req = makeReq(input);
  const { res, done } = makeRes();
  await tracker.handleRequest(req, res);
  const response = await done;
  return {
    ...response,
    json: response.text ? JSON.parse(response.text) : null,
  };
}

async function main() {
  await rm(process.env.LUCKRIG_METRICS_PATH, { force: true });
  await rm(process.env.LUCKRIG_TOKEN_USAGE_PATH, { force: true });
  await rm(process.env.LUCKRIG_DB_PATH, { force: true });
  await rm(process.env.LUCKRIG_DB_PATH, { force: true });
  await tracker.loadRegistry();
  await tracker.loadMetrics();
  await tracker.loadTokenUsage();
  await tracker.probeAllNodes();

  const nodesResponse = await requestTracker({ method: 'GET', url: '/api/nodes' });
  assert.equal(nodesResponse.statusCode, 200);
  assert.equal(nodesResponse.json.schema_version, 1);
  assert.ok(nodesResponse.json.nodes.length >= 3);
  const node = nodesResponse.json.nodes[0];
  assert.ok(node.observations.samples_count >= 1);

  const nodeKeys = generateBoxKeyPair();
  const userKeys = generateBoxKeyPair();

  const tokenResponse = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: {
      node_id: node.id,
      user_id: 'contributor-e2e',
      contribution_score: 1,
      ttl_sec: 60,
      user_public_key: userKeys.publicKeyPem,
      node_public_key: nodeKeys.publicKeyPem,
    },
  });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.text);
  assert.equal(tokenResponse.json.schema_version, 1);
  assert.equal(tokenResponse.json.contribution.tier, 'contributor');
  assert.equal(tokenResponse.json.crypto_mode, 'public-key');
  assert.equal(tokenResponse.json.session_secret, null);
  assert.equal(tokenResponse.json.node_public_key.trim(), nodeKeys.publicKeyPem.trim());
  assert.equal(tokenResponse.json.node_public_key_fingerprint, publicKeyFingerprint(nodeKeys.publicKeyPem));
  assert.equal(tokenResponse.json.user_public_key_fingerprint, publicKeyFingerprint(userKeys.publicKeyPem));

  const tokenPayload = verifyTastingToken(tokenResponse.json.token, {
    secret: process.env.LUCKRIG_TRACKER_SECRET,
    expectedNodeId: node.id,
  });
  assert.equal(tokenPayload.user_id, 'contributor-e2e');
  assert.equal(tokenPayload.crypto_mode, 'public-key');
  assert.equal(tokenPayload.user_public_key.trim(), userKeys.publicKeyPem.trim());
  assert.equal(tokenPayload.user_public_key_fingerprint, publicKeyFingerprint(userKeys.publicKeyPem));

  const cliDryRun = buildRegisterRequest({
    endpointUrl: 'http://127.0.0.1:8788/v1',
    modelName: 'e2e-model',
    quantization: 'Q4_K_M',
    gpu: 'E2E_GPU',
    nodePublicKey: nodeKeys.publicKeyPem,
  });
  assert.equal(cliDryRun.method, 'POST');
  assert.equal(cliDryRun.body.model_name, 'e2e-model');
  assert.equal(cliDryRun.body.node_public_key, nodeKeys.publicKeyPem);

  const prompt = 'hello from luckrig e2e';
  const body = buildEncryptedChatBody({ prompt, nodePublicKey: tokenResponse.json.node_public_key, stream: true });
  assert.equal(hasSubtext(body.messages[0].content), true);
  assert.equal(decryptJsonFromSubtextWithPrivateKey(body.messages[0].content, { privateKey: nodeKeys.privateKeyPem }).prompt, prompt);

  const proxyResult = await processChatCompletion({
    body,
    authHeader: `Bearer ${tokenResponse.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
    nodePrivateKey: nodeKeys.privateKeyPem,
  });
  assert.equal(proxyResult.kind, 'sse');
  assert.ok(proxyResult.chunks.join('').includes('[DONE]'));

  const replay = replayFromProxyResult(proxyResult, { userPrivateKey: userKeys.privateKeyPem, ttft_ms: 0 });
  assert.equal(replay.schema_version, 1);
  assert.equal(replay.prompt, prompt);
  assert.equal(replay.response, `mock:${prompt}`);
  assert.equal(replay.node_id, node.id);
  assert.ok(replay.tok_per_sec === null || replay.tok_per_sec >= 0);
  assert.ok(replay.output_tokens > 0);
  assert.equal(replay.tokenizer, 'luckrig-heuristic-v1');
  assert.equal(typeof replay.proxy_ttft_ms, 'number');
  assert.ok(proxyResult.response_envelope.queue_snapshot);

  const historyDir = await mkdtemp(path.join(os.tmpdir(), 'luckrig-e2e-history-'));
  const replayPath = await saveReplayRecord(replay, { historyDir, date: new Date('2026-05-22T07:00:00.000Z') });
  const loadedReplay = await loadReplayRecord(replayPath);
  assert.deepEqual(loadedReplay, replay);

  const encrypted = encryptJsonToSubtextForPublicKey({ ok: true }, { publicKey: userKeys.publicKeyPem });
  assert.deepEqual(decryptJsonFromSubtextWithPrivateKey(encrypted, { privateKey: userKeys.privateKeyPem }), { ok: true });

  const legacyEncrypted = encryptJsonToSubtext({ ok: true }, { sessionSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.deepEqual(decryptJsonFromSubtext(legacyEncrypted, { sessionSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), { ok: true });

  const limitedTokenResponse = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'limited-e2e', contribution_score: 0, ttl_sec: 60 },
  });
  assert.equal(limitedTokenResponse.statusCode, 201, limitedTokenResponse.text);
  assert.equal(limitedTokenResponse.json.contribution.tier, 'limited');
  assert.equal(limitedTokenResponse.json.crypto_mode, 'session-secret');
  const limitedPrompt = 'x'.repeat(1200);
  const limitedBody = buildEncryptedChatBody({ prompt: limitedPrompt, sessionSecret: limitedTokenResponse.json.session_secret, stream: true });
  const limitedProxyResult = await processChatCompletion({
    body: limitedBody,
    authHeader: `Bearer ${limitedTokenResponse.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
  });
  const limitedReplay = replayFromProxyResult(limitedProxyResult, { sessionSecret: limitedTokenResponse.json.session_secret, ttft_ms: 0 });
  assert.equal(limitedReplay.limited_output_truncated, true);
  assert.ok(limitedReplay.output_tokens > 0);
  assert.match(limitedReplay.response, /limited tasting output truncated/);

  const blockedPromptBody = buildEncryptedChatBody({ prompt: 'NSFW erotic content test', sessionSecret: limitedTokenResponse.json.session_secret, stream: true });
  await assert.rejects(
    () => processChatCompletion({
      body: blockedPromptBody,
      authHeader: `Bearer ${limitedTokenResponse.json.token}`,
      nodeId: node.id,
      trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
    }),
    /NSFW\/explicit sexual content/,
  );

  for (let i = 0; i < 5; i += 1) {
    const quotaRes = await requestTracker({
      method: 'POST',
      url: '/api/tokens',
      headers: { 'content-type': 'application/json' },
      body: { node_id: node.id, user_id: 'quota-e2e', contribution_score: 0, ttl_sec: 60 },
    });
    assert.equal(quotaRes.statusCode, 201, quotaRes.text);
  }
  const quotaExceeded = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'quota-e2e', contribution_score: 0, ttl_sec: 60 },
  });
  assert.equal(quotaExceeded.statusCode, 429, quotaExceeded.text);
  assert.match(quotaExceeded.json.error, /limited token quota exceeded/);

  await assert.rejects(
    () => processChatCompletion({ body, authHeader: 'Bearer broken', nodeId: node.id, trackerSecret: process.env.LUCKRIG_TRACKER_SECRET, nodePrivateKey: nodeKeys.privateKeyPem }),
    /invalid token format|invalid token signature/,
  );

  await rm(historyDir, { recursive: true, force: true });
  await rm(process.env.LUCKRIG_METRICS_PATH, { force: true });
  await rm(process.env.LUCKRIG_TOKEN_USAGE_PATH, { force: true });

  const delayedFetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'queued upstream response' } }] };
      },
    };
  };
  const queuedBodyA = buildEncryptedChatBody({ prompt: 'queue-a', nodePublicKey: tokenResponse.json.node_public_key, stream: true });
  const queuedBodyB = buildEncryptedChatBody({ prompt: 'queue-b', nodePublicKey: tokenResponse.json.node_public_key, stream: true });
  const [queuedA, queuedB] = await Promise.all([
    processChatCompletion({ body: queuedBodyA, authHeader: `Bearer ${tokenResponse.json.token}`, nodeId: node.id, trackerSecret: process.env.LUCKRIG_TRACKER_SECRET, nodePrivateKey: nodeKeys.privateKeyPem, upstreamUrl: 'http://upstream.test/v1', fetchImpl: delayedFetch }),
    processChatCompletion({ body: queuedBodyB, authHeader: `Bearer ${tokenResponse.json.token}`, nodeId: node.id, trackerSecret: process.env.LUCKRIG_TRACKER_SECRET, nodePrivateKey: nodeKeys.privateKeyPem, upstreamUrl: 'http://upstream.test/v1', fetchImpl: delayedFetch }),
  ]);
  assert.equal(queuedA.kind, 'sse');
  assert.equal(queuedB.kind, 'sse');
  assert.equal(Math.max(queuedA.response_envelope.queue_wait_sec, queuedB.response_envelope.queue_wait_sec) > 0, true);
  assert.equal(queuedA.response_envelope.proxy_ttft_ms >= 0, true);

  // Plaintext-only messages must be rejected even when no subtext payload is present (CONCEPT trust model).
  await assert.rejects(
    () => processChatCompletion({
      body: { model: 'plaintext-poc', stream: true, messages: [{ role: 'user', content: 'plain hello' }] },
      authHeader: `Bearer ${tokenResponse.json.token}`,
      nodeId: node.id,
      trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
      nodePrivateKey: nodeKeys.privateKeyPem,
    }),
    /plaintext content is not allowed/,
  );

  // Mixed plaintext + subtext must also be rejected, so accidental history leaks cannot bypass the proxy.
  const mixedBody = buildEncryptedChatBody({ prompt: 'hi', nodePublicKey: tokenResponse.json.node_public_key, stream: true });
  mixedBody.messages.unshift({ role: 'system', content: 'leak this system prompt' });
  await assert.rejects(
    () => processChatCompletion({
      body: mixedBody,
      authHeader: `Bearer ${tokenResponse.json.token}`,
      nodeId: node.id,
      trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
      nodePrivateKey: nodeKeys.privateKeyPem,
    }),
    /only role="user" is allowed/,
  );

  // Token-usage map purge: stale day keys must be removed by pruneTokenUsageMap.
  tracker.tokenUsageDaily.set('1970-01-01::limited::old-user', 9);
  const removed = tracker.pruneTokenUsageMap({ now: new Date('2026-05-22T00:00:00.000Z') });
  assert.equal(removed >= 1, true);
  assert.equal(tracker.tokenUsageDaily.has('1970-01-01::limited::old-user'), false);

  console.log('[e2e] ok');
  console.log(`[e2e] node=${node.id}`);
  console.log(`[e2e] replay=${replayPath}`);
}

main().catch((error) => {
  console.error('[e2e] failed', error);
  process.exitCode = 1;
});
