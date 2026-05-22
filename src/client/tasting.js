import { encryptJsonToSubtext } from '../subtext/index.js';
import { replayFromEncryptedSseChunks } from './replay.js';

export function buildEncryptedChatBody({ prompt, sessionSecret, model = 'luckrig-poc', stream = true } = {}) {
  return {
    model,
    stream,
    messages: [
      { role: 'user', content: encryptJsonToSubtext({ prompt }, { sessionSecret, coverText: 'luckrig prompt payload' }) },
    ],
  };
}

export function replayFromProxyResult(result, { sessionSecret, ttft_ms = 0 } = {}) {
  if (result.kind !== 'sse') throw new Error('proxy result is not pseudo SSE');
  return replayFromEncryptedSseChunks(result.chunks, { sessionSecret, ttft_ms });
}
