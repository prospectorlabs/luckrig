import http from 'node:http';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { verifyFingerprintText } from '../shared/fingerprint.js';
import { publicKeyFingerprint } from '../shared/keyhandshake.js';
import { issueTastingToken } from '../shared/token.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number.parseInt(process.env.LUCKRIG_PORT ?? '8787', 10);
const HOST = process.env.LUCKRIG_HOST ?? '127.0.0.1';
const REGISTRY_PATH = path.resolve(ROOT, process.env.LUCKRIG_REGISTRY_PATH ?? 'data/nodes.seed.json');
const METRICS_PATH = path.resolve(ROOT, process.env.LUCKRIG_METRICS_PATH ?? 'data/metrics.jsonl');
const TOKEN_USAGE_PATH = path.resolve(ROOT, process.env.LUCKRIG_TOKEN_USAGE_PATH ?? 'data/token-usage.jsonl');
const TIMING_PATH = path.resolve(ROOT, process.env.LUCKRIG_TIMING_PATH ?? 'data/timing.jsonl');
const BANS_PATH = path.resolve(ROOT, process.env.LUCKRIG_BANS_PATH ?? 'data/bans.jsonl');
const ABUSE_REPORTS_PATH = path.resolve(ROOT, process.env.LUCKRIG_ABUSE_REPORTS_PATH ?? 'data/abuse-reports.jsonl');
const ABUSE_CONTACT = process.env.LUCKRIG_ABUSE_CONTACT ?? 'mailto:abuse@example.invalid';
const ABUSE_REPORT_IP_LIMIT_PER_DAY = Math.max(1, Number.parseInt(process.env.LUCKRIG_ABUSE_REPORT_IP_LIMIT_PER_DAY ?? '10', 10));
const DB_PATH = path.resolve(ROOT, process.env.LUCKRIG_DB_PATH ?? 'data/luckrig.sqlite');
const USE_SQLITE = process.env.LUCKRIG_USE_SQLITE !== '0';
const HEALTH_INTERVAL_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_INTERVAL_MS ?? '30000', 10);
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '2000', 10);
const DEV_WRITES_ENABLED = process.env.LUCKRIG_DEV === '1';
const TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-dev-secret-change-me';
const FULL_ACCESS_SCORE_THRESHOLD = Number.parseInt(process.env.LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD ?? '1', 10);
const LIMITED_TOKENS_PER_DAY = Number.parseInt(process.env.LUCKRIG_LIMITED_TOKENS_PER_DAY ?? '5', 10);
const TOKEN_USAGE_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.LUCKRIG_TOKEN_USAGE_RETENTION_DAYS ?? '7', 10));
const TOKEN_IP_LIMIT_PER_DAY = Math.max(1, Number.parseInt(process.env.LUCKRIG_TOKEN_IP_LIMIT_PER_DAY ?? '100', 10));

/** @type {Map<string, import('./types.js').NodeRecord>} */
const nodes = new Map();

/** @type {Map<string, import('./types.js').MetricsSummary>} */
const metricsSummaries = new Map();

/** @type {Map<string, number>} */
const tokenUsageDaily = new Map();
const tokenIpUsageDaily = new Map();

/** @type {Array<object>} */
const tokenUsageEvents = [];

let sqliteDb = null;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);


async function getDb() {
  if (!USE_SQLITE) return null;
  if (sqliteDb) return sqliteDb;
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  sqliteDb = new DatabaseSync(DB_PATH);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_node_observed ON metrics(node_id, observed_at);
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      token_jti TEXT NOT NULL,
      crypto_mode TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_day_user_tier ON token_usage(day, user_id, tier);
    CREATE TABLE IF NOT EXISTS contribution_state (
      user_id TEXT PRIMARY KEY,
      score REAL NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'limited',
      updated_at TEXT NOT NULL
    );
  `);
  return sqliteDb;
}

async function dbAll(sql, params = []) {
  const db = await getDb();
  if (!db) return [];
  return db.prepare(sql).all(...params);
}

async function dbRun(sql, params = []) {
  const db = await getDb();
  if (!db) return null;
  return db.prepare(sql).run(...params);
}

async function upsertNodeDb(node) {
  await dbRun(
    'INSERT INTO nodes (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    [node.id, JSON.stringify(node), node.updated_at ?? nowIso()],
  );
}

async function loadNodesFromDb() {
  const rows = await dbAll('SELECT json FROM nodes ORDER BY id');
  return rows.map((row) => JSON.parse(row.json));
}

async function appendMetricDb(sample) {
  await dbRun(
    'INSERT INTO metrics (node_id, observed_at, status, json) VALUES (?, ?, ?, ?)',
    [sample.node_id, sample.observed_at, sample.status, JSON.stringify(sample)],
  );
}

async function loadMetricSamplesFromDb() {
  const rows = await dbAll('SELECT json FROM metrics ORDER BY id');
  return rows.map((row) => JSON.parse(row.json));
}

async function appendTokenUsageDb(event) {
  await dbRun(
    'INSERT INTO token_usage (day, user_id, node_id, tier, token_jti, crypto_mode, issued_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [event.day, event.user_id, event.node_id, event.tier, event.token_jti, event.crypto_mode, event.issued_at, JSON.stringify(event)],
  );
}


async function upsertContributionState(status) {
  await dbRun(
    'INSERT INTO contribution_state (user_id, score, tier, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, updated_at = excluded.updated_at',
    [status.user_id, status.contribution_score, status.tier, nowIso()],
  );
}

async function loadTokenUsageFromDb() {
  const rows = await dbAll('SELECT json FROM token_usage ORDER BY id');
  return rows.map((row) => JSON.parse(row.json));
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400, cause: error });
  }
}

function normalizeUrl(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${fieldName} is required`), { statusCode: 400 });
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw Object.assign(new Error(`${fieldName} must be a valid URL`), { statusCode: 400, cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error(`${fieldName} must be http or https`), { statusCode: 400 });
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function asOptionalString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function asOptionalInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function slugifyId(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function asOptionalNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    const parsed = asOptionalNumber(value, null);
    if (parsed !== null) return parsed;
  }
  return null;
}

function compactObject(value) {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeTelemetry(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const memorySource = payload.memory ?? payload.mem ?? payload.ram ?? payload.vram;
  const gpuSource = payload.gpu ?? payload.cuda ?? payload.accelerator;
  const engineSource = payload.engine ?? payload.runtime ?? payload.server;
  const queueSource = payload.queue;

  const memory = compactObject({
    used_mb: pickNumber(memorySource, ['used_mb', 'usedMiB', 'used_mib', 'used']),
    total_mb: pickNumber(memorySource, ['total_mb', 'totalMiB', 'total_mib', 'total']),
    free_mb: pickNumber(memorySource, ['free_mb', 'freeMiB', 'free_mib', 'free']),
  });

  const gpu = compactObject({
    name: typeof gpuSource?.name === 'string' ? gpuSource.name : undefined,
    utilization_pct: pickNumber(gpuSource, ['utilization_pct', 'utilization', 'util_pct']),
    memory_used_mb: pickNumber(gpuSource, ['memory_used_mb', 'mem_used_mb', 'vram_used_mb']),
    memory_total_mb: pickNumber(gpuSource, ['memory_total_mb', 'mem_total_mb', 'vram_total_mb']),
    temperature_c: pickNumber(gpuSource, ['temperature_c', 'temp_c', 'temperature']),
    power_w: pickNumber(gpuSource, ['power_w', 'power']),
  });

  const engine = compactObject({
    name: typeof engineSource?.name === 'string' ? engineSource.name : undefined,
    version: typeof engineSource?.version === 'string' ? engineSource.version : undefined,
    backend: typeof engineSource?.backend === 'string' ? engineSource.backend : undefined,
  });

  const queue = compactObject({
    depth: pickNumber(queueSource, ['depth', 'size', 'waiting']),
    active: pickNumber(queueSource, ['active', 'inflight', 'running']),
  });

  const normalized = compactObject({
    memory,
    gpu,
    engine,
    queue,
    error_rate: pickNumber(payload, ['error_rate', 'errorRate']),
    active_requests: pickNumber(payload, ['active_requests', 'activeRequests']),
  });

  return normalized;
}

async function parseHealthPayload(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;

  const raw = await response.text();
  if (!raw || raw.length > 64 * 1024) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function emptyMetricsSummary(nodeId) {
  return {
    node_id: nodeId,
    samples_count: 0,
    available_samples: 0,
    unavailable_samples: 0,
    unknown_samples: 0,
    availability_ratio: null,
    last_observed_at: null,
    last_status: 'unknown',
    last_latency_ms: null,
    last_memory: null,
    last_gpu: null,
    last_engine: null,
    last_queue: null,
    last_error_rate: null,
    last_error: null,
  };
}

function updateMetricsSummary(sample) {
  const summary = metricsSummaries.get(sample.node_id) ?? emptyMetricsSummary(sample.node_id);
  summary.samples_count += 1;
  if (sample.status === 'available') summary.available_samples += 1;
  else if (sample.status === 'unavailable') summary.unavailable_samples += 1;
  else summary.unknown_samples += 1;

  summary.availability_ratio = summary.samples_count > 0
    ? Number((summary.available_samples / summary.samples_count).toFixed(4))
    : null;
  summary.last_observed_at = sample.observed_at;
  summary.last_status = sample.status;
  summary.last_latency_ms = sample.latency_ms;
  summary.last_memory = sample.telemetry?.memory ?? summary.last_memory;
  summary.last_gpu = sample.telemetry?.gpu ?? summary.last_gpu;
  summary.last_engine = sample.telemetry?.engine ?? summary.last_engine;
  summary.last_queue = sample.telemetry?.queue ?? summary.last_queue;
  summary.last_error_rate = sample.telemetry?.error_rate ?? summary.last_error_rate;
  summary.last_error = sample.error ?? null;
  metricsSummaries.set(sample.node_id, summary);
  return summary;
}

async function appendMetricSample(sample) {
  updateMetricsSummary(sample);
  await appendMetricDb(sample);
  try {
    await mkdir(path.dirname(METRICS_PATH), { recursive: true });
    await appendFile(METRICS_PATH, `${JSON.stringify(sample)}\n`, 'utf8');
  } catch (error) {
    console.error('[tracker] failed to append metrics sample', error);
  }
}

async function loadMetrics() {
  metricsSummaries.clear();
  const dbSamples = await loadMetricSamplesFromDb();
  if (dbSamples.length > 0) {
    for (const sample of dbSamples) {
      if (sample?.schema_version === 1 && sample?.type === 'health_probe' && sample?.node_id) updateMetricsSummary(sample);
    }
    return;
  }

  let raw;
  try {
    raw = await readFile(METRICS_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const sample = JSON.parse(line);
      if (sample?.schema_version === 1 && sample?.type === 'health_probe' && sample?.node_id) {
        updateMetricsSummary(sample);
        await appendMetricDb(sample);
      }
    } catch {
      // Ignore malformed historical lines. The JSONL append-only log is best-effort.
    }
  }
}

function getMetricsSummary(nodeId) {
  return metricsSummaries.get(nodeId) ?? emptyMetricsSummary(nodeId);
}

function listMetricsSummaries() {
  return [...nodes.keys()].map((nodeId) => getMetricsSummary(nodeId));
}

// ----- opt-in timing metadata (per CONCEPT §opt-in timing metadata sharing) -----

const TIMING_ALLOWED_FIELDS = new Set([
  'schema_version',
  'node_id',
  'mode',
  'user_id',
  'created_at',
  'tok_per_sec',
  'ttft_ms',
  'proxy_ttft_ms',
  'network_ttft_ms',
  'generation_sec',
  'queue_wait_sec',
  'output_tokens',
  'tokenizer',
  'tokenizer_model_family',
  'limited_output_truncated',
]);
const TIMING_DISALLOWED_KEY_HINTS = ['prompt', 'response', 'message', 'chunk_timestamp', 'content', 'envelope', 'body'];
const TIMING_MAX_BYTES = 4 * 1024;

const timingByNode = new Map();

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * p)));
  return sortedValues[idx];
}

function updateTimingAggregate(sample) {
  if (!sample?.node_id) return;
  const bucket = timingByNode.get(sample.node_id) ?? { samples: [], last_uploaded_at: null };
  bucket.samples.push(sample);
  // Cap at 200 samples per node to bound memory; oldest dropped.
  if (bucket.samples.length > 200) bucket.samples.splice(0, bucket.samples.length - 200);
  bucket.last_uploaded_at = sample.created_at ?? nowIso();
  timingByNode.set(sample.node_id, bucket);
}

function getCommunityTiming(nodeId) {
  const bucket = timingByNode.get(nodeId);
  if (!bucket || bucket.samples.length === 0) {
    return { samples_count: 0, tok_per_sec_p50: null, ttft_ms_p50: null, last_uploaded_at: null };
  }
  const tps = bucket.samples
    .map((s) => Number(s.tok_per_sec))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const ttfts = bucket.samples
    .map((s) => Number(s.ttft_ms ?? s.proxy_ttft_ms ?? s.network_ttft_ms))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  return {
    samples_count: bucket.samples.length,
    tok_per_sec_p50: percentile(tps, 0.5),
    ttft_ms_p50: percentile(ttfts, 0.5),
    last_uploaded_at: bucket.last_uploaded_at,
  };
}

function validateTimingPayload(input, { maxBytes = TIMING_MAX_BYTES } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('timing payload must be a JSON object'), { statusCode: 400 });
  }
  const raw = JSON.stringify(input);
  if (raw.length > maxBytes) {
    throw Object.assign(new Error('timing payload exceeds size budget'), { statusCode: 413 });
  }
  for (const key of Object.keys(input)) {
    const lower = key.toLowerCase();
    if (TIMING_DISALLOWED_KEY_HINTS.some((hint) => lower.includes(hint))) {
      throw Object.assign(new Error(`disallowed field "${key}" in timing payload`), { statusCode: 400 });
    }
    if (!TIMING_ALLOWED_FIELDS.has(key)) {
      throw Object.assign(new Error(`unknown field "${key}" in timing payload`), { statusCode: 400 });
    }
    const value = input[key];
    if (value !== null && typeof value === 'object') {
      throw Object.assign(new Error(`nested object not allowed in timing payload (field: ${key})`), { statusCode: 400 });
    }
  }
  if (input.schema_version !== 1) {
    throw Object.assign(new Error('schema_version must be 1'), { statusCode: 400 });
  }
  if (typeof input.node_id !== 'string' || !nodes.has(input.node_id)) {
    throw Object.assign(new Error('unknown node_id'), { statusCode: 404 });
  }
  if (input.mode && !['plain', 'public-key', 'session-secret'].includes(input.mode)) {
    throw Object.assign(new Error(`unsupported mode: ${input.mode}`), { statusCode: 400 });
  }
  return {
    schema_version: 1,
    node_id: input.node_id,
    mode: input.mode ?? 'plain',
    user_id: typeof input.user_id === 'string' ? input.user_id.slice(0, 128) : 'anonymous',
    created_at: typeof input.created_at === 'string' ? input.created_at : nowIso(),
    tok_per_sec: asOptionalNumber(input.tok_per_sec, null),
    ttft_ms: asOptionalNumber(input.ttft_ms, null),
    proxy_ttft_ms: asOptionalNumber(input.proxy_ttft_ms, null),
    network_ttft_ms: asOptionalNumber(input.network_ttft_ms, null),
    generation_sec: asOptionalNumber(input.generation_sec, null),
    queue_wait_sec: asOptionalNumber(input.queue_wait_sec, null),
    output_tokens: asOptionalInteger(input.output_tokens, null),
    tokenizer: typeof input.tokenizer === 'string' ? input.tokenizer.slice(0, 64) : null,
    tokenizer_model_family: typeof input.tokenizer_model_family === 'string' ? input.tokenizer_model_family.slice(0, 64) : null,
    limited_output_truncated: input.limited_output_truncated === true,
    stored_at: nowIso(),
  };
}

async function appendTimingSample(sample) {
  updateTimingAggregate(sample);
  try {
    await mkdir(path.dirname(TIMING_PATH), { recursive: true });
    await appendFile(TIMING_PATH, `${JSON.stringify(sample)}\n`, 'utf8');
  } catch (error) {
    console.error('[tracker] failed to append timing sample', error);
  }
}

async function loadTiming() {
  timingByNode.clear();
  let raw;
  try {
    raw = await readFile(TIMING_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const sample = JSON.parse(line);
      if (sample?.schema_version === 1 && sample?.node_id && nodes.has(sample.node_id)) {
        updateTimingAggregate(sample);
      }
    } catch {
      // Ignore malformed historical lines.
    }
  }
}

// ----- bans (CONCEPT §ノード提供者保護 / takedown) -----
//
// Bans are an operator-side takedown mechanism. Three kinds are supported:
//   - user_id  : block API surface for a tasting user
//   - ip       : block API surface for a source IP
//   - node_id  : hide a node from the public list and refuse token issuance
// The intent is to give the tracker operator a "Notice and Takedown" lever so
// that the operator's plain-vanilla intermediary-liability defense is not
// undermined by a single bad listing. Bans are persisted to JSONL and loaded
// at startup. There is no auto-ban: abuse reports queue for human review.

const banSets = { user_id: new Map(), ip: new Map(), node_id: new Map() };

function isBanExpired(entry, now = new Date()) {
  if (!entry?.expires_at) return false;
  const ts = Date.parse(entry.expires_at);
  if (!Number.isFinite(ts)) return false;
  return ts <= now.getTime();
}

function applyBanEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const kind = entry.kind;
  if (!['user_id', 'ip', 'node_id'].includes(kind)) return false;
  const value = typeof entry.value === 'string' ? entry.value.trim() : '';
  if (!value) return false;
  if (isBanExpired(entry)) return false;
  banSets[kind].set(value, {
    kind,
    value,
    reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 280) : '',
    created_at: typeof entry.created_at === 'string' ? entry.created_at : nowIso(),
    expires_at: typeof entry.expires_at === 'string' ? entry.expires_at : null,
  });
  return true;
}

async function loadBans() {
  for (const set of Object.values(banSets)) set.clear();
  let raw;
  try {
    raw = await readFile(BANS_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      applyBanEntry(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
}

async function appendBan({ kind, value, reason = '', expires_at = null } = {}) {
  if (!['user_id', 'ip', 'node_id'].includes(kind)) {
    throw Object.assign(new Error(`unsupported ban kind: ${kind}`), { statusCode: 400 });
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('ban value is required'), { statusCode: 400 });
  }
  const entry = {
    schema_version: 1,
    kind,
    value: value.trim(),
    reason: String(reason ?? '').slice(0, 280),
    created_at: nowIso(),
    expires_at: typeof expires_at === 'string' ? expires_at : null,
  };
  applyBanEntry(entry);
  try {
    await mkdir(path.dirname(BANS_PATH), { recursive: true });
    await appendFile(BANS_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[tracker] failed to append ban', error);
  }
  return entry;
}

function checkBan({ user_id, ip, node_id } = {}) {
  for (const [kind, lookup] of [['user_id', user_id], ['ip', ip], ['node_id', node_id]]) {
    if (!lookup) continue;
    const entry = banSets[kind].get(lookup);
    if (!entry) continue;
    if (isBanExpired(entry)) {
      banSets[kind].delete(lookup);
      continue;
    }
    return entry;
  }
  return null;
}

function listBans() {
  const out = [];
  for (const set of Object.values(banSets)) {
    for (const entry of set.values()) {
      if (!isBanExpired(entry)) out.push(entry);
    }
  }
  return out;
}

function assertNotBanned({ user_id, ip, node_id, kind = 'request' } = {}) {
  const entry = checkBan({ user_id, ip, node_id });
  if (!entry) return null;
  const error = new Error(`${kind} blocked by ${entry.kind} ban: ${entry.reason || 'no reason supplied'}`);
  error.statusCode = 403;
  error.ban = { kind: entry.kind, value: entry.value, reason: entry.reason };
  throw error;
}

// ----- abuse reports (queued for human review; do not auto-ban) -----

const ABUSE_REPORT_ALLOWED_SUBJECT_KINDS = new Set(['node_id', 'user_id', 'content_id', 'other']);
const ABUSE_REPORT_MAX_BYTES = 8 * 1024;
const abuseReportIpUsageDaily = new Map();

function assertAbuseReportIpRate(req) {
  const ip = clientIpFromReq(req);
  const key = ipUsageKey({ ip });
  const used = abuseReportIpUsageDaily.get(key) ?? 0;
  if (used >= ABUSE_REPORT_IP_LIMIT_PER_DAY) {
    const error = new Error(`abuse-report IP rate limit exceeded for today (${used}/${ABUSE_REPORT_IP_LIMIT_PER_DAY})`);
    error.statusCode = 429;
    throw error;
  }
  return { ip, used, limit: ABUSE_REPORT_IP_LIMIT_PER_DAY, key };
}

function recordAbuseReportIpUsage(rate) {
  abuseReportIpUsageDaily.set(rate.key, (abuseReportIpUsageDaily.get(rate.key) ?? 0) + 1);
}

function normalizeAbuseReport(input, { ip, maxBytes = ABUSE_REPORT_MAX_BYTES } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('abuse report must be a JSON object'), { statusCode: 400 });
  }
  const raw = JSON.stringify(input);
  if (raw.length > maxBytes) {
    throw Object.assign(new Error('abuse report exceeds size budget'), { statusCode: 413 });
  }
  const subjectKind = String(input.subject_kind ?? input.subjectKind ?? '').toLowerCase();
  if (!ABUSE_REPORT_ALLOWED_SUBJECT_KINDS.has(subjectKind)) {
    throw Object.assign(new Error(`unsupported subject_kind: ${subjectKind}`), { statusCode: 400 });
  }
  const subjectId = typeof input.subject_id === 'string' ? input.subject_id.slice(0, 200) : '';
  if (!subjectId) {
    throw Object.assign(new Error('subject_id is required'), { statusCode: 400 });
  }
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 2000) : '';
  const evidence = typeof input.evidence === 'string' ? input.evidence.slice(0, 4000) : '';
  return {
    schema_version: 1,
    report_id: randomBytes(8).toString('base64url'),
    subject_kind: subjectKind,
    subject_id: subjectId,
    reason,
    evidence,
    reporter_ip_hash: ip ? hashIp(ip) : null,
    created_at: nowIso(),
  };
}

function hashIp(ip) {
  // We avoid storing raw reporter IPs to limit our liability and to protect
  // reporter privacy. A salted hash is good enough for de-duplication and
  // rate-limit forensics without becoming a personal-data ledger.
  const salt = TRACKER_SECRET || 'luckrig-bans';
  return createHmac('sha256', salt).update(String(ip)).digest('base64url').slice(0, 16);
}

async function appendAbuseReport(report) {
  try {
    await mkdir(path.dirname(ABUSE_REPORTS_PATH), { recursive: true });
    await appendFile(ABUSE_REPORTS_PATH, `${JSON.stringify(report)}\n`, 'utf8');
  } catch (error) {
    console.error('[tracker] failed to append abuse report', error);
  }
}

function contributionStatus({ userId = 'anonymous', contributionScore = 0 } = {}) {
  const score = asOptionalNumber(contributionScore, 0) ?? 0;
  const tier = score >= FULL_ACCESS_SCORE_THRESHOLD ? 'contributor' : 'limited';
  return {
    user_id: userId,
    contribution_score: score,
    full_access_threshold: FULL_ACCESS_SCORE_THRESHOLD,
    tier,
    access: tier === 'contributor'
      ? { mode: 'full', description: 'POC contributor token: all listed models may be requested.' }
      : { mode: 'limited', description: 'POC limited token: tasting access only. Production will enforce stricter quota/output limits.' },
  };
}


function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}


function ipUsageKey({ ip, day = dayKey() } = {}) {
  return `${day}::${ip || 'unknown'}`;
}

function clientIpFromReq(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'local';
}

function pruneIpUsageMap({ now = new Date(), retentionDays = TOKEN_USAGE_RETENTION_DAYS } = {}) {
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffKey = dayKey(cutoff);
  let removed = 0;
  for (const key of tokenIpUsageDaily.keys()) {
    const [day] = key.split('::');
    if (day && day < cutoffKey) {
      tokenIpUsageDaily.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function assertIpTokenRate(req) {
  pruneIpUsageMap();
  const ip = clientIpFromReq(req);
  const key = ipUsageKey({ ip });
  const used = tokenIpUsageDaily.get(key) ?? 0;
  if (used >= TOKEN_IP_LIMIT_PER_DAY) {
    const error = new Error(`IP token rate limit exceeded for today (${used}/${TOKEN_IP_LIMIT_PER_DAY})`);
    error.statusCode = 429;
    error.rate_limit = { ip, used, limit: TOKEN_IP_LIMIT_PER_DAY };
    throw error;
  }
  return { ip, used, limit: TOKEN_IP_LIMIT_PER_DAY };
}

function recordIpTokenUsage(rate) {
  if (!rate?.ip) return;
  const key = ipUsageKey({ ip: rate.ip });
  tokenIpUsageDaily.set(key, (tokenIpUsageDaily.get(key) ?? 0) + 1);
}

async function verifyFingerprintUrl({ expected, url, fetchImpl = fetch } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('fingerprint_url must be http or https'), { statusCode: 400 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetchImpl(parsed, { signal: controller.signal, headers: { 'user-agent': 'luckrig-tracker/0.0.0' } });
    if (!res.ok) throw Object.assign(new Error(`fingerprint_url HTTP ${res.status}`), { statusCode: 502 });
    const text = await res.text();
    return verifyFingerprintText({ expected, text });
  } finally {
    clearTimeout(timer);
  }
}

function tokenUsageKey({ userId, day = dayKey(), tier = 'limited' } = {}) {
  return `${day}::${tier}::${userId || 'anonymous'}`;
}


function pruneTokenUsageMap({ now = new Date(), retentionDays = TOKEN_USAGE_RETENTION_DAYS } = {}) {
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffKey = dayKey(cutoff);
  let removed = 0;
  for (const key of tokenUsageDaily.keys()) {
    const [day] = key.split('::');
    if (day && day < cutoffKey) {
      tokenUsageDaily.delete(key);
      removed += 1;
    }
  }
  for (let i = tokenUsageEvents.length - 1; i >= 0; i -= 1) {
    if (tokenUsageEvents[i]?.day && tokenUsageEvents[i].day < cutoffKey) tokenUsageEvents.splice(i, 1);
  }
  return removed;
}

function getTokenUsage({ userId, tier = 'limited', day = dayKey() } = {}) {
  return tokenUsageDaily.get(tokenUsageKey({ userId, tier, day })) ?? 0;
}

async function loadTokenUsage() {
  tokenUsageDaily.clear();
  tokenUsageEvents.length = 0;
  // best-effort pruning after rebuilding the map
  const dbEvents = await loadTokenUsageFromDb();
  if (dbEvents.length > 0) {
    for (const event of dbEvents) {
      tokenUsageEvents.push(event);
      const key = tokenUsageKey({ userId: event.user_id, tier: event.tier, day: event.day });
      tokenUsageDaily.set(key, (tokenUsageDaily.get(key) ?? 0) + 1);
    }
    pruneTokenUsageMap();
    return;
  }

  let raw;
  try {
    raw = await readFile(TOKEN_USAGE_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.schema_version === 1 && event?.type === 'token_issued') {
        tokenUsageEvents.push(event);
        const key = tokenUsageKey({ userId: event.user_id, tier: event.tier, day: event.day });
        tokenUsageDaily.set(key, (tokenUsageDaily.get(key) ?? 0) + 1);
        await appendTokenUsageDb(event);
      }
    } catch {
      // Ignore malformed token usage lines. JSONL is best-effort append-only data.
    }
  }
  pruneTokenUsageMap();
}

async function appendTokenUsage(event) {
  const normalized = {
    schema_version: 1,
    type: 'token_issued',
    issued_at: nowIso(),
    day: dayKey(),
    ...event,
  };
  tokenUsageEvents.push(normalized);
  const key = tokenUsageKey({ userId: normalized.user_id, tier: normalized.tier, day: normalized.day });
  tokenUsageDaily.set(key, (tokenUsageDaily.get(key) ?? 0) + 1);
  await appendTokenUsageDb(normalized);
  await mkdir(path.dirname(TOKEN_USAGE_PATH), { recursive: true });
  await appendFile(TOKEN_USAGE_PATH, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

function assertTokenQuota(status) {
  pruneTokenUsageMap();
  if (status.tier !== 'limited') return { allowed: true, used: null, limit: null };
  const used = getTokenUsage({ userId: status.user_id, tier: status.tier });
  if (used >= LIMITED_TOKENS_PER_DAY) {
    const error = new Error(`limited token quota exceeded for today (${used}/${LIMITED_TOKENS_PER_DAY})`);
    error.statusCode = 429;
    error.quota = { allowed: false, used, limit: LIMITED_TOKENS_PER_DAY };
    throw error;
  }
  return { allowed: true, used, limit: LIMITED_TOKENS_PER_DAY };
}

function normalizeNode(input, existing = undefined) {
  const modelName = asOptionalString(input.model_name ?? input.modelName);
  const gpu = asOptionalString(input.gpu);
  const quantization = asOptionalString(input.quantization);

  if (!modelName) throw Object.assign(new Error('model_name is required'), { statusCode: 400 });
  if (!gpu) throw Object.assign(new Error('gpu is required'), { statusCode: 400 });
  if (!quantization) throw Object.assign(new Error('quantization is required'), { statusCode: 400 });

  const idBase = input.id ?? `${gpu}-${modelName}-${quantization}`;
  const id = slugifyId(idBase) || randomUUID();
  const endpointUrl = normalizeUrl(input.endpoint_url ?? input.endpointUrl, 'endpoint_url');
  const rawHealthUrl = input.health_url ?? input.healthUrl;
  const healthUrl = rawHealthUrl
    ? normalizeUrl(rawHealthUrl, 'health_url')
    : `${endpointUrl.replace(/\/v1$/, '')}/health`;

  return {
    id,
    display_name: asOptionalString(input.display_name ?? input.displayName, `${gpu} / ${modelName}`),
    endpoint_url: endpointUrl,
    health_url: healthUrl,
    node_public_key: asOptionalString(input.node_public_key ?? input.nodePublicKey),
    fingerprint_url: asOptionalString(input.fingerprint_url ?? input.fingerprintUrl),
    model_name: modelName,
    quantization,
    lora: asOptionalString(input.lora, 'なし'),
    gpu,
    vram_gb: asOptionalInteger(input.vram_gb ?? input.vramGb, null),
    context_length: asOptionalInteger(input.context_length ?? input.contextLength, null),
    availability_note: asOptionalString(input.availability_note ?? input.availabilityNote),
    tuning_note: asOptionalString(input.tuning_note ?? input.tuningNote),
    tags: normalizeTags(input.tags),
    created_at: existing?.created_at ?? asOptionalString(input.created_at ?? input.createdAt, nowIso()),
    updated_at: nowIso(),
    health: existing?.health ?? {
      status: 'unknown',
      last_checked_at: null,
      last_seen_at: null,
      latency_ms: null,
      consecutive_failures: 0,
      last_error: null,
    },
  };
}

function computeRarityScores() {
  const comboCounts = new Map();
  for (const node of nodes.values()) {
    const key = `${node.gpu}::${node.model_name}::${node.quantization}`.toLowerCase();
    comboCounts.set(key, (comboCounts.get(key) ?? 0) + 1);
  }

  const scores = new Map();
  for (const node of nodes.values()) {
    const key = `${node.gpu}::${node.model_name}::${node.quantization}`.toLowerCase();
    const comboCount = comboCounts.get(key) ?? 1;
    const scarcity = 1 / comboCount;
    const showcaseBonus = node.tags.includes('showcase') ? 0.15 : 0;
    const lowSpecBonus = Number.isFinite(node.vram_gb) && node.vram_gb <= 8 ? 0.05 : 0;
    scores.set(node.id, Number((scarcity + showcaseBonus + lowSpecBonus).toFixed(4)));
  }
  return scores;
}

function nodePublicKeyFingerprint(node) {
  if (!node?.node_public_key) return null;
  try {
    return publicKeyFingerprint(node.node_public_key);
  } catch {
    return null;
  }
}

function publicNode(node, rarityScore) {
  const contribution = computeNodeContributionScores().get(node.id);
  const showcase = computeShowcases().byNode.get(node.id) ?? [];
  return {
    id: node.id,
    display_name: node.display_name,
    endpoint_url: node.endpoint_url,
    node_public_key: node.node_public_key || null,
    node_public_key_fingerprint: nodePublicKeyFingerprint(node),
    fingerprint_url: node.fingerprint_url || null,
    model_name: node.model_name,
    quantization: node.quantization,
    lora: node.lora,
    gpu: node.gpu,
    vram_gb: node.vram_gb,
    context_length: node.context_length,
    availability_note: node.availability_note,
    tuning_note: node.tuning_note,
    tags: node.tags,
    created_at: node.created_at,
    updated_at: node.updated_at,
    rarity_score: rarityScore,
    showcase,
    contribution,
    health: node.health,
    observations: getMetricsSummary(node.id),
    community_timing: getCommunityTiming(node.id),
  };
}


function nodeAgeDays(node, now = Date.now()) {
  const created = Date.parse(node.created_at ?? nowIso());
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, (now - created) / 86400000);
}

function usageEventsForNode(nodeId) {
  return tokenUsageEvents.filter((event) => event.node_id === nodeId);
}

function computeNodeContributionScores() {
  const rarity = computeRarityScores();
  const result = new Map();
  for (const node of nodes.values()) {
    const events = usageEventsForNode(node.id);
    const users = new Set(events.map((event) => event.user_id).filter(Boolean));
    const existenceScore = Number(Math.min(10, nodeAgeDays(node) * 0.2).toFixed(3));
    const rarityScore = Number(((rarity.get(node.id) ?? 0) * 5).toFixed(3));
    const usageScore = Number(Math.min(20, events.length * 0.5).toFixed(3));
    const discoveryScore = Number(Math.min(20, users.size * 2).toFixed(3));
    const noteScore = node.tuning_note ? Number(Math.min(10, 1 + node.tuning_note.length / 120).toFixed(3)) : 0;
    const total = Number((existenceScore + rarityScore + usageScore + discoveryScore + noteScore).toFixed(3));
    result.set(node.id, {
      node_id: node.id,
      total,
      tier: total >= FULL_ACCESS_SCORE_THRESHOLD ? 'contributor' : 'limited',
      components: {
        existence_score: existenceScore,
        rarity_score: rarityScore,
        usage_score: usageScore,
        discovery_score: discoveryScore,
        note_score: noteScore,
      },
      evidence: {
        token_issued_count: events.length,
        distinct_tasting_users: users.size,
        age_days: Number(nodeAgeDays(node).toFixed(3)),
        has_tuning_note: Boolean(node.tuning_note),
      },
    });
  }
  return result;
}

function computeShowcases() {
  const list = [...nodes.values()];
  const byVram = list.filter((node) => Number.isFinite(node.vram_gb)).sort((a, b) => a.vram_gb - b.vram_gb);
  const lowSpec = byVram[0] ?? null;
  const cpu = list.find((node) => /cpu|raspberry|pi/i.test(node.gpu));
  const apple = list.find((node) => /apple|m\d+\s*max|m\d+\s*pro/i.test(node.gpu));
  const highCtx = [...list].sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))[0] ?? null;
  const categories = [
    { id: 'lowest-vram', label: '最低VRAM/CPU Showcase', node_id: lowSpec?.id ?? null, reason: lowSpec ? `${lowSpec.gpu} / ${lowSpec.vram_gb}GB` : null },
    { id: 'cpu-rig', label: 'CPU / Raspberry Pi Showcase', node_id: cpu?.id ?? null, reason: cpu?.gpu ?? null },
    { id: 'apple-silicon', label: 'Apple Silicon Showcase', node_id: apple?.id ?? null, reason: apple?.gpu ?? null },
    { id: 'largest-context', label: '最大context Showcase', node_id: highCtx?.id ?? null, reason: highCtx ? `${highCtx.context_length} ctx` : null },
  ].filter((entry, index, arr) => entry.node_id && arr.findIndex((x) => x.id === entry.id) === index);
  const byNode = new Map();
  for (const entry of categories) {
    if (!byNode.has(entry.node_id)) byNode.set(entry.node_id, []);
    byNode.get(entry.node_id).push({ id: entry.id, label: entry.label, reason: entry.reason });
  }
  return { categories, byNode };
}

function listPublicNodes({ status } = {}) {
  const scores = computeRarityScores();
  let list = [...nodes.values()]
    .filter((node) => !banSets.node_id.has(node.id))
    .map((node) => publicNode(node, scores.get(node.id) ?? 0));

  if (status && status !== 'all') {
    list = list.filter((node) => node.health.status === status);
  }

  // Concept rule: default list is not high-spec descending. Rarity/Showcase first,
  // then lower VRAM first to keep low-spec listings visible.
  list.sort((a, b) => {
    if (b.rarity_score !== a.rarity_score) return b.rarity_score - a.rarity_score;
    const av = a.vram_gb ?? Number.POSITIVE_INFINITY;
    const bv = b.vram_gb ?? Number.POSITIVE_INFINITY;
    if (av !== bv) return av - bv;
    return a.created_at.localeCompare(b.created_at);
  });
  return list;
}

async function loadRegistry() {
  nodes.clear();
  const dbRecords = await loadNodesFromDb();
  if (dbRecords.length > 0) {
    for (const entry of dbRecords) {
      const node = normalizeNode(entry);
      nodes.set(node.id, node);
    }
    return;
  }

  const raw = await readFile(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`registry must be an array: ${REGISTRY_PATH}`);
  for (const entry of parsed) {
    const node = normalizeNode(entry);
    nodes.set(node.id, node);
    await upsertNodeDb(node);
  }
}

async function saveRegistry() {
  const records = [...nodes.values()].map(({ health: _health, ...node }) => node);
  if (USE_SQLITE) {
    for (const node of records) await upsertNodeDb(node);
    return;
  }
  await writeFile(REGISTRY_PATH, `${JSON.stringify(records, null, 2)}
`, 'utf8');
}

async function probeNode(node) {
  const started = performance.now();
  const observedAt = nowIso();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(node.health_url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'user-agent': 'luckrig-tracker/0.0.0' },
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const healthPayload = await parseHealthPayload(res);
    const telemetry = normalizeTelemetry(healthPayload);

    node.health = {
      status: 'available',
      last_checked_at: observedAt,
      last_seen_at: observedAt,
      latency_ms: latencyMs,
      consecutive_failures: 0,
      last_error: null,
    };

    await appendMetricSample({
      schema_version: 1,
      type: 'health_probe',
      observed_at: observedAt,
      node_id: node.id,
      status: 'available',
      latency_ms: latencyMs,
      health_url: node.health_url,
      telemetry,
      error: null,
    });
  } catch (error) {
    const failures = (node.health?.consecutive_failures ?? 0) + 1;
    const message = error?.name === 'AbortError'
      ? `timeout after ${HEALTH_TIMEOUT_MS}ms`
      : String(error?.message ?? error);

    node.health = {
      status: failures >= 1 ? 'unavailable' : 'unknown',
      last_checked_at: observedAt,
      last_seen_at: node.health?.last_seen_at ?? null,
      latency_ms: null,
      consecutive_failures: failures,
      last_error: message,
    };

    await appendMetricSample({
      schema_version: 1,
      type: 'health_probe',
      observed_at: observedAt,
      node_id: node.id,
      status: node.health.status,
      latency_ms: null,
      health_url: node.health_url,
      telemetry: null,
      error: message,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeAllNodes() {
  await Promise.allSettled([...nodes.values()].map((node) => probeNode(node)));
}

async function serveStatic(req, res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(requestPath);
  const fullPath = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
  if (!fullPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    text(res, 403, 'forbidden');
    return;
  }

  const ext = path.extname(fullPath);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) {
      text(res, 404, 'not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES.get(ext) ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    const stream = createReadStream(fullPath);
    stream.on('error', () => {
      if (!res.headersSent) text(res, 500, 'failed to read file');
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    text(res, 404, 'not found');
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      service: 'luckrig-tracker',
      registry_path: REGISTRY_PATH,
      metrics_path: METRICS_PATH,
      token_usage_path: TOKEN_USAGE_PATH,
      db_path: USE_SQLITE ? DB_PATH : null,
      node_count: nodes.size,
      health_interval_ms: HEALTH_INTERVAL_MS,
      health_timeout_ms: HEALTH_TIMEOUT_MS,
      dev_writes_enabled: DEV_WRITES_ENABLED,
      full_access_score_threshold: FULL_ACCESS_SCORE_THRESHOLD,
      limited_tokens_per_day: LIMITED_TOKENS_PER_DAY,
      abuse_contact: ABUSE_CONTACT,
      now: nowIso(),
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/nodes' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? 'all';
    json(res, 200, {
      schema_version: 1,
      sort: 'rarity_score_desc_then_vram_asc',
      nodes: listPublicNodes({ status }),
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    json(res, 200, {
      schema_version: 1,
      source: 'health_probe_jsonl',
      metrics_path: METRICS_PATH,
      token_usage_path: TOKEN_USAGE_PATH,
      db_path: USE_SQLITE ? DB_PATH : null,
      summaries: listMetricsSummaries(),
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/tokens' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const nodeId = asOptionalString(body.node_id ?? body.nodeId);
    if (!nodeId || !nodes.has(nodeId) || banSets.node_id.has(nodeId)) {
      json(res, 404, { error: 'node not found' }, corsHeaders());
      return;
    }
    // Refuse tokens for banned subjects before they consume any quota.
    const requesterIp = clientIpFromReq(req);
    const requestedUserId = asOptionalString(body.user_id ?? body.userId, 'anonymous');
    try {
      assertNotBanned({ user_id: requestedUserId, ip: requesterIp, node_id: nodeId, kind: 'token issuance' });
    } catch (error) {
      json(res, error.statusCode ?? 403, { error: String(error.message), ban: error.ban ?? null }, corsHeaders());
      return;
    }
    const ipRate = assertIpTokenRate(req);
    const status = contributionStatus({
      userId: requestedUserId,
      contributionScore: body.contribution_score ?? body.contributionScore ?? 0,
    });
    const quota = assertTokenQuota(status);
    await upsertContributionState(status);
    const node = nodes.get(nodeId);
    const userPublicKey = asOptionalString(body.user_public_key ?? body.userPublicKey);
    const nodePublicKey = node?.node_public_key || asOptionalString(body.node_public_key ?? body.nodePublicKey);
    const requestedCryptoMode = asOptionalString(body.crypto_mode ?? body.cryptoMode);
    let cryptoMode;
    if (requestedCryptoMode) {
      if (!['plain', 'public-key', 'session-secret'].includes(requestedCryptoMode)) {
        json(res, 400, { error: `unsupported crypto_mode: ${requestedCryptoMode}` }, corsHeaders());
        return;
      }
      cryptoMode = requestedCryptoMode;
    } else if (userPublicKey) {
      cryptoMode = 'public-key';
    } else {
      cryptoMode = 'plain';
    }
    const issued = issueTastingToken({
      secret: TRACKER_SECRET,
      nodeId,
      userId: status.user_id,
      tier: status.tier,
      ttlSec: asOptionalInteger(body.ttl_sec ?? body.ttlSec, 15 * 60),
      userPublicKey: userPublicKey || null,
      nodePublicKey: nodePublicKey || null,
      cryptoMode,
    });
    recordIpTokenUsage(ipRate);
    await appendTokenUsage({
      user_id: status.user_id,
      node_id: nodeId,
      tier: status.tier,
      token_jti: issued.payload.jti,
      crypto_mode: issued.payload.crypto_mode,
    });
    json(res, 201, {
      schema_version: 1,
      token_type: 'Bearer',
      token: issued.token,
      expires_at: issued.expires_at,
      crypto_mode: issued.payload.crypto_mode,
      session_secret: issued.payload.session_secret ?? null,
      node_public_key: issued.payload.node_public_key ?? nodePublicKey ?? null,
      node_public_key_fingerprint: issued.payload.node_public_key_fingerprint ?? (nodePublicKey ? publicKeyFingerprint(nodePublicKey) : null),
      user_public_key_fingerprint: issued.payload.user_public_key_fingerprint ?? null,
      contribution: status,
      quota,
      rate_limit: ipRate,
      node: publicNode(nodes.get(nodeId), computeRarityScores().get(nodeId) ?? 0),
      caveat: issued.payload.crypto_mode === 'public-key'
        ? 'subtext mode (public-key): prompt is encrypted for node key and response is encrypted for user key. Tracker still signs and transports public keys.'
        : issued.payload.crypto_mode === 'session-secret'
          ? 'Legacy subtext mode (session-secret): kept for backwards compatibility. Prefer public-key subtext or plain mode.'
          : 'plain mode (default baseline): OpenAI-compatible chat completions with real SSE. Privacy relies on TLS and the proxy not logging plaintext. Do not send secrets.',
    }, corsHeaders());
    return;
  }

  const contributionMatch = url.pathname.match(/^\/api\/contribution\/([^/]+)$/);
  if (contributionMatch && req.method === 'GET') {
    const score = url.searchParams.get('score') ?? '0';
    json(res, 200, { schema_version: 1, contribution: contributionStatus({ userId: contributionMatch[1], contributionScore: score }) }, corsHeaders());
    return;
  }


  if (url.pathname === '/api/contributions' && req.method === 'GET') {
    json(res, 200, {
      schema_version: 1,
      threshold: FULL_ACCESS_SCORE_THRESHOLD,
      scores: [...computeNodeContributionScores().values()].sort((a, b) => b.total - a.total),
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/showcase' && req.method === 'GET') {
    const showcase = computeShowcases();
    json(res, 200, {
      schema_version: 1,
      categories: showcase.categories,
      nodes: showcase.categories.map((entry) => publicNode(nodes.get(entry.node_id), computeRarityScores().get(entry.node_id) ?? 0)),
    }, corsHeaders());
    return;
  }


  if (url.pathname === '/api/fingerprint/verify' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const nodeId = asOptionalString(body.node_id ?? body.nodeId);
    const node = nodes.get(nodeId);
    if (!node) {
      json(res, 404, { error: 'node not found' }, corsHeaders());
      return;
    }
    const fingerprintUrl = asOptionalString(body.url ?? body.fingerprint_url ?? body.fingerprintUrl, node.fingerprint_url);
    if (!fingerprintUrl) {
      json(res, 400, { error: 'fingerprint url is required' }, corsHeaders());
      return;
    }
    const expected = nodePublicKeyFingerprint(node);
    const result = await verifyFingerprintUrl({ expected, url: fingerprintUrl });
    json(res, 200, { schema_version: 1, node_id: nodeId, url: fingerprintUrl, ...result }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/replay/timing' && req.method === 'POST') {
    let raw;
    try {
      raw = await readJsonBody(req, TIMING_MAX_BYTES);
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
      return;
    }
    let sample;
    try {
      sample = validateTimingPayload(raw);
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
      return;
    }
    // Ban check: a banned user or IP must not be able to write into the
    // aggregate the tracker publishes to everyone else.
    try {
      assertNotBanned({ user_id: sample.user_id, ip: clientIpFromReq(req), node_id: sample.node_id, kind: 'timing upload' });
    } catch (error) {
      json(res, error.statusCode ?? 403, { error: String(error.message), ban: error.ban ?? null }, corsHeaders());
      return;
    }
    await appendTimingSample(sample);
    json(res, 201, {
      ok: true,
      schema_version: 1,
      node_id: sample.node_id,
      stored_at: sample.stored_at,
      community_timing: getCommunityTiming(sample.node_id),
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/abuse-contact' && req.method === 'GET') {
    json(res, 200, { schema_version: 1, contact: ABUSE_CONTACT }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/abuse/report' && req.method === 'POST') {
    let raw;
    try {
      raw = await readJsonBody(req, ABUSE_REPORT_MAX_BYTES);
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
      return;
    }
    let rate;
    try {
      rate = assertAbuseReportIpRate(req);
    } catch (error) {
      json(res, error.statusCode ?? 429, { error: String(error.message) }, corsHeaders());
      return;
    }
    let report;
    try {
      report = normalizeAbuseReport(raw, { ip: rate.ip });
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
      return;
    }
    await appendAbuseReport(report);
    recordAbuseReportIpUsage(rate);
    json(res, 202, {
      ok: true,
      schema_version: 1,
      report_id: report.report_id,
      stored_at: report.created_at,
      contact: ABUSE_CONTACT,
      note: 'Report queued for human review. No automatic ban or content takedown is performed.',
    }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/bans' && req.method === 'GET') {
    if (!DEV_WRITES_ENABLED) {
      json(res, 403, { error: 'GET /api/bans is dev-only (set LUCKRIG_DEV=1)' }, corsHeaders());
      return;
    }
    json(res, 200, { schema_version: 1, bans: listBans() }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/bans' && req.method === 'POST') {
    if (!DEV_WRITES_ENABLED) {
      json(res, 403, { error: 'POST /api/bans is dev-only (set LUCKRIG_DEV=1)' }, corsHeaders());
      return;
    }
    let raw;
    try {
      raw = await readJsonBody(req);
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
      return;
    }
    try {
      const entry = await appendBan({
        kind: typeof raw.kind === 'string' ? raw.kind : '',
        value: typeof raw.value === 'string' ? raw.value : '',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : null,
      });
      json(res, 201, { schema_version: 1, ban: entry }, corsHeaders());
    } catch (error) {
      json(res, error?.statusCode ?? 400, { error: String(error?.message ?? error) }, corsHeaders());
    }
    return;
  }

  const metricsMatch = url.pathname.match(/^\/api\/metrics\/([^/]+)$/);
  if (metricsMatch && req.method === 'GET') {
    const id = metricsMatch[1];
    if (!nodes.has(id)) {
      json(res, 404, { error: 'node not found' }, corsHeaders());
      return;
    }
    json(res, 200, { schema_version: 1, summary: getMetricsSummary(id) }, corsHeaders());
    return;
  }

  const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
  if (nodeMatch && req.method === 'GET') {
    const id = nodeMatch[1];
    const node = nodes.get(id);
    if (!node || banSets.node_id.has(id)) {
      json(res, 404, { error: 'node not found' }, corsHeaders());
      return;
    }
    const score = computeRarityScores().get(id) ?? 0;
    json(res, 200, { schema_version: 1, node: publicNode(node, score) }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/nodes' && req.method === 'POST') {
    if (!DEV_WRITES_ENABLED) {
      json(res, 403, {
        error: 'node registration is disabled in this prototype unless LUCKRIG_DEV=1 is set',
      }, corsHeaders());
      return;
    }
    const body = await readJsonBody(req);
    const node = normalizeNode(body, nodes.get(slugifyId(body.id)));
    const isNew = !nodes.has(node.id);
    nodes.set(node.id, node);
    await probeNode(node);
    await saveRegistry();
    json(res, isNew ? 201 : 200, { schema_version: 1, node: publicNode(node, computeRarityScores().get(node.id) ?? 0) }, corsHeaders());
    return;
  }

  if (url.pathname === '/api/probe' && req.method === 'POST') {
    if (!DEV_WRITES_ENABLED) {
      json(res, 403, { error: 'manual probe is disabled unless LUCKRIG_DEV=1 is set' }, corsHeaders());
      return;
    }
    await probeAllNodes();
    json(res, 200, { schema_version: 1, nodes: listPublicNodes() }, corsHeaders());
    return;
  }

  json(res, 404, { error: 'not found' }, corsHeaders());
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const statusCode = error?.statusCode ?? 500;
    json(res, statusCode, { error: String(error?.message ?? error) }, corsHeaders());
  }
}

async function main() {
  await loadRegistry();
  await loadMetrics();
  await loadTokenUsage();
  await loadTiming();
  await loadBans();
  setInterval(() => { pruneTokenUsageMap(); pruneIpUsageMap(); }, 60 * 60 * 1000).unref();
  await probeAllNodes();
  setInterval(() => {
    probeAllNodes().catch((error) => {
      console.error('[tracker] health probe failed', error);
    });
  }, HEALTH_INTERVAL_MS).unref();

  const server = http.createServer(handleRequest);
  server.on('error', (error) => {
    console.error('[tracker] listen failed', error);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`[tracker] listening on http://${HOST}:${PORT}`);
    console.log(`[tracker] registry=${REGISTRY_PATH}`);
    console.log(`[tracker] metrics=${METRICS_PATH}`);
    console.log(`[tracker] nodes=${nodes.size} health_interval=${HEALTH_INTERVAL_MS}ms`);
    if (!DEV_WRITES_ENABLED) {
      console.log('[tracker] dev write APIs disabled (set LUCKRIG_DEV=1 to enable POST /api/nodes)');
    }
  });
}

export {
  METRICS_PATH,
  TOKEN_USAGE_PATH,
  TIMING_PATH,
  BANS_PATH,
  ABUSE_REPORTS_PATH,
  ABUSE_CONTACT,
  ABUSE_REPORT_IP_LIMIT_PER_DAY,
  DB_PATH,
  REGISTRY_PATH,
  computeNodeContributionScores,
  computeShowcases,
  contributionStatus,
  handleRequest,
  getTokenUsage,
  pruneTokenUsageMap,
  tokenUsageDaily,
  tokenUsageEvents,
  TOKEN_USAGE_RETENTION_DAYS,
  TOKEN_IP_LIMIT_PER_DAY,
  tokenIpUsageDaily,
  pruneIpUsageMap,
  verifyFingerprintUrl,
  listMetricsSummaries,
  listPublicNodes,
  loadMetrics,
  loadTokenUsage,
  loadTiming,
  appendTimingSample,
  validateTimingPayload,
  getCommunityTiming,
  timingByNode,
  loadBans,
  appendBan,
  listBans,
  checkBan,
  banSets,
  abuseReportIpUsageDaily,
  normalizeAbuseReport,
  loadRegistry,
  normalizeNode,
  probeAllNodes,
};

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error('[tracker] fatal', error);
    process.exitCode = 1;
  });
}
