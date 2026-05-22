const DEFAULT_BLOCK_PATTERNS = [
  { id: 'nsfw-explicit', pattern: /\b(?:nsfw|porn|porno|erotic|sexual|nude|naked|sex)\b/i, reason: 'NSFW/explicit sexual content is outside luckrig scope.' },
  { id: 'jp-nsfw-explicit', pattern: /(?:ポルノ|性的|成人向け|裸|ヌード|エロ|セックス|性交)/i, reason: 'NSFW/explicit sexual content is outside luckrig scope.' },
  { id: 'heavy-creative', pattern: /(?:二次創作|キャラになりきって|恋愛ロールプレイ|性的ロールプレイ|暴力描写を詳しく)/i, reason: 'Heavy creative/roleplay content is outside luckrig scope; use your own local rig.' },
];

export function evaluatePromptPolicy(input, { extraBlockPatterns = [] } = {}) {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const patterns = [...DEFAULT_BLOCK_PATTERNS, ...extraBlockPatterns];
  for (const rule of patterns) {
    if (rule.pattern.test(text)) {
      return {
        allowed: false,
        rule_id: rule.id,
        reason: rule.reason,
      };
    }
  }
  return { allowed: true, rule_id: null, reason: null };
}

export function assertPromptAllowed(input, options = {}) {
  const result = evaluatePromptPolicy(input, options);
  if (!result.allowed) {
    const error = new Error(result.reason);
    error.statusCode = 422;
    error.policy = result;
    throw error;
  }
  return result;
}
