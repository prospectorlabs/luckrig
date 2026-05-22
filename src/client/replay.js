import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decryptJsonFromSubtext } from '../subtext/index.js';

export const DEFAULT_HISTORY_DIR = path.join(os.homedir(), '.luckrig', 'history');

function safeNodeId(nodeId) {
  return String(nodeId ?? 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'unknown';
}

function timestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function estimateTokens(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  // POC approximation. Real implementation should use the model tokenizer.
  return Math.max(1, Math.ceil(s.length / 4));
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

export function buildReplayRecord({
  prompt,
  response,
  node_id,
  queue_wait_sec = 0,
  generation_sec = 0,
  ttft_ms = null,
  chunk_timestamps = [],
  created_at = new Date().toISOString(),
} = {}) {
  const outputTokens = estimateTokens(response);
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
    ttft_ms,
    chunk_timestamps,
  };
}

export function replayFromEncryptedSseChunks(chunks, { sessionSecret, ttft_ms = null } = {}) {
  const { encryptedContent, chunk_timestamps } = parsePseudoSseChunks(chunks);
  const envelope = decryptJsonFromSubtext(encryptedContent, { sessionSecret });
  return buildReplayRecord({
    prompt: envelope.prompt?.prompt ?? envelope.prompt,
    response: envelope.response,
    node_id: envelope.node_id,
    queue_wait_sec: envelope.queue_wait_sec,
    generation_sec: envelope.generation_sec,
    ttft_ms,
    chunk_timestamps,
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
