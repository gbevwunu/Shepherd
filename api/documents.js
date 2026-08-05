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

const require = createRequire(import.meta.url);
const seed = require('../data/seed.json');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  return res.status(200).json({
    notice: seed.notice,
    documents: seed.documents.map(({ id, label, sourceText }) => ({ id, label, sourceText })),
  });
}
