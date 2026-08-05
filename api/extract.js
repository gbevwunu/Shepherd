// POST /api/extract
//
// Turns an uploaded PDF into plain text so the user can see, check and correct
// it before summarizing. Extraction is deliberately a separate step rather than
// something /api/summarize does invisibly: the text that reaches the model is
// the text on screen, which keeps the source panel honest and keeps Phase 2's
// grounding meaningful — it will ground against something the user can read.
//
// Request:  { filename?: string, dataBase64: string }
// Response: { text: string, pages: number, truncated: boolean }

import { extractText, getDocumentProxy } from 'unpdf';

import { applySecurityHeaders, isSameOrigin, isBodyTooLarge, isJsonRequest } from './_lib/http.js';
import { logEvent } from './_lib/log.js';

// Vercel caps a function request body at ~4.5MB. base64 inflates by ~4/3, so a
// 3MB PDF is the practical ceiling; the body cap below sits just under Vercel's.
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Mirrors the summarize endpoint's cap. A long PDF is truncated rather than
// rejected, and the response says so, so the user is never silently given a
// partial document.
const MAX_TEXT = 20000;

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
    return res.status(413).json({ error: 'That file is too large. The limit is about 3 MB.' });
  }

  if (!isJsonRequest(req)) {
    return res.status(415).json({ error: 'Content-Type must be application/json.' });
  }

  const { dataBase64 } = req.body ?? {};
  if (typeof dataBase64 !== 'string' || dataBase64.trim() === '') {
    return res.status(400).json({ error: 'dataBase64 is required and must be a non-empty string.' });
  }

  let bytes;
  try {
    bytes = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'The file could not be decoded.' });
  }

  if (bytes.length === 0) {
    return res.status(400).json({ error: 'That file appears to be empty.' });
  }
  if (bytes.length > MAX_PDF_BYTES) {
    return res.status(413).json({ error: 'That file is too large. The limit is about 3 MB.' });
  }

  // %PDF- magic. Guards against a mislabelled file reaching the parser.
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({
      error: 'That does not look like a PDF. Upload a PDF, or paste the text directly.',
    });
  }

  const startedAt = Date.now();

  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });

    const cleaned = normalizeWhitespace(String(text || ''));

    // A scanned document is an image with no text layer. Extraction "succeeds"
    // and returns almost nothing, which would otherwise look like a bug.
    if (cleaned.length < 20) {
      logEvent('extract', {
        outcome: 'no_text_layer',
        durationMs: Date.now() - startedAt,
      });
      return res.status(422).json({
        error:
          'No text could be read from that PDF. It is probably a scan or photo rather ' +
          'than a text document. Try pasting the text directly.',
      });
    }

    const truncated = cleaned.length > MAX_TEXT;

    logEvent('extract', {
      outcome: 'ok',
      pages: totalPages,
      chars: cleaned.length,
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json({
      text: truncated ? cleaned.slice(0, MAX_TEXT) : cleaned,
      pages: totalPages,
      truncated,
    });
  } catch (err) {
    logEvent('extract', { outcome: 'parse_failed', durationMs: Date.now() - startedAt });
    return res.status(422).json({
      error: 'That PDF could not be read. Try pasting the text directly.',
    });
  }
}

// PDF text extraction loses column alignment and scatters blank lines. This
// tidies the result for display without altering any of the words or numbers.
function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
