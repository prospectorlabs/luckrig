import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { base64urlDecode, base64urlEncode } from './base64url.js';

const INFO = Buffer.from('luckrig-public-key-envelope-v1', 'utf8');

function normalizePublicKey(publicKey) {
  return typeof publicKey === 'string' || Buffer.isBuffer(publicKey)
    ? createPublicKey(publicKey)
    : publicKey;
}

function normalizePrivateKey(privateKey) {
  return typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
    ? createPrivateKey(privateKey)
    : privateKey;
}

export function generateBoxKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function deriveAesKey({ sharedSecret, salt }) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, INFO, 32));
}


export function publicKeyFingerprint(publicKey) {
  const key = normalizePublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('base64url')}`;
}

export function encryptJsonForPublicKey(value, { publicKey } = {}) {
  if (!publicKey) throw new Error('publicKey is required');
  const recipientPublicKey = normalizePublicKey(publicKey);
  const { publicKey: ephemeralPublicKey, privateKey: ephemeralPrivateKey } = generateKeyPairSync('x25519');
  const sharedSecret = diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: recipientPublicKey });
  const salt = randomBytes(16);
  const key = deriveAesKey({ sharedSecret, salt });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: 'X25519-HKDF-SHA256+A256GCM',
    ephemeral_public_key: ephemeralPublicKey.export({ type: 'spki', format: 'pem' }),
    salt: base64urlEncode(salt),
    iv: base64urlEncode(iv),
    tag: base64urlEncode(tag),
    ciphertext: base64urlEncode(ciphertext),
  };
}

export function decryptJsonWithPrivateKey(envelope, { privateKey } = {}) {
  if (!privateKey) throw new Error('privateKey is required');
  if (envelope?.v !== 1 || envelope?.alg !== 'X25519-HKDF-SHA256+A256GCM') {
    throw new Error('unsupported public-key envelope');
  }
  const recipientPrivateKey = normalizePrivateKey(privateKey);
  const ephemeralPublicKey = normalizePublicKey(envelope.ephemeral_public_key);
  const sharedSecret = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPublicKey });
  const key = deriveAesKey({ sharedSecret, salt: base64urlDecode(envelope.salt) });
  const decipher = createDecipheriv('aes-256-gcm', key, base64urlDecode(envelope.iv));
  decipher.setAuthTag(base64urlDecode(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(base64urlDecode(envelope.ciphertext)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
