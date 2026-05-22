import http from 'node:http';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const DB_PATH = path.resolve(ROOT, process.env.LUCKRIG_DB_PATH ?? 'data/luckrig.sqlite');
const USE_SQLITE = process.env.LUCKRIG_USE_SQLITE !== '0';
const HEALTH_INTERVAL_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_INTERVAL_MS ?? '30000', 10);
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '2000', 10);
const DEV_WRITES_ENABLED = process.env.LUCKRIG_DEV === '1';
const TRACKER_SECRET = process.env.LUCKRIG_TRACKER_SECRET ?? 'luckrig-dev-secret-change-me';
const FULL_ACCESS_SCORE_THRESHOLD = Number.parseInt(process.env.LUCKRIG_FULL_ACCESS_SCORE_THRESHOLD ?? '1', 10);
const LIMITED_TOKENS_PER_DAY = Number.parseInt(process.env.LUCKRIG_LIMITED_TOKENS_PER_DAY ?? '5', 10);
const TOKEN_USAGE_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.LUCKRIG_TOKEN_USAGE_RETENTION_DAYS ?? '7', 10));

/** @type {Map<string, import('./types.js').NodeRecord>} */
const nodes = new Map();

/** @type {Map<string, import('./types.js').MetricsSummary>} */
const metricsSummaries = new Map();

/** @type {Map<string, number>} */
const tokenUsageDaily = new Map();

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
  return removed;
}

function getTokenUsage({ userId, tier = 'limited', day = dayKey() } = {}) {
  return tokenUsageDaily.get(tokenUsageKey({ userId, tier, day })) ?? 0;
}

async function loadTokenUsage() {
  tokenUsageDaily.clear();
  // best-effort pruning after rebuilding the map
  const dbEvents = await loadTokenUsageFromDb();
  if (dbEvents.length > 0) {
    for (const event of dbEvents) {
      const key = tokenUsageKey({ userId: event.user_id, tier: event.tier, day: event.day });
      tokenUsageDaily.set(key, (tokenUsageDaily.get(key) ?? 0) + 1);
    }
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
  return {
    id: node.id,
    display_name: node.display_name,
    endpoint_url: node.endpoint_url,
    node_public_key: node.node_public_key || null,
    node_public_key_fingerprint: nodePublicKeyFingerprint(node),
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
    health: node.health,
    observations: getMetricsSummary(node.id),
  };
}

function listPublicNodes({ status } = {}) {
  const scores = computeRarityScores();
  let list = [...nodes.values()].map((node) => publicNode(node, scores.get(node.id) ?? 0));

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
    if (!nodeId || !nodes.has(nodeId)) {
      json(res, 404, { error: 'node not found' }, corsHeaders());
      return;
    }
    const status = contributionStatus({
      userId: asOptionalString(body.user_id ?? body.userId, 'anonymous'),
      contributionScore: body.contribution_score ?? body.contributionScore ?? 0,
    });
    const quota = assertTokenQuota(status);
    await upsertContributionState(status);
    const node = nodes.get(nodeId);
    const userPublicKey = asOptionalString(body.user_public_key ?? body.userPublicKey);
    const nodePublicKey = node?.node_public_key || asOptionalString(body.node_public_key ?? body.nodePublicKey);
    const issued = issueTastingToken({
      secret: TRACKER_SECRET,
      nodeId,
      userId: status.user_id,
      tier: status.tier,
      ttlSec: asOptionalInteger(body.ttl_sec ?? body.ttlSec, 15 * 60),
      userPublicKey: userPublicKey || null,
      nodePublicKey: nodePublicKey || null,
    });
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
      node: publicNode(nodes.get(nodeId), computeRarityScores().get(nodeId) ?? 0),
      caveat: issued.payload.crypto_mode === 'public-key'
        ? 'Public-key POC mode: prompt is encrypted for node key and response is encrypted for user key. Tracker still signs and transports public keys.'
        : 'Legacy POC token carries a session secret for local E2E testing. Prefer user_public_key + node_public_key public-key mode.',
    }, corsHeaders());
    return;
  }

  const contributionMatch = url.pathname.match(/^\/api\/contribution\/([^/]+)$/);
  if (contributionMatch && req.method === 'GET') {
    const score = url.searchParams.get('score') ?? '0';
    json(res, 200, { schema_version: 1, contribution: contributionStatus({ userId: contributionMatch[1], contributionScore: score }) }, corsHeaders());
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
    if (!node) {
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
  setInterval(() => pruneTokenUsageMap(), 60 * 60 * 1000).unref();
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
  DB_PATH,
  REGISTRY_PATH,
  contributionStatus,
  handleRequest,
  getTokenUsage,
  pruneTokenUsageMap,
  tokenUsageDaily,
  TOKEN_USAGE_RETENTION_DAYS,
  listMetricsSummaries,
  listPublicNodes,
  loadMetrics,
  loadTokenUsage,
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
