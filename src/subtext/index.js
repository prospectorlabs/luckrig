import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { base64urlDecode, base64urlEncode } from '../shared/base64url.js';

// POC variant of subtext: encode encrypted bytes as invisible Unicode variation selectors.
// Two variation selectors represent one byte (high/low nibble). This preserves a plain cover text.
const VS_BASE = 0xfe00;
const VS_END = VS_BASE + 0x0f;
const DEFAULT_COVER = 'luckrig tasting payload';

function keyFromSessionSecret(sessionSecret) {
  const key = base64urlDecode(sessionSecret);
  if (key.length !== 32) throw new Error('session secret must decode to 32 bytes');
  return key;
}

export function bytesToSubtext(bytes, coverText = DEFAULT_COVER) {
  const hidden = [...Buffer.from(bytes)].flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCodePoint(VS_BASE + nibble))
    .join('');
  return `${coverText}${hidden}`;
}

export function subtextToBytes(text) {
  const nibbles = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code >= VS_BASE && code <= VS_END) nibbles.push(code - VS_BASE);
  }
  if (nibbles.length === 0) return Buffer.alloc(0);
  if (nibbles.length % 2 !== 0) throw new Error('invalid subtext nibble length');
  const bytes = Buffer.alloc(nibbles.length / 2);
  for (let i = 0; i < nibbles.length; i += 2) {
    bytes[i / 2] = (nibbles[i] << 4) | nibbles[i + 1];
  }
  return bytes;
}

export function hasSubtext(text) {
  return subtextToBytes(text).length > 0;
}

export function encryptJsonToSubtext(value, { sessionSecret, coverText = DEFAULT_COVER } = {}) {
  const key = keyFromSessionSecret(sessionSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    v: 1,
    alg: 'AES-256-GCM',
    iv: base64urlEncode(iv),
    tag: base64urlEncode(tag),
    ciphertext: base64urlEncode(ciphertext),
  };
  return bytesToSubtext(Buffer.from(JSON.stringify(envelope), 'utf8'), coverText);
}

export function decryptJsonFromSubtext(text, { sessionSecret } = {}) {
  const envelopeBytes = subtextToBytes(text);
  if (envelopeBytes.length === 0) throw new Error('subtext payload not found');
  const envelope = JSON.parse(envelopeBytes.toString('utf8'));
  if (envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') throw new Error('unsupported encrypted envelope');
  const key = keyFromSessionSecret(sessionSecret);
  const decipher = createDecipheriv('aes-256-gcm', key, base64urlDecode(envelope.iv));
  decipher.setAuthTag(base64urlDecode(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(base64urlDecode(envelope.ciphertext)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
