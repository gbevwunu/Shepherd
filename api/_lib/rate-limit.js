// In-memory fixed-window rate limit for the AI endpoint.
//
// Honest description of what this is: per-instance, in-process, and reset by
// every cold start. Vercel may run several concurrent instances, so the real
// ceiling is roughly LIMIT x instance count, and a burst that lands on fresh
// instances is not limited at all.
//
// It is still worth having — it stops one browser tab hammering the endpoint,
// which is the realistic failure mode for a demo — but it is not a defense
// against a determined attacker. Durable limiting needs shared state (Redis,
// Vercel KV, or a gateway rule); that is on the roadmap, not built here.

const WINDOW_MS = 60_000;

// Deliberately loose. Everyone in a demo room behind one office NAT shares a
// public IP, so a tight per-IP limit throws 429s at judges rather than at
// abusers. This is high enough not to interfere and low enough to stop a stuck
// tab looping on the endpoint.
const LIMIT = Number(process.env.SHEPHERD_RATE_LIMIT) || 20;

const hits = new Map(); // key -> { count, windowStart }

export function checkRateLimit(req, { limit = LIMIT, windowMs = WINDOW_MS } = {}) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    hits.set(key, { count: 1, windowStart: now });
    sweep(now, windowMs);
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  entry.count += 1;

  if (entry.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)),
    };
  }

  return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 };
}

// x-forwarded-for is set by Vercel's proxy; the first entry is the client. The
// value is client-controllable in general, which is another reason this is a
// courtesy limit rather than a security control.
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Keeps the map from growing without bound on a long-lived instance.
function sweep(now, windowMs) {
  if (hits.size < 1000) return;
  for (const [key, entry] of hits) {
    if (now - entry.windowStart >= windowMs) hits.delete(key);
  }
}
