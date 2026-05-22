import { readFile, stat, unlink } from 'node:fs/promises';

async function main() {
  process.env.LUCKRIG_HEALTH_TIMEOUT_MS = process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '200';
  process.env.LUCKRIG_HEALTH_INTERVAL_MS = process.env.LUCKRIG_HEALTH_INTERVAL_MS ?? '60000';
  process.env.LUCKRIG_METRICS_PATH = process.env.LUCKRIG_METRICS_PATH ?? `/tmp/luckrig-smoke-metrics-${process.pid}.jsonl`;
  process.env.LUCKRIG_TOKEN_USAGE_PATH = process.env.LUCKRIG_TOKEN_USAGE_PATH ?? `/tmp/luckrig-smoke-token-usage-${process.pid}.jsonl`;
  process.env.LUCKRIG_DB_PATH = process.env.LUCKRIG_DB_PATH ?? `/tmp/luckrig-smoke-${process.pid}.sqlite`;

  await unlink(process.env.LUCKRIG_DB_PATH).catch(() => {});

  const tracker = await import('../src/tracker/server.js');
  await tracker.loadRegistry();
  await tracker.loadMetrics();
  await tracker.loadTokenUsage();
  await tracker.probeAllNodes();

  const nodes = tracker.listPublicNodes();
  if (!Array.isArray(nodes) || nodes.length < 3) {
    throw new Error(`expected at least 3 seed nodes, got ${nodes.length}`);
  }

  const rpi = nodes.find((node) => node.id === 'showcase-rpi5-llama32-1b');
  if (!rpi) throw new Error('expected Raspberry Pi showcase seed node');
  const keyedNode = nodes.find((node) => node.node_public_key_fingerprint);
  if (!keyedNode) throw new Error('expected at least one seed node with public key fingerprint');
  if (!keyedNode.node_public_key_fingerprint.startsWith('sha256:')) {
    throw new Error(`invalid fingerprint: ${keyedNode.node_public_key_fingerprint}`);
  }
  if (nodes[0].rarity_score < nodes.at(-1).rarity_score) {
    throw new Error('node list is not sorted by rarity score descending');
  }

  for (const node of nodes) {
    if (!node.health || !['available', 'unavailable', 'unknown'].includes(node.health.status)) {
      throw new Error(`invalid health state for ${node.id}`);
    }
    if (!node.observations || node.observations.samples_count < 1) {
      throw new Error(`expected at least one observation for ${node.id}`);
    }
  }

  const dbInfo = await stat(tracker.DB_PATH);
  if (!dbInfo.isFile() || dbInfo.size === 0) throw new Error('expected sqlite DB file to be created');

  const summaries = tracker.listMetricsSummaries();
  if (summaries.length !== nodes.length) {
    throw new Error(`expected one metrics summary per node, got ${summaries.length}`);
  }

  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  if (!html.includes('luckrig tracker prototype')) {
    throw new Error('index page did not include expected marker');
  }
  if (!html.includes('node public key fingerprint')) {
    throw new Error('index page did not include fingerprint UI marker');
  }
  if (!html.includes('browser POC') || !html.includes('tasting-trust') || !html.includes('fingerprint-confirm') || !html.includes('model-filter') || !html.includes('showcase-badges') || !html.includes('contribution-panel')) {
    throw new Error('index page did not include browser tasting/trust/filter UI markers');
  }
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  if (!app.includes('visible rigs comparison') || !app.includes('queue: ${queueLabel}') || !app.includes('luckrig.browserIdentity.v1')) {
    throw new Error('app did not include comparison/queue UI markers');
  }

  console.log('[smoke] ok');
  console.log(`[smoke] registry=${tracker.REGISTRY_PATH}`);
  console.log(`[smoke] metrics=${tracker.METRICS_PATH}`);
  console.log(`[smoke] nodes=${nodes.length}`);

  if (tracker.METRICS_PATH.startsWith('/tmp/luckrig-smoke-metrics-')) {
    await unlink(tracker.METRICS_PATH).catch(() => {});
    await unlink(tracker.TOKEN_USAGE_PATH).catch(() => {});
    await unlink(tracker.DB_PATH).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[smoke] failed', error);
  process.exitCode = 1;
});
