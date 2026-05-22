import { readFile } from 'node:fs/promises';

async function main() {
  process.env.LUCKRIG_HEALTH_TIMEOUT_MS = process.env.LUCKRIG_HEALTH_TIMEOUT_MS ?? '200';
  process.env.LUCKRIG_HEALTH_INTERVAL_MS = process.env.LUCKRIG_HEALTH_INTERVAL_MS ?? '60000';

  const tracker = await import('../src/tracker/server.js');
  await tracker.loadRegistry();
  await tracker.probeAllNodes();

  const nodes = tracker.listPublicNodes();
  if (!Array.isArray(nodes) || nodes.length < 3) {
    throw new Error(`expected at least 3 seed nodes, got ${nodes.length}`);
  }

  const rpi = nodes.find((node) => node.id === 'showcase-rpi5-llama32-1b');
  if (!rpi) throw new Error('expected Raspberry Pi showcase seed node');
  if (nodes[0].rarity_score < nodes.at(-1).rarity_score) {
    throw new Error('node list is not sorted by rarity score descending');
  }

  for (const node of nodes) {
    if (!node.health || !['available', 'unavailable', 'unknown'].includes(node.health.status)) {
      throw new Error(`invalid health state for ${node.id}`);
    }
  }

  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  if (!html.includes('luckrig tracker prototype')) {
    throw new Error('index page did not include expected marker');
  }

  console.log('[smoke] ok');
  console.log(`[smoke] registry=${tracker.REGISTRY_PATH}`);
  console.log(`[smoke] nodes=${nodes.length}`);
}

main().catch((error) => {
  console.error('[smoke] failed', error);
  process.exitCode = 1;
});
