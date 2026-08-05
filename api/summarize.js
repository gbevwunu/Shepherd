// POST /api/summarize
//
// Request:  { documentId: string, sourceText: string }
// Response: { patientSummary: string,
//             clinicianHighlights: string[],
//             glossary: [{ term: string, plain: string }] }
//
// The API key is read from process.env inside this handler. It is never sent to
// the browser, never logged, and never included in an error body.

import Anthropic from '@anthropic-ai/sdk';

import { SYSTEM_PROMPT, buildUserMessage, RESPONSE_SCHEMA } from './_lib/prompt.js';
import { FIXTURES } from './_lib/fixtures.js';
import { logEvent } from './_lib/log.js';
import {
  applySecurityHeaders,
  isSameOrigin,
  isBodyTooLarge,
  isJsonRequest,
} from './_lib/http.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { resolveApiKey } from './_lib/config.js';
import { DEMO_CASES } from './_lib/demo-cases.js';

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;

// Thinking depth and overall token spend. 'low' and 'medium' are strong on this
// model; 'medium' is the starting point here because the demo is latency-
// sensitive and the task is a transformation rather than open-ended reasoning.
// Raise to 'high' if the patient summary reads thin.
const EFFORT = process.env.SHEPHERD_EFFORT || 'medium';

const MAX_SOURCE_TEXT = 20000;

// Ceiling on the whole request body, checked from Content-Length before the
// parsed body is inspected. Generous next to the 20k text cap so a legitimate
// request is never caught by it.
const MAX_BODY_BYTES = 64 * 1024;

// Client timeout is set well inside the function's maxDuration (60s in
// vercel.json) so a slow upstream call fails with a clean message rather than
// being killed mid-flight. One retry: 25s x 2 attempts stays under the ceiling.
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

  const body = req.body ?? {};
  const { documentId, sourceText } = body;

  if (typeof documentId !== 'string' || documentId.trim() === '') {
    return res.status(400).json({ error: 'documentId is required and must be a non-empty string.' });
  }
  if (typeof sourceText !== 'string' || sourceText.trim() === '') {
    return res.status(400).json({ error: 'sourceText is required and must be a non-empty string.' });
  }
  if (sourceText.length > MAX_SOURCE_TEXT) {
    return res.status(400).json({
      error: `sourceText is too long. Limit is ${MAX_SOURCE_TEXT} characters.`,
    });
  }

  // Demo case: the summary is hand-authored and contains a deliberately
  // planted unsupported claim. It is NOT model output, and both the header and
  // the `demo` flag say so, so nothing downstream can present it as such.
  const demo = DEMO_CASES[documentId];
  if (demo) {
    logEvent('summarize', { documentId, outcome: 'demo_case' });
    res.setHeader('X-Shepherd-Demo-Case', '1');
    return res.status(200).json({
      documentType: demo.documentType,
      patientSummary: demo.patientSummary,
      clinicianHighlights: demo.clinicianHighlights,
      glossary: demo.glossary,
      demo: true,
    });
  }

  // Offline demo mode. Serves the pre-written fixtures instead of calling the
  // model, for rehearsing without a network. Marked in the response headers so
  // fixture output is never mistaken for model output.
  if (process.env.SHEPHERD_USE_FIXTURES === '1') {
    const fixture = FIXTURES[documentId];
    if (!fixture) {
      return res.status(400).json({
        error: 'Offline demo mode is on, and this document has no stored example.',
      });
    }
    logEvent('summarize', { documentId, outcome: 'fixture' });
    res.setHeader('X-Shepherd-Stub', '1');
    return res.status(200).json(fixture);
  }

  // Rate limit guards the model call specifically, so it sits after validation
  // and after the offline-fixtures path: a malformed request is cheap and
  // should not spend a legitimate user's budget, and fixtures cost nothing.
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    logEvent('summarize', { documentId, outcome: 'rate_limited', status: 429 });
    return res.status(429).json({
      error: 'Too many requests. Wait a moment and try again.',
    });
  }

  const { key: apiKey } = resolveApiKey();
  if (!apiKey) {
    logEvent('summarize', { documentId, outcome: 'no_api_key' });
    return res.status(503).json({
      error:
        'The summarizer is not configured on the server. No AI key is set. ' +
        'Check /api/health to see what the server can and cannot find.',
    });
  }

  const client = new Anthropic({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  const startedAt = Date.now();

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: 'user', content: buildUserMessage(sourceText) }],
    });

    // Check stop_reason before touching content — a refusal returns HTTP 200
    // with empty or partial content, so indexing content[0] first would throw.
    if (response.stop_reason === 'refusal') {
      logEvent('summarize', {
        documentId,
        sourceChars: sourceText.length,
        durationMs: Date.now() - startedAt,
        outcome: 'refusal',
      });
      return res.status(502).json({
        error: 'The summary could not be generated for this document. Try a different document.',
      });
    }

    if (response.stop_reason === 'max_tokens') {
      logEvent('summarize', {
        documentId,
        sourceChars: sourceText.length,
        durationMs: Date.now() - startedAt,
        outcome: 'truncated',
      });
      return res.status(502).json({
        error: 'The summary was cut off before it finished. Try again.',
      });
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      logEvent('summarize', {
        documentId,
        sourceChars: sourceText.length,
        durationMs: Date.now() - startedAt,
        outcome: 'unparseable',
      });
      return res.status(502).json({
        error: 'The summary came back in an unexpected format. Try again.',
      });
    }

    const result = normalize(parsed);
    if (!result) {
      logEvent('summarize', {
        documentId,
        sourceChars: sourceText.length,
        durationMs: Date.now() - startedAt,
        outcome: 'bad_shape',
      });
      return res.status(502).json({
        error: 'The summary came back incomplete. Try again.',
      });
    }

    logEvent('summarize', {
      documentId,
      sourceChars: sourceText.length,
      durationMs: Date.now() - startedAt,
      outcome: 'ok',
      stopReason: response.stop_reason,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return res.status(200).json(result);
  } catch (err) {
    return handleApiError(err, res, { documentId, startedAt, sourceChars: sourceText.length });
  }
}

// Guards the response shape the frontend renders. Structured outputs make a
// malformed body unlikely, but the frontend is the last place we want to find
// out, so the contract is checked here rather than assumed.
function normalize(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.patientSummary !== 'string' || parsed.patientSummary.trim() === '') return null;
  // documentType is informational, so a missing one falls back rather than
  // failing an otherwise good summary.
  const documentType =
    typeof parsed.documentType === 'string' && parsed.documentType.trim() !== ''
      ? parsed.documentType.trim()
      : 'medical document';
  if (!Array.isArray(parsed.clinicianHighlights)) return null;

  const clinicianHighlights = parsed.clinicianHighlights
    .filter((item) => typeof item === 'string' && item.trim() !== '');
  if (clinicianHighlights.length === 0) return null;

  const glossary = Array.isArray(parsed.glossary)
    ? parsed.glossary.filter(
        (entry) =>
          entry &&
          typeof entry.term === 'string' &&
          typeof entry.plain === 'string' &&
          entry.term.trim() !== ''
      )
    : [];

  return { documentType, patientSummary: parsed.patientSummary, clinicianHighlights, glossary };
}

// Maps upstream failures onto clean client-facing messages. No stack traces, no
// upstream error text, and nothing that could echo the key back.
function handleApiError(err, res, { documentId, startedAt, sourceChars }) {
  const durationMs = Date.now() - startedAt;
  let status = 502;
  let message = 'The summary could not be generated right now. Try again.';
  let outcome = 'api_error';

  if (err instanceof Anthropic.AuthenticationError) {
    status = 503;
    message = 'The summarizer is not configured correctly on the server.';
    outcome = 'auth_error';
  } else if (err instanceof Anthropic.RateLimitError) {
    status = 429;
    message = 'Too many requests right now. Wait a moment and try again.';
    outcome = 'rate_limited';
  } else if (err instanceof Anthropic.APIConnectionTimeoutError) {
    status = 504;
    message = 'The summary took too long to generate. Try again.';
    outcome = 'timeout';
  } else if (err instanceof Anthropic.APIConnectionError) {
    status = 504;
    message = 'Could not reach the summarizing service. Try again.';
    outcome = 'connection_error';
  } else if (err instanceof Anthropic.APIError) {
    outcome = 'api_error';
  } else {
    status = 500;
    message = 'Something went wrong generating the summary.';
    outcome = 'unexpected_error';
  }

  logEvent('summarize', { documentId, sourceChars, durationMs, outcome, status });
  return res.status(status).json({ error: message });
}
