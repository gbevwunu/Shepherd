// GET /api/documents
//
// Serves the synthetic seed documents to the frontend.
//
// /data sits outside the static root (/public is what Vercel serves when
// there is no build step), so the browser cannot fetch /data/seed.json
// directly. Reading it here keeps /data/seed.json as the single source of
// truth instead of maintaining a second copy under /public.
//
// createRequire is used rather than a JSON import so the read works the
// same on Node 20 without import attributes; vercel.json declares the file
// via includeFiles so it is bundled with the function.

import { createRequire } from 'node:module';

import { applySecurityHeaders, isSameOrigin } from './_lib/http.js';
import { DEMO_CASES } from './_lib/demo-cases.js';

const require = createRequire(import.meta.url);
const seed = require('../data/seed.json');

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  if (!isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  }

  const documents = seed.documents.map(({ id, label, sourceText }) => ({ id, label, sourceText }));

  // Demo cases reuse a real seed document as their source; only the summary is
  // hand-authored. `demo: true` tells the UI to label them, so a planted
  // fabrication is never mistaken for live model output.
  for (const [id, demo] of Object.entries(DEMO_CASES)) {
    const source = seed.documents.find((d) => d.id === demo.sourceDocumentId);
    if (!source) continue;
    documents.push({ id, label: demo.label, sourceText: source.sourceText, demo: true });
  }

  return res.status(200).json({ notice: seed.notice, documents });
}
