import { encryptJsonToSubtext, encryptJsonToSubtextForPublicKey } from '../subtext/index.js';
import { replayFromEncryptedSseChunks, replayFromPlainSseChunks } from './replay.js';

export function buildEncryptedChatBody({ prompt, sessionSecret, nodePublicKey, model = 'luckrig-poc', stream = true } = {}) {
  const content = nodePublicKey
    ? encryptJsonToSubtextForPublicKey({ prompt }, { publicKey: nodePublicKey, coverText: 'luckrig prompt payload' })
    : encryptJsonToSubtext({ prompt }, { sessionSecret, coverText: 'luckrig prompt payload' });
  return {
    model,
    stream,
    messages: [
      { role: 'user', content },
    ],
  };
}

export function buildPlainChatBody({ prompt, model = 'luckrig-poc', stream = true } = {}) {
  // Plain (baseline) mode: OpenAI-compatible request shape; no subtext.
  return {
    model,
    stream,
    messages: [
      { role: 'user', content: String(prompt ?? '') },
    ],
  };
}

export function replayFromProxyResult(result, { sessionSecret, userPrivateKey, ttft_ms = 0 } = {}) {
  if (result.kind === 'sse') {
    return replayFromEncryptedSseChunks(result.chunks, { sessionSecret, userPrivateKey, ttft_ms });
  }
  if (result.kind === 'plain-sse') {
    return replayFromPlainSseChunks(result.chunks, {
      prompt: result.prompt?.prompt ?? '',
      node_id: result.response_envelope?.node_id ?? 'unknown',
      model_name: result.response_envelope?.model_name ?? '',
      ttft_ms,
    });
  }
  throw new Error(`proxy result is not SSE-streamed (kind=${result.kind})`);
}
