const nodesEl = document.querySelector('#nodes');
const summaryEl = document.querySelector('#summary');
const refreshButton = document.querySelector('#refresh');
const statusFilter = document.querySelector('#status-filter');
const template = document.querySelector('#node-card-template');

const statusLabels = {
  available: 'available',
  unavailable: 'unavailable',
  unknown: 'unknown',
};

function formatValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  return `${value}${suffix}`;
}

function formatDate(value) {
  if (!value) return '未確認';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function renderSummary(nodes) {
  const counts = nodes.reduce((acc, node) => {
    acc[node.health.status] = (acc[node.health.status] ?? 0) + 1;
    return acc;
  }, {});
  summaryEl.innerHTML = `
    <div><strong>${nodes.length}</strong><span>listed nodes</span></div>
    <div><strong>${counts.available ?? 0}</strong><span>available</span></div>
    <div><strong>${counts.unavailable ?? 0}</strong><span>unavailable</span></div>
    <div><strong>${counts.unknown ?? 0}</strong><span>unknown</span></div>
  `;
}

function renderNode(node) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector('.node-card');
  const status = node.health.status ?? 'unknown';

  card.dataset.status = status;
  fragment.querySelector('h2').textContent = node.display_name;

  const pill = fragment.querySelector('.status-pill');
  pill.textContent = statusLabels[status] ?? status;
  pill.dataset.status = status;

  fragment.querySelector('.rarity').textContent = `scarcity ${node.rarity_score.toFixed(2)}`;
  fragment.querySelector('[data-field="model_name"]').textContent = node.model_name;
  fragment.querySelector('[data-field="quantization"]').textContent = node.quantization;
  fragment.querySelector('[data-field="lora"]').textContent = formatValue(node.lora);
  fragment.querySelector('[data-field="gpu"]').textContent = node.gpu;
  fragment.querySelector('[data-field="vram_gb"]').textContent = node.vram_gb === 0 ? 'shared / CPU' : formatValue(node.vram_gb, 'GB');
  fragment.querySelector('[data-field="context_length"]').textContent = formatValue(node.context_length);

  fragment.querySelector('.availability').textContent = node.availability_note || '稼働時間メモなし';
  fragment.querySelector('.note').textContent = node.tuning_note || 'チューニングノートなし';

  const tags = fragment.querySelector('.tags');
  tags.replaceChildren(...node.tags.map((tag) => {
    const span = document.createElement('span');
    span.textContent = tag;
    return span;
  }));

  const health = node.health;
  fragment.querySelector('.health').innerHTML = `
    <span>last check: ${formatDate(health.last_checked_at)}</span>
    <span>latency: ${formatValue(health.latency_ms, 'ms')}</span>
    ${health.last_error ? `<span class="error">${health.last_error}</span>` : ''}
  `;

  const observations = node.observations ?? {};
  const memory = observations.last_memory;
  const gpu = observations.last_gpu;
  const memoryLabel = memory?.used_mb && memory?.total_mb
    ? `${Math.round(memory.used_mb)} / ${Math.round(memory.total_mb)} MB`
    : '—';
  const gpuLabel = gpu?.utilization_pct !== undefined
    ? `${gpu.utilization_pct}%`
    : '—';
  fragment.querySelector('.observations').innerHTML = `
    <span>samples: ${formatValue(observations.samples_count)}</span>
    <span>availability: ${observations.availability_ratio === null || observations.availability_ratio === undefined ? '—' : `${Math.round(observations.availability_ratio * 100)}%`}</span>
    <span>memory: ${memoryLabel}</span>
    <span>gpu util: ${gpuLabel}</span>
  `;

  return fragment;
}

async function loadNodes() {
  refreshButton.disabled = true;
  refreshButton.textContent = '更新中…';
  try {
    const status = statusFilter.value;
    const res = await fetch(`/api/nodes?status=${encodeURIComponent(status)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderSummary(payload.nodes);
    nodesEl.replaceChildren(...payload.nodes.map(renderNode));
    if (payload.nodes.length === 0) {
      nodesEl.innerHTML = '<p class="empty">該当するノードはありません。</p>';
    }
  } catch (error) {
    nodesEl.innerHTML = `<p class="empty error">failed to load nodes: ${error.message}</p>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = '更新';
  }
}

refreshButton.addEventListener('click', loadNodes);
statusFilter.addEventListener('change', loadNodes);
loadNodes();
setInterval(loadNodes, 30_000);
