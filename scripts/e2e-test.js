import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.LUCKRIG_TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-e2e-secret';
process.env.LUCKRIG_METRICS_PATH = process.env.LUCKRIG_METRICS_PATH ?? `/tmp/luckrig-e2e-metrics-${process.pid}.jsonl`;
process.env.LUCKRIG_TOKEN_USAGE_PATH = process.env.LUCKRIG_TOKEN_USAGE_PATH ?? `/tmp/luckrig-e2e-token-usage-${process.pid}.jsonl`;
process.env.LUCKRIG_DB_PATH = process.env.LUCKRIG_DB_PATH ?? `/tmp/luckrig-e2e-${process.pid}.sqlite`;
process.env.LUCKRIG_TIMING_PATH = process.env.LUCKRIG_TIMING_PATH ?? `/tmp/luckrig-e2e-timing-${process.pid}.jsonl`;
process.env.LUCKRIG_BANS_PATH = process.env.LUCKRIG_BANS_PATH ?? `/tmp/luckrig-e2e-bans-${process.pid}.jsonl`;
process.env.LUCKRIG_ABUSE_REPORTS_PATH = process.env.LUCKRIG_ABUSE_REPORTS_PATH ?? `/tmp/luckrig-e2e-abuse-${process.pid}.jsonl`;
process.env.LUCKRIG_DEV = process.env.LUCKRIG_DEV ?? '1';
process.env.LUCKRIG_HEALTH_TIMEOUT_MS = process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '200';

const tracker = await import('../src/tracker/server.js');
const { processChatCompletion } = await import('../src/proxy/server.js');
const { buildEncryptedChatBody, replayFromProxyResult } = await import('../src/client/tasting.js');
const { loadReplayRecord, saveReplayRecord } = await import('../src/client/replay.js');
const {
  parsePlainSseChunks,
  replayFromPlainSseChunks,
  timingPayloadFromReplay,
} = await import('../src/client/replay.js');
const { buildPlainChatBody } = await import('../src/client/tasting.js');

async function collectChunks(chunksLike) {
  if (Array.isArray(chunksLike)) return chunksLike.slice();
  const out = [];
  for await (const c of chunksLike) out.push(c);
  return out;
}
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

  const contributionList = await requestTracker({ method: 'GET', url: '/api/contributions' });
  assert.equal(contributionList.statusCode, 200, contributionList.text);
  assert.ok(Array.isArray(contributionList.json.scores));
  assert.ok(contributionList.json.scores.some((score) => score.node_id === node.id));

  const showcaseList = await requestTracker({ method: 'GET', url: '/api/showcase' });
  assert.equal(showcaseList.statusCode, 200, showcaseList.text);
  assert.ok(showcaseList.json.categories.length >= 1);
  assert.ok(showcaseList.json.nodes.length >= 1);

  const fpVerification = await tracker.verifyFingerprintUrl({
    expected: tokenResponse.json.node_public_key_fingerprint,
    url: 'https://fingerprint.example/luckrig.txt',
    fetchImpl: async () => ({ ok: true, async text() { return `node key ${tokenResponse.json.node_public_key_fingerprint}`; } }),
  });
  assert.equal(fpVerification.ok, true);

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
    body: { node_id: node.id, user_id: 'limited-e2e', contribution_score: 0, ttl_sec: 60, crypto_mode: 'session-secret' },
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

  tracker.tokenIpUsageDaily.set(`${new Date().toISOString().slice(0, 10)}::local`, tracker.TOKEN_IP_LIMIT_PER_DAY);
  const ipLimited = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'ip-limit-e2e', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(ipLimited.statusCode, 429, ipLimited.text);
  assert.match(ipLimited.json.error, /IP token rate limit exceeded/);
  tracker.tokenIpUsageDaily.clear();

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

  // ----- plain mode (baseline) E2E -----

  const plainTokenResponse = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'plain-e2e', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(plainTokenResponse.statusCode, 201, plainTokenResponse.text);
  assert.equal(plainTokenResponse.json.crypto_mode, 'plain', 'default mode without keys must be plain');
  assert.equal(plainTokenResponse.json.session_secret, null);
  assert.match(plainTokenResponse.json.caveat, /plain mode/);

  const plainPrompt = 'hello luckrig plain mode';
  const plainBody = buildPlainChatBody({ prompt: plainPrompt, stream: true });
  // Vanilla OpenAI-shaped body: messages[].content is plaintext.
  assert.equal(plainBody.messages[0].content, plainPrompt);
  const plainProxyResult = await processChatCompletion({
    body: plainBody,
    authHeader: `Bearer ${plainTokenResponse.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
  });
  assert.equal(plainProxyResult.kind, 'plain-sse-stream', 'plain mode + stream + record-moderation must use real streaming kind');
  assert.equal(Array.isArray(plainProxyResult.chunks), false, 'plain-sse-stream chunks must be an async iterable');
  const plainCollected = await collectChunks(plainProxyResult.chunks);
  assert.ok(plainCollected.length >= 4, 'plain mode SSE must produce multiple per-token chunks');
  assert.ok(plainCollected.join('').includes('[DONE]'));
  // Plaintext must NOT be subtext-encoded in plain mode.
  assert.equal(hasSubtext(plainCollected.join('')), false);

  const { content: plainContent, timing: plainTiming, chunk_timestamps: plainStamps } = parsePlainSseChunks(plainCollected);
  assert.equal(plainContent, `mock:${plainPrompt}`);
  assert.ok(plainTiming && plainTiming.object === 'luckrig.timing');
  assert.equal(plainTiming.crypto_mode, 'plain');
  assert.equal(plainTiming.streamed, true, 'plain-sse-stream timing must advertise streamed=true');
  assert.ok(plainStamps.length >= 2, 'real streaming must produce multiple distinct chunk_timestamps');
  assert.equal(plainProxyResult.response_envelope.streamed, true);
  assert.equal(plainProxyResult.response_envelope.proxy_ttft_is_true_first_byte, true);
  assert.ok(plainProxyResult.response_envelope.proxy_ttft_ms !== null);

  const plainReplay = replayFromPlainSseChunks(plainCollected, {
    prompt: plainPrompt,
    node_id: node.id,
    model_name: 'luckrig-plain-poc',
    ttft_ms: 7,
  });
  assert.equal(plainReplay.schema_version, 1);
  assert.equal(plainReplay.prompt, plainPrompt);
  assert.equal(plainReplay.response, `mock:${plainPrompt}`);
  assert.ok(plainReplay.output_tokens > 0);

  // ----- opt-in timing upload (CONCEPT §opt-in timing metadata sharing) -----

  const timingPayload = timingPayloadFromReplay(plainReplay, {
    node_id: node.id,
    mode: 'plain',
    user_id: 'plain-e2e',
  });
  // The allowlist must hold: payload only carries timing fields, never prompt/response.
  for (const key of Object.keys(timingPayload)) {
    assert.equal(/(prompt|response|message|chunk_timestamp|content|envelope|body)/i.test(key), false, `timing payload must not include body-like field: ${key}`);
  }

  const timingResp = await requestTracker({
    method: 'POST',
    url: '/api/replay/timing',
    headers: { 'content-type': 'application/json' },
    body: timingPayload,
  });
  assert.equal(timingResp.statusCode, 201, timingResp.text);
  assert.equal(timingResp.json.ok, true);
  assert.equal(timingResp.json.node_id, node.id);
  assert.ok(timingResp.json.community_timing.samples_count >= 1);

  // Disallowed body fields must be rejected.
  const leakyResp = await requestTracker({
    method: 'POST',
    url: '/api/replay/timing',
    headers: { 'content-type': 'application/json' },
    body: { ...timingPayload, prompt: 'should be rejected' },
  });
  assert.equal(leakyResp.statusCode, 400, leakyResp.text);
  assert.match(leakyResp.json.error, /disallowed field/);

  // Unknown fields must also be rejected.
  const unknownResp = await requestTracker({
    method: 'POST',
    url: '/api/replay/timing',
    headers: { 'content-type': 'application/json' },
    body: { ...timingPayload, totally_unknown: 1 },
  });
  assert.equal(unknownResp.statusCode, 400, unknownResp.text);
  assert.match(unknownResp.json.error, /unknown field/);

  // Aggregated tok/s must surface in the public node list now that we have a sample.
  const nodesAfter = await requestTracker({ method: 'GET', url: '/api/nodes' });
  const nodeAfter = nodesAfter.json.nodes.find((n) => n.id === node.id);
  assert.ok(nodeAfter, 'node must be in public list');
  assert.ok(nodeAfter.community_timing, 'public node must expose community_timing');
  assert.equal(nodeAfter.community_timing.samples_count >= 1, true);

  // ----- moderation hook (proxy input + output) -----

  const flaggingFetch = async (url) => {
    if (String(url).includes('/moderation/flag')) {
      return {
        ok: true,
        async json() {
          return { id: 'mock-mod-flag', results: [{ flagged: true, categories: { 'sexual/minors': true } }] };
        },
      };
    }
    return { ok: true, async json() { return { choices: [{ message: { content: 'ok' } }] } } };
  };
  const cleanFetch = async (url) => {
    if (String(url).includes('/moderation/clean')) {
      return {
        ok: true,
        async json() {
          return { id: 'mock-mod-clean', results: [{ flagged: false, categories: {} }] };
        },
      };
    }
    return { ok: true, async json() { return { choices: [{ message: { content: 'ok' } }] } } };
  };
  const unreachableFetch = async () => { throw new Error('ECONNREFUSED'); };

  const modTokenRes = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'mod-e2e', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(modTokenRes.statusCode, 201, modTokenRes.text);
  const modBody = buildPlainChatBody({ prompt: 'innocuous prompt', stream: true });

  // Input flagged → 451
  await assert.rejects(
    () => processChatCompletion({
      body: modBody,
      authHeader: `Bearer ${modTokenRes.json.token}`,
      nodeId: node.id,
      trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
      moderationEndpoint: 'http://mod.test/moderation/flag',
      moderationFetchImpl: flaggingFetch,
      moderateOutput: 'off',
    }),
    (error) => error.statusCode === 451 && /moderation blocked input/.test(error.message),
    'flagged input must throw moderation 451',
  );

  // Unreachable moderation → fail closed (also 451)
  await assert.rejects(
    () => processChatCompletion({
      body: modBody,
      authHeader: `Bearer ${modTokenRes.json.token}`,
      nodeId: node.id,
      trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
      moderationEndpoint: 'http://mod.test/moderation/down',
      moderationFetchImpl: unreachableFetch,
    }),
    (error) => error.statusCode === 451 && /moderation-unreachable/.test(error.message),
    'unreachable moderation must fail closed',
  );

  // Clean moderation in BLOCK mode → buffered plain SSE, output.checked=true, flagged=false
  const cleanBlock = await processChatCompletion({
    body: modBody,
    authHeader: `Bearer ${modTokenRes.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
    moderationEndpoint: 'http://mod.test/moderation/clean',
    moderationFetchImpl: cleanFetch,
    moderateOutput: 'block',
  });
  assert.equal(cleanBlock.kind, 'plain-sse', 'block-mode output moderation forces buffered plain-sse');
  assert.equal(Array.isArray(cleanBlock.chunks), true);
  assert.equal(cleanBlock.response_envelope.moderation.input.checked, true);
  assert.equal(cleanBlock.response_envelope.moderation.input.flagged, false);
  assert.equal(cleanBlock.response_envelope.moderation.output.checked, true);
  assert.equal(cleanBlock.response_envelope.moderation.output.mode, 'block');
  assert.equal(cleanBlock.response_envelope.streamed, false);

  // Clean moderation in RECORD mode (default) → real streaming + post-hoc record
  const cleanRecord = await processChatCompletion({
    body: modBody,
    authHeader: `Bearer ${modTokenRes.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
    moderationEndpoint: 'http://mod.test/moderation/clean',
    moderationFetchImpl: cleanFetch,
    moderateOutput: 'record',
  });
  assert.equal(cleanRecord.kind, 'plain-sse-stream', 'record-mode output moderation must preserve real streaming');
  const cleanCollected = await collectChunks(cleanRecord.chunks);
  assert.ok(cleanCollected.join('').includes('[DONE]'));
  assert.equal(cleanRecord.response_envelope.moderation.output.checked, true);
  assert.equal(cleanRecord.response_envelope.moderation.output.flagged, false);
  assert.equal(cleanRecord.response_envelope.moderation.output.mode, 'record');
  assert.equal(cleanRecord.response_envelope.streamed, true);

  // Flagged OUTPUT in RECORD mode → stream still delivered; flag recorded.
  // The custom fetch lets input pass but flags the second call (the output
  // check) so we exercise the post-hoc record path specifically.
  const moderationFlagsPath = `/tmp/luckrig-e2e-mod-flags-${process.pid}.jsonl`;
  await rm(moderationFlagsPath, { force: true });
  let modCalls = 0;
  const outputOnlyFlaggingFetch = async () => {
    modCalls += 1;
    const flagged = modCalls >= 2;
    return {
      ok: true,
      async json() {
        return flagged
          ? { id: 'mock-mod-output-flag', results: [{ flagged: true, categories: { 'violence/graphic': true } }] }
          : { id: 'mock-mod-output-clean', results: [{ flagged: false, categories: {} }] };
      },
    };
  };
  const flaggedOutputRecord = await processChatCompletion({
    body: modBody,
    authHeader: `Bearer ${modTokenRes.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
    moderationEndpoint: 'http://mod.test/moderation/output-only',
    moderationFetchImpl: outputOnlyFlaggingFetch,
    moderateOutput: 'record',
    moderationFlagsPath,
  });
  assert.equal(flaggedOutputRecord.kind, 'plain-sse-stream');
  const flaggedCollected = await collectChunks(flaggedOutputRecord.chunks);
  assert.ok(flaggedCollected.join('').includes('[DONE]'));
  // The user DID receive output (record mode trades one bad slip for evidence).
  assert.ok(flaggedCollected.join('').includes('mock:'));
  // Envelope must reflect the flag and the operator's append-only log must
  // have captured it for ban review.
  assert.equal(flaggedOutputRecord.response_envelope.moderation.output.flagged, true);
  assert.equal(flaggedOutputRecord.response_envelope.moderation.output.mode, 'record');
  const flagFile = await import('node:fs/promises').then((m) => m.readFile(moderationFlagsPath, 'utf8'));
  assert.match(flagFile, /"stage":"output"/);
  assert.match(flagFile, /"streamed":true/);
  await rm(moderationFlagsPath, { force: true });

  // ----- bans (CONCEPT §ノード提供者保護 / takedown) -----

  await tracker.appendBan({ kind: 'user_id', value: 'banned-e2e-user', reason: 'e2e ban test' });
  const bannedTokenRes = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'banned-e2e-user', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(bannedTokenRes.statusCode, 403, bannedTokenRes.text);
  assert.match(bannedTokenRes.json.error, /blocked by user_id ban/);

  // Ban a node → it disappears from /api/nodes and tokens for it return 404
  await tracker.appendBan({ kind: 'node_id', value: node.id, reason: 'e2e ban test (node)' });
  const nodesAfterBan = await requestTracker({ method: 'GET', url: '/api/nodes' });
  assert.ok(nodesAfterBan.json.nodes.every((n) => n.id !== node.id), 'banned node must be hidden from /api/nodes');
  const tokenForBannedNode = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'someone-else', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(tokenForBannedNode.statusCode, 404, tokenForBannedNode.text);

  // Lift the node ban so abuse-report test below targets a known-good node.
  tracker.banSets.node_id.delete(node.id);

  // ----- abuse reports (queued, never auto-ban) -----

  const reportRes = await requestTracker({
    method: 'POST',
    url: '/api/abuse/report',
    headers: { 'content-type': 'application/json' },
    body: {
      subject_kind: 'node_id',
      subject_id: node.id,
      reason: 'e2e abuse report',
      evidence: 'no body or chunk timestamps attached',
    },
  });
  assert.equal(reportRes.statusCode, 202, reportRes.text);
  assert.ok(reportRes.json.report_id);
  assert.match(reportRes.json.note, /human review/);
  assert.equal(typeof reportRes.json.contact, 'string');

  // Bad subject_kind → 400
  const badReport = await requestTracker({
    method: 'POST',
    url: '/api/abuse/report',
    headers: { 'content-type': 'application/json' },
    body: { subject_kind: 'invalid', subject_id: 'x', reason: 'r' },
  });
  assert.equal(badReport.statusCode, 400, badReport.text);

  // Abuse-report IP rate limit
  tracker.abuseReportIpUsageDaily.set(`${new Date().toISOString().slice(0, 10)}::local`, tracker.ABUSE_REPORT_IP_LIMIT_PER_DAY);
  const rateLimited = await requestTracker({
    method: 'POST',
    url: '/api/abuse/report',
    headers: { 'content-type': 'application/json' },
    body: { subject_kind: 'node_id', subject_id: node.id, reason: 'r' },
  });
  assert.equal(rateLimited.statusCode, 429, rateLimited.text);
  tracker.abuseReportIpUsageDaily.clear();

  // Dev-only /api/bans listing must include both bans we appended.
  const banList = await requestTracker({ method: 'GET', url: '/api/bans' });
  assert.equal(banList.statusCode, 200, banList.text);
  assert.ok(banList.json.bans.some((b) => b.kind === 'user_id' && b.value === 'banned-e2e-user'));

  // Abuse-contact endpoint must reveal a contact string (mailto:... default).
  const contactRes = await requestTracker({ method: 'GET', url: '/api/abuse-contact' });
  assert.equal(contactRes.statusCode, 200, contactRes.text);
  assert.equal(typeof contactRes.json.contact, 'string');

  console.log('[e2e] ok');
  console.log(`[e2e] node=${node.id}`);
  console.log(`[e2e] replay=${replayPath}`);
}

main().catch((error) => {
  console.error('[e2e] failed', error);
  process.exitCode = 1;
});
