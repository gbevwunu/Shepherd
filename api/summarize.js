// POST /api/summarize
//
// Phase 1, build step 2: returns hardcoded JSON in the response shape the
// frontend is built against. No model call yet — step 4 swaps the fixture
// lookup for a real one behind this same contract, so the frontend does
// not change.
//
// Request:  { documentId: string, sourceText: string }
// Response: { patientSummary: string,
//             clinicianHighlights: string[],
//             glossary?: [{ term: string, plain: string }] }

import { FIXTURES } from './_lib/fixtures.js';

const MAX_SOURCE_TEXT = 20000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
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

  const fixture = FIXTURES[documentId];
  if (!fixture) {
    // Only meaningful while the endpoint is stubbed. Once the model is wired
    // in, any document is summarizable and this branch goes away.
    return res.status(400).json({
      error: 'Unknown documentId. The stubbed endpoint only serves the seed documents.',
    });
  }

  // Marks the response as stub output without altering the JSON shape.
  res.setHeader('X-Shepherd-Stub', '1');

  return res.status(200).json({
    patientSummary: fixture.patientSummary,
    clinicianHighlights: fixture.clinicianHighlights,
    glossary: fixture.glossary,
  });
}
