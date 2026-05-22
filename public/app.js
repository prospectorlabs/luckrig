const nodesEl = document.querySelector('#nodes');
const summaryEl = document.querySelector('#summary');
const refreshButton = document.querySelector('#refresh');
const statusFilter = document.querySelector('#status-filter');
const modelFilter = document.querySelector('#model-filter');
const gpuFilter = document.querySelector('#gpu-filter');
const minVramFilter = document.querySelector('#min-vram-filter');
const compareEl = document.querySelector('#compare');
const template = document.querySelector('#node-card-template');

let allNodes = [];

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


async function copyText(text) {
  if (!text || text === '—') return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  return ok;
}

function base64urlEncode(bytes) {
  const binary = [...new Uint8Array(bytes)].map((byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function utf8Encode(value) {
  return new TextEncoder().encode(value);
}

function utf8Decode(value) {
  return new TextDecoder().decode(value);
}

async function importAesKey(sessionSecret) {
  const keyBytes = base64urlDecode(sessionSecret);
  if (keyBytes.byteLength !== 32) throw new Error('session secret must decode to 32 bytes');
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptJsonToSubtextBrowser(value, { sessionSecret, coverText = 'luckrig prompt payload' } = {}) {
  const key = await importAesKey(sessionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Encode(JSON.stringify(value))));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  const envelope = {
    v: 1,
    alg: 'AES-256-GCM',
    iv: base64urlEncode(iv),
    tag: base64urlEncode(tag),
    ciphertext: base64urlEncode(ciphertext),
  };
  return bytesToSubtextBrowser(utf8Encode(JSON.stringify(envelope)), coverText);
}

async function decryptJsonFromSubtextBrowser(text, { sessionSecret } = {}) {
  const envelopeBytes = subtextToBytesBrowser(text);
  if (envelopeBytes.byteLength === 0) throw new Error('subtext payload not found');
  const envelope = JSON.parse(utf8Decode(envelopeBytes));
  if (envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') throw new Error('unsupported encrypted envelope');
  const key = await importAesKey(sessionSecret);
  const ciphertext = base64urlDecode(envelope.ciphertext);
  const tag = base64urlDecode(envelope.tag);
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.byteLength);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64urlDecode(envelope.iv) }, key, combined);
  return JSON.parse(utf8Decode(new Uint8Array(plaintext)));
}

function pemToBytes(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function bytesToPem(bytes, label = 'PUBLIC KEY') {
  const b64 = btoa([...new Uint8Array(bytes)].map((byte) => String.fromCharCode(byte)).join(''));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

async function generateBrowserBoxKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicSpki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return {
    publicKeyPem: bytesToPem(publicSpki),
    privateKey: pair.privateKey,
  };
}

async function importX25519PublicKey(pem) {
  return crypto.subtle.importKey('spki', pemToBytes(pem), { name: 'X25519' }, false, []);
}

async function derivePublicKeyAesKey({ privateKey, publicKeyPem, salt, usage }) {
  const publicKey = await importX25519PublicKey(publicKeyPem);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8Encode('luckrig-public-key-envelope-v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

async function encryptJsonToSubtextPublicKeyBrowser(value, { publicKeyPem, coverText = 'luckrig prompt payload' } = {}) {
  const ephemeral = await generateBrowserBoxKeyPair();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePublicKeyAesKey({ privateKey: ephemeral.privateKey, publicKeyPem, salt, usage: ['encrypt'] });
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Encode(JSON.stringify(value))));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  const envelope = {
    v: 1,
    alg: 'X25519-HKDF-SHA256+A256GCM',
    ephemeral_public_key: ephemeral.publicKeyPem,
    salt: base64urlEncode(salt),
    iv: base64urlEncode(iv),
    tag: base64urlEncode(tag),
    ciphertext: base64urlEncode(ciphertext),
  };
  return bytesToSubtextBrowser(utf8Encode(JSON.stringify(envelope)), coverText);
}

async function decryptJsonFromSubtextPublicKeyBrowser(text, { privateKey } = {}) {
  const envelopeBytes = subtextToBytesBrowser(text);
  if (envelopeBytes.byteLength === 0) throw new Error('subtext payload not found');
  const envelope = JSON.parse(utf8Decode(envelopeBytes));
  if (envelope.v !== 1 || envelope.alg !== 'X25519-HKDF-SHA256+A256GCM') throw new Error('unsupported public-key envelope');
  const key = await derivePublicKeyAesKey({
    privateKey,
    publicKeyPem: envelope.ephemeral_public_key,
    salt: base64urlDecode(envelope.salt),
    usage: ['decrypt'],
  });
  const ciphertext = base64urlDecode(envelope.ciphertext);
  const tag = base64urlDecode(envelope.tag);
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.byteLength);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64urlDecode(envelope.iv) }, key, combined);
  return JSON.parse(utf8Decode(new Uint8Array(plaintext)));
}

function bytesToSubtextBrowser(bytes, coverText = 'luckrig tasting payload') {
  const hidden = [...new Uint8Array(bytes)].flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCodePoint(0xfe00 + nibble))
    .join('');
  return `${coverText}${hidden}`;
}

function subtextToBytesBrowser(text) {
  const nibbles = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code >= 0xfe00 && code <= 0xfe0f) nibbles.push(code - 0xfe00);
  }
  if (nibbles.length === 0) return new Uint8Array(0);
  if (nibbles.length % 2 !== 0) throw new Error('invalid subtext nibble length');
  const bytes = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < nibbles.length; i += 2) bytes[i / 2] = (nibbles[i] << 4) | nibbles[i + 1];
  return bytes;
}

function parseSseText(text) {
  const events = [];
  let encryptedContent = '';
  const chunk_timestamps = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice('data: '.length).trim();
    if (!data || data === '[DONE]') continue;
    const parsed = JSON.parse(data);
    events.push(parsed);
    const content = parsed?.choices?.[0]?.delta?.content;
    if (typeof content === 'string') {
      encryptedContent += content;
      chunk_timestamps.push(Date.now());
    }
  }
  return { events, encryptedContent, chunk_timestamps };
}

function tokenizerFamily(modelName = '') {
  const name = String(modelName).toLowerCase();
  if (name.includes('qwen')) return 'qwen';
  if (name.includes('llama')) return 'llama';
  if (name.includes('gpt')) return 'gpt';
  return 'generic';
}

function estimateTokens(text, { modelName = '' } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return { tokens: 0, tokenizer: 'luckrig-heuristic-v1', model_family: tokenizerFamily(modelName) };
  const family = tokenizerFamily(modelName);
  const cjk = (value.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const words = (value.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)?/g) ?? [])
    .reduce((sum, word) => sum + Math.max(1, Math.ceil(word.length / (family === 'qwen' ? 3.6 : family === 'llama' ? 3.8 : 4.0))), 0);
  const punct = (value.match(/[.,!?;:()[\]{}<>"'`~@#$%^&*+=|\/\-、。！？：；「」『』（）]/g) ?? []).length;
  return { tokens: Math.max(1, cjk + words + punct), tokenizer: 'luckrig-heuristic-v1', model_family: family };
}

function buildReplayRecordBrowser(envelope, { chunk_timestamps = [], ttft_ms = null } = {}) {
  const tokenEstimate = estimateTokens(envelope.response, { modelName: envelope.model_name });
  const outputTokens = tokenEstimate.tokens;
  const tokPerSec = envelope.generation_sec > 0 ? Number((outputTokens / envelope.generation_sec).toFixed(3)) : null;
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    prompt: envelope.prompt?.prompt ?? envelope.prompt,
    response: envelope.response,
    node_id: envelope.node_id,
    queue_wait_sec: envelope.queue_wait_sec ?? 0,
    generation_sec: envelope.generation_sec ?? 0,
    tok_per_sec: tokPerSec,
    output_tokens: outputTokens,
    tokenizer: tokenEstimate.tokenizer,
    tokenizer_model_family: tokenEstimate.model_family,
    ttft_ms: envelope.proxy_ttft_ms ?? ttft_ms,
    network_ttft_ms: ttft_ms,
    proxy_ttft_ms: envelope.proxy_ttft_ms ?? null,
    chunk_timestamps,
    limited_output_truncated: envelope.limited_output_truncated ?? false,
  };
}

function replayFilename(record) {
  const stamp = new Date(record.created_at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const node = String(record.node_id ?? 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${stamp}_${node}.json`;
}

async function runBrowserTasting(node, fragment) {
  const status = fragment.querySelector('.tasting-status');
  const output = fragment.querySelector('.tasting-output');
  const download = fragment.querySelector('.replay-download');
  const trust = fragment.querySelector('.tasting-trust');
  const prompt = fragment.querySelector('.tasting-prompt').value.trim();
  const proxyUrl = fragment.querySelector('.tasting-proxy-url').value.trim().replace(/\/$/, '');
  const userId = fragment.querySelector('.tasting-user-id').value.trim() || 'browser-poc';
  const contributionScore = Number(fragment.querySelector('.tasting-score').value || 0);
  const fingerprintConfirm = fragment.querySelector('.fingerprint-confirm').value.trim();
  const hasNodePublicKey = Boolean(node.node_public_key && node.node_public_key_fingerprint);

  output.hidden = true;
  download.hidden = true;
  if (!trust.checked) throw new Error('trust model checkbox is required');
  if (hasNodePublicKey && fingerprintConfirm !== node.node_public_key_fingerprint) {
    throw new Error('node public key fingerprint confirmation does not match');
  }
  if (!prompt) throw new Error('prompt is required');
  if (!proxyUrl) throw new Error('proxy URL is required');

  status.textContent = 'preparing browser key...';
  let browserKeys = null;
  if (hasNodePublicKey) {
    browserKeys = await generateBrowserBoxKeyPair();
  }

  status.textContent = 'requesting token...';
  const tokenRequest = {
    node_id: node.id,
    user_id: userId,
    contribution_score: contributionScore,
    ttl_sec: 300,
    ...(browserKeys ? { user_public_key: browserKeys.publicKeyPem, node_public_key: node.node_public_key } : {}),
  };
  const tokenRes = await fetch('/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tokenRequest),
  });
  const tokenPayload = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokenPayload.error ?? `token HTTP ${tokenRes.status}`);

  status.textContent = 'encrypting prompt...';
  const encryptedPrompt = tokenPayload.crypto_mode === 'public-key'
    ? await encryptJsonToSubtextPublicKeyBrowser({ prompt }, { publicKeyPem: tokenPayload.node_public_key })
    : await encryptJsonToSubtextBrowser({ prompt }, { sessionSecret: tokenPayload.session_secret });
  const chatBody = {
    model: node.model_name || 'luckrig-browser-poc',
    stream: true,
    messages: [{ role: 'user', content: encryptedPrompt }],
  };

  status.textContent = 'waiting for proxy / pseudo SSE...';
  const started = performance.now();
  const proxyRes = await fetch(`${proxyUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenPayload.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(chatBody),
  });
  const sseText = await proxyRes.text();
  if (!proxyRes.ok) throw new Error(sseText || `proxy HTTP ${proxyRes.status}`);

  status.textContent = 'decrypting response...';
  const { encryptedContent, chunk_timestamps } = parseSseText(sseText);
  const envelope = tokenPayload.crypto_mode === 'public-key'
    ? await decryptJsonFromSubtextPublicKeyBrowser(encryptedContent, { privateKey: browserKeys.privateKey })
    : await decryptJsonFromSubtextBrowser(encryptedContent, { sessionSecret: tokenPayload.session_secret });
  const replay = buildReplayRecordBrowser(envelope, { chunk_timestamps, ttft_ms: Math.round(performance.now() - started) });

  output.hidden = false;
  output.textContent = replay.response;
  const blob = new Blob([`${JSON.stringify(replay, null, 2)}\n`], { type: 'application/json' });
  if (download.href) URL.revokeObjectURL(download.href);
  download.href = URL.createObjectURL(blob);
  download.download = replayFilename(replay);
  download.hidden = false;
  download.textContent = `download replay JSON (${download.download})`;
  status.textContent = `done: ${replay.tok_per_sec ?? '—'} tok/s, crypto=${tokenPayload.crypto_mode}, truncated=${replay.limited_output_truncated}`;
}


function includesIgnoreCase(value, needle) {
  if (!needle) return true;
  return String(value ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

function applyClientFilters(nodes) {
  const model = modelFilter.value.trim();
  const gpu = gpuFilter.value.trim();
  const minVram = minVramFilter.value === '' ? null : Number(minVramFilter.value);
  return nodes.filter((node) => {
    if (!includesIgnoreCase(node.model_name, model)) return false;
    if (!includesIgnoreCase(node.gpu, gpu)) return false;
    if (Number.isFinite(minVram) && (node.vram_gb ?? 0) < minVram) return false;
    return true;
  });
}

function renderCompare(nodes) {
  const rows = nodes.slice(0, 8);
  if (rows.length === 0) {
    compareEl.innerHTML = '';
    return;
  }
  compareEl.innerHTML = `
    <h2>visible rigs comparison</h2>
    <div class="compare-table-wrap">
      <table>
        <thead><tr><th>model</th><th>GPU</th><th>VRAM</th><th>ctx</th><th>status</th><th>queue</th><th>availability</th></tr></thead>
        <tbody>
          ${rows.map((node) => {
            const q = node.observations?.last_queue;
            const queue = q ? `${formatValue(q.active)} active / ${formatValue(q.depth)} wait` : '—';
            return `<tr>
              <td>${node.model_name}</td>
              <td>${node.gpu}</td>
              <td>${node.vram_gb === 0 ? 'shared / CPU' : formatValue(node.vram_gb, 'GB')}</td>
              <td>${formatValue(node.context_length)}</td>
              <td>${node.health?.status ?? 'unknown'}</td>
              <td>${queue}</td>
              <td>${node.observations?.availability_ratio === null || node.observations?.availability_ratio === undefined ? '—' : `${Math.round(node.observations.availability_ratio * 100)}%`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderVisibleNodes() {
  const visible = applyClientFilters(allNodes);
  renderSummary(visible);
  renderCompare(visible);
  nodesEl.replaceChildren(...visible.map(renderNode));
  if (visible.length === 0) {
    nodesEl.innerHTML = '<p class="empty">該当するノードはありません。</p>';
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

  const fingerprint = node.node_public_key_fingerprint || '—';
  const fingerprintPanel = fragment.querySelector('.fingerprint-panel');
  const fingerprintValue = fragment.querySelector('.fingerprint-value');
  const fingerprintHelp = fragment.querySelector('.fingerprint-help');
  const copyButton = fragment.querySelector('.copy-fingerprint');
  fingerprintValue.textContent = fingerprint;
  if (fingerprint === '—') {
    fingerprintPanel.dataset.state = 'missing';
    fingerprintHelp.textContent = 'public-key tasting unavailable until this node registers a key';
    copyButton.disabled = true;
  } else {
    fingerprintPanel.dataset.state = 'present';
    fingerprintHelp.textContent = 'verify out-of-band before tasting';
    copyButton.addEventListener('click', async () => {
      const original = copyButton.textContent;
      try {
        await copyText(fingerprint);
        copyButton.textContent = 'copied';
      } catch {
        copyButton.textContent = 'copy failed';
      } finally {
        setTimeout(() => { copyButton.textContent = original; }, 1200);
      }
    });
  }

  const health = node.health;
  fragment.querySelector('.health').innerHTML = `
    <span>last check: ${formatDate(health.last_checked_at)}</span>
    <span>latency: ${formatValue(health.latency_ms, 'ms')}</span>
    ${health.last_error ? `<span class="error">${health.last_error}</span>` : ''}
  `;

  const observations = node.observations ?? {};
  const memory = observations.last_memory;
  const gpu = observations.last_gpu;
  const queue = observations.last_queue;
  const queueLabel = queue ? `${formatValue(queue.active)} active / ${formatValue(queue.depth)} wait` : '—';
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
    <span>queue: ${queueLabel}</span>
  `;

  fragment.querySelector('.tasting-proxy-url').value = node.endpoint_url ?? '';
  const runButton = fragment.querySelector('.run-tasting');
  const tastingStatus = fragment.querySelector('.tasting-status');
  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    tastingStatus.textContent = 'starting...';
    try {
      await runBrowserTasting(node, fragment);
    } catch (error) {
      tastingStatus.textContent = `error: ${error.message}`;
    } finally {
      runButton.disabled = false;
    }
  });

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
    allNodes = payload.nodes;
    renderVisibleNodes();
  } catch (error) {
    nodesEl.innerHTML = `<p class="empty error">failed to load nodes: ${error.message}</p>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = '更新';
  }
}

refreshButton.addEventListener('click', loadNodes);
statusFilter.addEventListener('change', loadNodes);
modelFilter.addEventListener('input', renderVisibleNodes);
gpuFilter.addEventListener('input', renderVisibleNodes);
minVramFilter.addEventListener('input', renderVisibleNodes);
loadNodes();
setInterval(loadNodes, 30_000);
