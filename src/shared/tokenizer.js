const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RE = /[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)?/y;
const SPACE_RE = /\s/y;

function modelFamily(modelName = '') {
  const name = String(modelName).toLowerCase();
  if (name.includes('qwen')) return 'qwen';
  if (name.includes('llama')) return 'llama';
  if (name.includes('gpt')) return 'gpt';
  return 'generic';
}

function wordTokenEstimate(word, family) {
  if (!word) return 0;
  const length = word.length;
  const divisor = family === 'qwen' ? 3.6 : family === 'llama' ? 3.8 : 4.0;
  return Math.max(1, Math.ceil(length / divisor));
}

export function estimateTokenCount(text, { modelName = '' } = {}) {
  const value = String(text ?? '');
  if (value.trim() === '') {
    return { tokens: 0, tokenizer: 'luckrig-heuristic-v1', model_family: modelFamily(modelName) };
  }

  const family = modelFamily(modelName);
  let tokens = 0;
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    SPACE_RE.lastIndex = i;
    const space = SPACE_RE.exec(value);
    if (space) {
      i = SPACE_RE.lastIndex;
      continue;
    }

    WORD_RE.lastIndex = i;
    const word = WORD_RE.exec(value);
    if (word) {
      tokens += wordTokenEstimate(word[0], family);
      i = WORD_RE.lastIndex;
      continue;
    }

    const codePoint = value.codePointAt(i);
    const glyph = String.fromCodePoint(codePoint);
    if (CJK_RE.test(glyph)) tokens += 1;
    else if (/\p{Punctuation}|\p{Symbol}/u.test(glyph)) tokens += 1;
    else tokens += Math.max(1, Math.ceil(Buffer.byteLength(glyph, 'utf8') / 3));
    i += glyph.length;
  }

  return {
    tokens: Math.max(1, tokens),
    tokenizer: 'luckrig-heuristic-v1',
    model_family: family,
  };
}
