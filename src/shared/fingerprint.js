export function extractFingerprintText(text) {
  const match = String(text ?? '').match(/sha256:[A-Za-z0-9_-]{16,}/);
  return match?.[0] ?? null;
}

export function verifyFingerprintText({ expected, text } = {}) {
  const found = extractFingerprintText(text);
  return {
    ok: Boolean(expected && found && expected === found),
    expected: expected ?? null,
    found,
  };
}
