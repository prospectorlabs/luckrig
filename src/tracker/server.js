import http from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number.parseInt(process.env.LUCKRIG_PORT ?? '8787', 10);
const HOST = process.env.LUCKRIG_HOST ?? '127.0.0.1';
const REGISTRY_PATH = path.resolve(ROOT, process.env.LUCKRIG_REGISTRY_PATH ?? 'data/nodes.seed.json');
const HEALTH_INTERVAL_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_INTERVAL_MS ?? '30000', 10);
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '2000', 10);
const DEV_WRITES_ENABLED = process.env.LUCKRIG_DEV === '1';

/** @type {Map<string, import('./types.js').NodeRecord>} */
const nodes = new Map();

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

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

function publicNode(node, rarityScore) {
  return {
    id: node.id,
    display_name: node.display_name,
    endpoint_url: node.endpoint_url,
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
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`registry must be an array: ${REGISTRY_PATH}`);
  nodes.clear();
  for (const entry of parsed) {
    const node = normalizeNode(entry);
    nodes.set(node.id, node);
  }
}

async function saveRegistry() {
  const records = [...nodes.values()].map(({ health: _health, ...node }) => node);
  await writeFile(REGISTRY_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

async function probeNode(node) {
  const started = performance.now();
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
    node.health = {
      status: 'available',
      last_checked_at: nowIso(),
      last_seen_at: nowIso(),
      latency_ms: latencyMs,
      consecutive_failures: 0,
      last_error: null,
    };
  } catch (error) {
    const failures = (node.health?.consecutive_failures ?? 0) + 1;
    node.health = {
      status: failures >= 1 ? 'unavailable' : 'unknown',
      last_checked_at: nowIso(),
      last_seen_at: node.health?.last_seen_at ?? null,
      latency_ms: null,
      consecutive_failures: failures,
      last_error: error?.name === 'AbortError' ? `timeout after ${HEALTH_TIMEOUT_MS}ms` : String(error?.message ?? error),
    };
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
      node_count: nodes.size,
      health_interval_ms: HEALTH_INTERVAL_MS,
      health_timeout_ms: HEALTH_TIMEOUT_MS,
      dev_writes_enabled: DEV_WRITES_ENABLED,
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
    console.log(`[tracker] nodes=${nodes.size} health_interval=${HEALTH_INTERVAL_MS}ms`);
    if (!DEV_WRITES_ENABLED) {
      console.log('[tracker] dev write APIs disabled (set LUCKRIG_DEV=1 to enable POST /api/nodes)');
    }
  });
}

export {
  REGISTRY_PATH,
  handleRequest,
  listPublicNodes,
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
