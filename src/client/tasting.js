import { encryptJsonToSubtext, encryptJsonToSubtextForPublicKey } from '../subtext/index.js';
import { replayFromEncryptedSseChunks } from './replay.js';

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

export function replayFromProxyResult(result, { sessionSecret, userPrivateKey, ttft_ms = 0 } = {}) {
  if (result.kind !== 'sse') throw new Error('proxy result is not pseudo SSE');
  return replayFromEncryptedSseChunks(result.chunks, { sessionSecret, userPrivateKey, ttft_ms });
}
