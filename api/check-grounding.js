// POST /api/check-grounding
//
// Phase 2.1. Splits the generated patient summary into claims and reports, for
// each, whether the source document supports it.
//
// STUB — no model call yet. This endpoint returns the real response shape so
// the highlight UI can be built against it, but it does NOT actually decide
// grounding, and it must not be described as if it does.
//
// Why not a lexical check: the patient summary is a plain-language translation
// whose whole purpose is to avoid the source's vocabulary — "pneumonia" becomes
// "a lung infection", "afebrile" becomes "no fever". Word-overlap scoring
// therefore flags a faithful summary almost end to end (measured: 18 of 19
// claims false-positive against the pneumonia fixture). Grounding here is a
// semantic-entailment judgement and needs the model; build step 3 supplies it
// behind this same contract.
//
// Until then: every claim is reported grounded, except sentences on the
// TEST_FABRICATIONS list below, which exist so the amber UI state can be
// exercised deterministically in tests and while building.
//
// Request:  { sourceText: string, patientSummary: string }
// Response: { allGrounded: boolean,
//             claims: [{ text, grounded, sourceSpan, reason? }] }

import { splitClaims, findSourceSpan } from './_lib/claims.js';
import { applySecurityHeaders, isSameOrigin, isBodyTooLarge, isJsonRequest } from './_lib/http.js';
import { logEvent } from './_lib/log.js';

const MAX_TEXT = 20000;
const MAX_BODY_BYTES = 64 * 1024;

// Sentences that must come back ungrounded while this endpoint is stubbed, so
// the amber highlight can be exercised without a model. The first is the
// example from the Phase 2 spec. None of these appear in any Phase 1 output —
// a summary only contains one if someone deliberately put it there.
const TEST_FABRICATIONS = [
  'rest for two weeks',
  'rest in bed',
  'avoid all visitors',
  'drink plenty of fluids',
  'this is nothing to worry about',
];

function describe(phrase) {
  if (/rest/.test(phrase)) return 'rest period';
  if (/visitors/.test(phrase)) return 'visitor restriction';
  if (/fluids/.test(phrase)) return 'fluid instruction';
  return 'such statement';
}

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

  const startedAt = Date.now();

  const claims = splitClaims(patientSummary).map((text) => {
    const fabrication = TEST_FABRICATIONS.find((phrase) =>
      text.toLowerCase().includes(phrase.toLowerCase())
    );

    if (fabrication) {
      return {
        text,
        grounded: false,
        sourceSpan: null,
        reason: `No ${describe(fabrication)} is stated anywhere in the source document.`,
      };
    }

    // Best-effort supporting span. Lexical matching is unreliable for this
    // (see the note at the top), so a null span here does not mean ungrounded
    // while the endpoint is stubbed.
    const match = findSourceSpan(text, sourceText, { minOverlap: 0.34 });
    return { text, grounded: true, sourceSpan: match ? match.span : null };
  });

  const allGrounded = claims.every((claim) => claim.grounded);

  logEvent('check-grounding', {
    outcome: 'stub',
    durationMs: Date.now() - startedAt,
    claimCount: claims.length,
    ungroundedCount: claims.filter((c) => !c.grounded).length,
  });

  // Marks the response as stub output without altering the JSON shape.
  res.setHeader('X-Shepherd-Stub', '1');

  return res.status(200).json({ allGrounded, claims });
}
