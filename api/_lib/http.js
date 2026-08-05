// Shared HTTP hardening for the /api functions.
//
// vercel.json already applies security headers at the edge. These are applied
// again at the function level so the guarantee does not depend on a single
// config file staying correct — if vercel.json is edited or a route escapes its
// `source` pattern, the handlers still emit their own headers.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');

  // Vercel's Node runtime does not emit X-Powered-By (that header is an Express
  // default, and there is no Express here). Removed explicitly anyway so the
  // guarantee holds if the function is ever run behind something that does.
  res.removeHeader('X-Powered-By');
}

// Same-origin enforcement.
//
// No Access-Control-Allow-Origin header is ever sent. That is deliberate and is
// stricter than an allowlist: without it, the browser blocks every cross-origin
// read of these responses. The check below adds server-side rejection on top,
// so a cross-site request is refused before it reaches any handler logic rather
// than being sent, processed, and then hidden from the attacker by the browser.
//
// Origin is matched against the request's own Host, so this works on any Vercel
// deployment URL without hardcoding one. Extra origins can be allowed through
// SHEPHERD_ALLOWED_ORIGINS (comma-separated) if the demo is ever served from a
// second hostname.
export function isSameOrigin(req) {
  const origin = req.headers.origin;

  // Absent on server-to-server calls and curl. A browser always sends Origin on
  // cross-site requests, so absence cannot be used to smuggle one through — an
  // attacker's page has no way to suppress it.
  if (!origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // Unparseable Origin — reject.
  }

  if (originHost === req.headers.host) return true;

  const allowed = (process.env.SHEPHERD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return allowed.some((value) => {
    try {
      return new URL(value).host === originHost;
    } catch {
      return value === originHost;
    }
  });
}

// Rejects bodies that are oversized before their contents are examined, so an
// enormous payload gets a clean 413 rather than being walked field by field.
export function isBodyTooLarge(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  return Number.isFinite(declared) && declared > maxBytes;
}

// A cross-site POST that avoids a CORS preflight has to use a simple
// Content-Type (text/plain, form-encoded, multipart). Requiring JSON means any
// cross-origin attempt must preflight, and the preflight fails because no
// Access-Control-Allow-Origin is returned.
export function isJsonRequest(req) {
  const contentType = req.headers['content-type'] || '';
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}
