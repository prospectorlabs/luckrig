import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.LUCKRIG_TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-e2e-secret';
process.env.LUCKRIG_METRICS_PATH = process.env.LUCKRIG_METRICS_PATH ?? `/tmp/luckrig-e2e-metrics-${process.pid}.jsonl`;
process.env.LUCKRIG_HEALTH_TIMEOUT_MS = process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '200';

const tracker = await import('../src/tracker/server.js');
const { processChatCompletion } = await import('../src/proxy/server.js');
const { buildEncryptedChatBody, replayFromProxyResult } = await import('../src/client/tasting.js');
const { loadReplayRecord, saveReplayRecord } = await import('../src/client/replay.js');
const { decryptJsonFromSubtext, encryptJsonToSubtext, hasSubtext } = await import('../src/subtext/index.js');
const { verifyTastingToken } = await import('../src/shared/token.js');
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
  await tracker.loadRegistry();
  await tracker.loadMetrics();
  await tracker.probeAllNodes();

  const nodesResponse = await requestTracker({ method: 'GET', url: '/api/nodes' });
  assert.equal(nodesResponse.statusCode, 200);
  assert.equal(nodesResponse.json.schema_version, 1);
  assert.ok(nodesResponse.json.nodes.length >= 3);
  const node = nodesResponse.json.nodes[0];
  assert.ok(node.observations.samples_count >= 1);

  const tokenResponse = await requestTracker({
    method: 'POST',
    url: '/api/tokens',
    headers: { 'content-type': 'application/json' },
    body: { node_id: node.id, user_id: 'contributor-e2e', contribution_score: 1, ttl_sec: 60 },
  });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.text);
  assert.equal(tokenResponse.json.schema_version, 1);
  assert.equal(tokenResponse.json.contribution.tier, 'contributor');

  const tokenPayload = verifyTastingToken(tokenResponse.json.token, {
    secret: process.env.LUCKRIG_TRACKER_SECRET,
    expectedNodeId: node.id,
  });
  assert.equal(tokenPayload.user_id, 'contributor-e2e');

  const cliDryRun = buildRegisterRequest({
    endpointUrl: 'http://127.0.0.1:8788/v1',
    modelName: 'e2e-model',
    quantization: 'Q4_K_M',
    gpu: 'E2E_GPU',
  });
  assert.equal(cliDryRun.method, 'POST');
  assert.equal(cliDryRun.body.model_name, 'e2e-model');

  const prompt = 'hello from luckrig e2e';
  const body = buildEncryptedChatBody({ prompt, sessionSecret: tokenResponse.json.session_secret, stream: true });
  assert.equal(hasSubtext(body.messages[0].content), true);
  assert.equal(decryptJsonFromSubtext(body.messages[0].content, { sessionSecret: tokenResponse.json.session_secret }).prompt, prompt);

  const proxyResult = await processChatCompletion({
    body,
    authHeader: `Bearer ${tokenResponse.json.token}`,
    nodeId: node.id,
    trackerSecret: process.env.LUCKRIG_TRACKER_SECRET,
  });
  assert.equal(proxyResult.kind, 'sse');
  assert.ok(proxyResult.chunks.join('').includes('[DONE]'));

  const replay = replayFromProxyResult(proxyResult, { sessionSecret: tokenResponse.json.session_secret, ttft_ms: 0 });
  assert.equal(replay.schema_version, 1);
  assert.equal(replay.prompt, prompt);
  assert.equal(replay.response, `mock:${prompt}`);
  assert.equal(replay.node_id, node.id);
  assert.ok(replay.tok_per_sec === null || replay.tok_per_sec >= 0);

  const historyDir = await mkdtemp(path.join(os.tmpdir(), 'luckrig-e2e-history-'));
  const replayPath = await saveReplayRecord(replay, { historyDir, date: new Date('2026-05-22T07:00:00.000Z') });
  const loadedReplay = await loadReplayRecord(replayPath);
  assert.deepEqual(loadedReplay, replay);

  const encrypted = encryptJsonToSubtext({ ok: true }, { sessionSecret: tokenResponse.json.session_secret });
  assert.deepEqual(decryptJsonFromSubtext(encrypted, { sessionSecret: tokenResponse.json.session_secret }), { ok: true });

  await assert.rejects(
    () => processChatCompletion({ body, authHeader: 'Bearer broken', nodeId: node.id, trackerSecret: process.env.LUCKRIG_TRACKER_SECRET }),
    /invalid token format|invalid token signature/,
  );

  await rm(historyDir, { recursive: true, force: true });
  await rm(process.env.LUCKRIG_METRICS_PATH, { force: true });

  console.log('[e2e] ok');
  console.log(`[e2e] node=${node.id}`);
  console.log(`[e2e] replay=${replayPath}`);
}

main().catch((error) => {
  console.error('[e2e] failed', error);
  process.exitCode = 1;
});
