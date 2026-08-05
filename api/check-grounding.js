// POST /api/check-grounding
//
// Phase 2.1. Splits the generated patient summary into claims and reports, for
// each, whether the source document supports it.
//
// Request:  { sourceText: string, patientSummary: string }
// Response: { allGrounded: boolean,
//             claims: [{ text, grounded, sourceSpan, reason? }] }
//
// How grounding is decided:
//   1. The server splits the summary into claims. The model never supplies
//      claim text, so what the UI highlights always matches the summary.
//   2. The model judges each claim and, when it says grounded, must return a
//      span copied verbatim from the source.
//   3. The server verifies that span really occurs in the source. A claim
//      asserted as grounded whose span cannot be found is downgraded to
//      ungrounded.
//
// Step 3 is what makes the ★ injection resistance structural rather than a
// promise. Text injected into the source cannot make an unsupported claim read
// as grounded, because support requires a span that exists in the source; the
// most an injection can do is offer itself as a span, which supports nothing.
//
// The check fails toward flagging. A claim the model does not return a verdict
// for is reported ungrounded, not silently passed: an unchecked claim and a
// verified one must never look the same.

import Anthropic from '@anthropic-ai/sdk';

import { splitClaims } from './_lib/claims.js';
import {
  GROUNDING_SYSTEM_PROMPT,
  buildGroundingMessage,
  GROUNDING_SCHEMA,
} from './_lib/grounding-prompt.js';
import { DEMO_CASES } from './_lib/demo-cases.js';
import { applySecurityHeaders, isSameOrigin, isBodyTooLarge, isJsonRequest } from './_lib/http.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { resolveApiKey } from './_lib/config.js';
import { logEvent } from './_lib/log.js';

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const EFFORT = process.env.SHEPHERD_GROUNDING_EFFORT || 'medium';

const MAX_TEXT = 20000;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_RETRIES = 1;

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  if (!isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }

  if (isBodyTooLarge(req, MAX_BODY_BYTES)) {
    return res.status(413).json({ error: 'Request body is too large.' });
  }

  if (!isJsonRequest(req)) {
    return res.status(415).json({ error: 'Content-Type must be application/json.' });
  }

  const { sourceText, patientSummary } = req.body ?? {};

  if (typeof sourceText !== 'string' || sourceText.trim() === '') {
    return res.status(400).json({ error: 'sourceText is required and must be a non-empty string.' });
  }
  if (typeof patientSummary !== 'string' || patientSummary.trim() === '') {
    return res
      .status(400)
      .json({ error: 'patientSummary is required and must be a non-empty string.' });
  }
  if (sourceText.length > MAX_TEXT || patientSummary.length > MAX_TEXT) {
    return res.status(400).json({ error: `Text is too long. Limit is ${MAX_TEXT} characters each.` });
  }

  const claims = splitClaims(patientSummary);
  if (claims.length === 0) {
    return res.status(200).json({ allGrounded: true, claims: [] });
  }

  // Offline demo mode. Returns the hand-authored expected result for a known
  // demo summary so the amber state can be rehearsed with no network. Marked
  // with a header; never used to paper over a live failure.
  if (process.env.SHEPHERD_USE_FIXTURES === '1') {
    const canned = findCannedResult(patientSummary);
    if (canned) {
      logEvent('check-grounding', { outcome: 'fixture', claimCount: canned.claims.length });
      res.setHeader('X-Shepherd-Stub', '1');
      return res.status(200).json(canned);
    }
    logEvent('check-grounding', { outcome: 'fixture_all_grounded', claimCount: claims.length });
    res.setHeader('X-Shepherd-Stub', '1');
    return res.status(200).json({
      allGrounded: true,
      claims: claims.map((text) => ({ text, grounded: true, sourceSpan: null })),
    });
  }

  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    logEvent('check-grounding', { outcome: 'rate_limited', status: 429 });
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }

  const { key: apiKey } = resolveApiKey();
  if (!apiKey) {
    logEvent('check-grounding', { outcome: 'no_api_key' });
    return res.status(503).json({
      error: 'The grounding check is not configured on the server. No AI key is set.',
    });
  }

  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const startedAt = Date.now();

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: GROUNDING_SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: GROUNDING_SCHEMA },
      },
      messages: [{ role: 'user', content: buildGroundingMessage(sourceText, claims) }],
    });

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      logEvent('check-grounding', {
        outcome: response.stop_reason,
        durationMs: Date.now() - startedAt,
      });
      return res.status(502).json({ error: 'The grounding check could not be completed.' });
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      logEvent('check-grounding', { outcome: 'unparseable', durationMs: Date.now() - startedAt });
      return res.status(502).json({ error: 'The grounding check returned an unexpected format.' });
    }

    const result = assemble(claims, parsed, sourceText);

    logEvent('check-grounding', {
      outcome: 'ok',
      durationMs: Date.now() - startedAt,
      claimCount: result.claims.length,
      ungroundedCount: result.claims.filter((c) => !c.grounded).length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return res.status(200).json(result);
  } catch (err) {
    logEvent('check-grounding', { outcome: 'api_error', durationMs: Date.now() - startedAt });
    return res.status(502).json({ error: 'The grounding check could not be completed.' });
  }
}

// Pairs the server's claim list with the model's verdicts, verifying every
// asserted span against the source before accepting it.
function assemble(claims, parsed, sourceText) {
  const verdicts = new Map();
  if (parsed && Array.isArray(parsed.verdicts)) {
    for (const v of parsed.verdicts) {
      if (v && Number.isInteger(v.index)) verdicts.set(v.index, v);
    }
  }

  const haystack = normalize(sourceText);

  const out = claims.map((text, index) => {
    const verdict = verdicts.get(index);

    // No verdict returned: flag rather than pass. An unchecked claim must not
    // be indistinguishable from a verified one.
    if (!verdict) {
      return {
        text,
        grounded: false,
        sourceSpan: null,
        reason: 'This statement could not be checked against the source document.',
      };
    }

    if (verdict.grounded !== true) {
      return {
        text,
        grounded: false,
        sourceSpan: null,
        reason:
          typeof verdict.reason === 'string' && verdict.reason.trim() !== ''
            ? verdict.reason.trim()
            : 'Nothing in the source document supports this statement.',
      };
    }

    const span = typeof verdict.sourceSpan === 'string' ? verdict.sourceSpan.trim() : '';

    // The span must genuinely occur in the source. This is the step that keeps
    // injected text from manufacturing support.
    if (span === '' || !haystack.includes(normalize(span))) {
      return {
        text,
        grounded: false,
        sourceSpan: null,
        reason:
          'This statement was reported as supported, but the supporting text could ' +
          'not be found in the source document.',
      };
    }

    return { text, grounded: true, sourceSpan: span };
  });

  return { allGrounded: out.every((c) => c.grounded), claims: out };
}

// Whitespace-insensitive comparison. A model copying a span across a line wrap
// in the source will reproduce the words but not necessarily the line break,
// and that should not count as a failed verification.
function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function findCannedResult(patientSummary) {
  const needle = normalize(patientSummary);
  for (const demo of Object.values(DEMO_CASES)) {
    if (normalize(demo.patientSummary) === needle) return demo.expectedGrounding;
  }
  return null;
}
