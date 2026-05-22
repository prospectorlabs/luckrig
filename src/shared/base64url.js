export function base64urlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64url');
}

export function base64urlDecode(input) {
  return Buffer.from(String(input), 'base64url');
}
