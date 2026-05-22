// luckrig moderation hook.
//
// The proxy can be configured to call an external moderation endpoint
// (OpenAI Moderation API-compatible) before forwarding a prompt to upstream
// and, optionally, before returning a response to the client. This exists to
// give node operators a concrete technical defense: "I do not knowingly run
// inference on illegal content; my proxy invokes a moderation classifier on
// every input and refuses flagged requests."
//
// Trust model note: this is best-effort. Sophisticated jailbreaks and novel
// adversarial inputs WILL slip through. The point is to remove plausible
// deniability for the worst categories (CSAM, mass-violence solicitation,
// etc.) and to log the moderation outcome so the operator has evidence of
// having tried. luckrig must not claim "safe" or "filtered" — only "checked".

const FORBIDDEN_CATEGORY_HINTS = [
  'sexual/minors',
  'csam',
  'child',
  'violence/graphic',
  'self-harm/instructions',
  'illicit/violent',
  'illicit/weapons',
];

function pickModerationResult(payload) {
  // OpenAI-compatible: { results: [ { flagged, categories: {...}, category_scores: {...} } ] }
  // Also accept a flatter shape: { flagged: bool, categories: {...} }
  if (!payload || typeof payload !== 'object') return null;
  const result = Array.isArray(payload.results) ? payload.results[0] : payload;
  if (!result || typeof result !== 'object') return null;
  return result;
}

function flaggedCategories(result) {
  if (!result) return [];
  const categories = result.categories ?? {};
  const flagged = [];
  for (const [name, value] of Object.entries(categories)) {
    if (value === true) flagged.push(name);
  }
  return flagged;
}

function isHardFail(categories) {
  const lower = categories.map((c) => String(c).toLowerCase());
  return FORBIDDEN_CATEGORY_HINTS.some((hint) => lower.some((c) => c.includes(hint)));
}

export async function runModeration({
  text,
  endpoint,
  authToken = null,
  model = 'omni-moderation-latest',
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  if (!endpoint) return { skipped: true, flagged: false, categories: [] };
  if (typeof text !== 'string' || text.length === 0) {
    return { skipped: false, flagged: false, categories: [], reason: 'empty' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ model, input: text }),
    });
  } catch (error) {
    clearTimeout(timer);
    // Network / timeout / DNS failure must not silently let traffic through.
    // The operator opted in to moderation; if the moderation endpoint is
    // unreachable we fail closed.
    return {
      skipped: false,
      flagged: true,
      categories: ['moderation-unreachable'],
      hard_fail: true,
      reason: `moderation endpoint unreachable: ${error?.message ?? error}`,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return {
      skipped: false,
      flagged: true,
      categories: ['moderation-http-error'],
      hard_fail: true,
      reason: `moderation HTTP ${response.status}`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      skipped: false,
      flagged: true,
      categories: ['moderation-invalid-response'],
      hard_fail: true,
      reason: `moderation invalid JSON: ${error?.message ?? error}`,
    };
  }
  const result = pickModerationResult(payload);
  const categories = flaggedCategories(result);
  const flagged = Boolean(result?.flagged) || categories.length > 0;
  return {
    skipped: false,
    flagged,
    categories,
    hard_fail: isHardFail(categories),
    raw_id: payload?.id ?? null,
  };
}

export function moderationError({ stage, categories, reason }) {
  // Generic 451 ("Unavailable For Legal Reasons") for moderator-flagged
  // content. We deliberately do NOT echo the offending text back; only the
  // stage (input|output) and category labels are surfaced so the operator
  // can decide how to communicate.
  const error = new Error(
    `luckrig moderation blocked ${stage}: ${categories.join(', ') || reason || 'flagged'}`,
  );
  error.statusCode = 451;
  error.moderation = { stage, categories, reason: reason ?? null };
  return error;
}
