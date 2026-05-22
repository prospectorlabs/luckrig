import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decryptJsonFromSubtext, decryptJsonFromSubtextWithPrivateKey } from '../subtext/index.js';
import { estimateTokenCount } from '../shared/tokenizer.js';

export const DEFAULT_HISTORY_DIR = path.join(os.homedir(), '.luckrig', 'history');

function safeNodeId(nodeId) {
  return String(nodeId ?? 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'unknown';
}

function timestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function estimateTokens(text, { modelName } = {}) {
  return estimateTokenCount(text, { modelName });
}

export function parsePseudoSseChunks(chunks) {
  const events = [];
  let encryptedContent = '';
  const timestamps = [];

  for (const chunk of chunks) {
    const now = Date.now();
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice('data: '.length).trim();
      if (!data || data === '[DONE]') continue;
      const parsed = JSON.parse(data);
      events.push(parsed);
      const content = parsed?.choices?.[0]?.delta?.content;
      if (typeof content === 'string') {
        encryptedContent += content;
        timestamps.push(now);
      }
    }
  }

  return { events, encryptedContent, chunk_timestamps: timestamps };
}

export function parsePlainSseChunks(chunks) {
  const events = [];
  let content = '';
  const timestamps = [];
  let timing = null;

  for (const chunk of chunks) {
    const now = Date.now();
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice('data: '.length).trim();
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      events.push(parsed);
      if (parsed?.object === 'luckrig.timing') {
        timing = parsed;
        continue;
      }
      const piece = parsed?.choices?.[0]?.delta?.content;
      if (typeof piece === 'string' && piece.length > 0) {
        content += piece;
        timestamps.push(now);
      }
    }
  }

  return { events, content, chunk_timestamps: timestamps, timing };
}

export function replayFromPlainSseChunks(chunks, {
  prompt = '',
  node_id = 'unknown',
  model_name = '',
  ttft_ms = null,
} = {}) {
  const { content, chunk_timestamps, timing } = parsePlainSseChunks(chunks);
  return buildReplayRecord({
    prompt,
    response: content,
    node_id: timing?.node_id ?? node_id,
    model_name,
    queue_wait_sec: timing?.queue_wait_sec ?? 0,
    generation_sec: timing?.generation_sec ?? 0,
    ttft_ms,
    proxy_ttft_ms: timing?.proxy_ttft_ms ?? null,
    chunk_timestamps,
    limited_output_truncated: timing?.limited_output_truncated ?? false,
  });
}

export function timingPayloadFromReplay(record, { node_id, mode = 'plain', user_id = 'anonymous' } = {}) {
  // Build the strict allowlist payload for opt-in upload. Never include
  // prompt / response body or chunk timestamps.
  return {
    schema_version: 1,
    node_id: node_id ?? record.node_id,
    mode,
    user_id,
    created_at: record.created_at,
    tok_per_sec: record.tok_per_sec,
    ttft_ms: record.ttft_ms ?? null,
    proxy_ttft_ms: record.proxy_ttft_ms ?? null,
    network_ttft_ms: record.network_ttft_ms ?? null,
    generation_sec: record.generation_sec ?? null,
    queue_wait_sec: record.queue_wait_sec ?? null,
    output_tokens: record.output_tokens ?? null,
    tokenizer: record.tokenizer ?? null,
    tokenizer_model_family: record.tokenizer_model_family ?? null,
    limited_output_truncated: record.limited_output_truncated === true,
  };
}

export async function uploadTimingPayload(payload, { trackerUrl, fetchImpl = fetch } = {}) {
  if (!trackerUrl) throw new Error('trackerUrl is required to upload timing payload');
  const url = `${String(trackerUrl).replace(/\/$/, '')}/api/replay/timing`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error ?? `timing upload HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export function buildReplayRecord({
  prompt,
  response,
  node_id,
  queue_wait_sec = 0,
  generation_sec = 0,
  ttft_ms = null,
  chunk_timestamps = [],
  created_at = new Date().toISOString(),
  limited_output_truncated = false,
  model_name = '',
  proxy_ttft_ms = null,
} = {}) {
  const tokenEstimate = estimateTokens(response, { modelName: model_name });
  const outputTokens = tokenEstimate.tokens;
  const tokPerSec = generation_sec > 0 ? Number((outputTokens / generation_sec).toFixed(3)) : null;
  return {
    schema_version: 1,
    created_at,
    prompt,
    response,
    node_id,
    queue_wait_sec,
    generation_sec,
    tok_per_sec: tokPerSec,
    output_tokens: outputTokens,
    tokenizer: tokenEstimate.tokenizer,
    tokenizer_model_family: tokenEstimate.model_family,
    ttft_ms: proxy_ttft_ms ?? ttft_ms,
    network_ttft_ms: ttft_ms,
    proxy_ttft_ms,
    chunk_timestamps,
    limited_output_truncated,
  };
}

export function replayFromEncryptedSseChunks(chunks, { sessionSecret, userPrivateKey, ttft_ms = null } = {}) {
  const { encryptedContent, chunk_timestamps } = parsePseudoSseChunks(chunks);
  const envelope = userPrivateKey
    ? decryptJsonFromSubtextWithPrivateKey(encryptedContent, { privateKey: userPrivateKey })
    : decryptJsonFromSubtext(encryptedContent, { sessionSecret });
  return buildReplayRecord({
    prompt: envelope.prompt?.prompt ?? envelope.prompt,
    response: envelope.response,
    node_id: envelope.node_id,
    model_name: envelope.model_name ?? '',
    queue_wait_sec: envelope.queue_wait_sec,
    generation_sec: envelope.generation_sec,
    ttft_ms,
    proxy_ttft_ms: envelope.proxy_ttft_ms ?? null,
    chunk_timestamps,
    limited_output_truncated: envelope.limited_output_truncated ?? false,
  });
}

export async function saveReplayRecord(record, { historyDir = DEFAULT_HISTORY_DIR, date = new Date() } = {}) {
  await mkdir(historyDir, { recursive: true });
  const filename = `${timestampForFilename(date)}_${safeNodeId(record.node_id)}.json`;
  const filepath = path.join(historyDir, filename);
  await writeFile(filepath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return filepath;
}

export async function loadReplayRecord(filepath) {
  return JSON.parse(await readFile(filepath, 'utf8'));
}
