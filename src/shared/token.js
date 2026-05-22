import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicKeyFingerprint } from './keyhandshake.js';
import { base64urlDecode, base64urlEncode } from './base64url.js';

const DEFAULT_TTL_SEC = 15 * 60;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sign(secret, payloadPart) {
  return createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

export function createSessionSecret() {
  return randomBytes(32).toString('base64url');
}

export function issueTastingToken({
  secret,
  nodeId,
  userId = 'anonymous',
  tier = 'limited',
  ttlSec = DEFAULT_TTL_SEC,
  nowMs = Date.now(),
  sessionSecret = createSessionSecret(),
  userPublicKey = null,
  nodePublicKey = null,
  cryptoMode = userPublicKey ? 'public-key' : 'plain',
}) {
  if (!secret) throw new Error('secret is required');
  if (!nodeId) throw new Error('nodeId is required');
  if (!['plain', 'public-key', 'session-secret'].includes(cryptoMode)) {
    throw new Error(`unsupported cryptoMode: ${cryptoMode}`);
  }
  const userPublicKeyFingerprint = userPublicKey ? publicKeyFingerprint(userPublicKey) : null;
  const nodePublicKeyFingerprint = nodePublicKey ? publicKeyFingerprint(nodePublicKey) : null;

  let modeFields;
  if (cryptoMode === 'public-key') {
    modeFields = { user_public_key: userPublicKey, user_public_key_fingerprint: userPublicKeyFingerprint };
  } else if (cryptoMode === 'session-secret') {
    modeFields = { session_secret: sessionSecret };
  } else {
    modeFields = {}; // plain mode carries no key material
  }

  const payload = {
    v: 1,
    typ: 'luckrig.tasting',
    jti: randomBytes(12).toString('base64url'),
    node_id: nodeId,
    user_id: userId,
    tier,
    crypto_mode: cryptoMode,
    ...modeFields,
    ...(nodePublicKey ? { node_public_key: nodePublicKey, node_public_key_fingerprint: nodePublicKeyFingerprint } : {}),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttlSec,
  };
  const payloadPart = base64urlEncode(stableJson(payload));
  const signature = sign(secret, payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    payload,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifyTastingToken(token, { secret, nowMs = Date.now(), expectedNodeId } = {}) {
  if (!secret) throw new Error('secret is required');
  const [payloadPart, signature] = String(token ?? '').split('.');
  if (!payloadPart || !signature) throw new Error('invalid token format');

  const expected = sign(secret, payloadPart);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid token signature');

  const payload = JSON.parse(base64urlDecode(payloadPart).toString('utf8'));
  if (payload.v !== 1 || payload.typ !== 'luckrig.tasting') throw new Error('invalid token type');
  if (payload.exp <= Math.floor(nowMs / 1000)) throw new Error('token expired');
  if (expectedNodeId && payload.node_id !== expectedNodeId) throw new Error('token node mismatch');
  return payload;
}

export function bearerToken(authHeader) {
  const match = String(authHeader ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
