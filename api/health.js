// GET /api/health — deployment diagnostics.
//
// Reports whether the server is configured, without ever revealing a secret.
// Key VALUES are never returned; only whether one is present, its length, and
// which variable name it came from. The env-var listing returns NAMES only,
// filtered to Anthropic/Claude-ish names, so a key stored under an unexpected
// name can be found without guessing.
//
// This exists because a misconfigured deployment otherwise presents as a
// generic "not configured" message with no way to tell which of four causes
// produced it. Safe to delete once the demo is running.

import { createRequire } from 'node:module';

import { applySecurityHeaders } from './_lib/http.js';
import { resolveApiKey, API_KEY_CANDIDATES } from './_lib/config.js';

const require = createRequire(import.meta.url);

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { key, source } = resolveApiKey();

  // Confirms /data/seed.json was bundled with the function (the includeFiles
  // config in vercel.json). If this reports an error, /api/documents is broken
  // for the same reason.
  let seed;
  try {
    const loaded = require('../data/seed.json');
    seed = { loaded: true, documentCount: loaded.documents.length };
  } catch (err) {
    seed = { loaded: false, reason: err.code || 'unknown' };
  }

  // Names only. Never values.
  const relatedEnvNames = Object.keys(process.env)
    .filter((name) => /anthropic|claude/i.test(name))
    .sort()
    .slice(0, 25);

  return res.status(200).json({
    ok: Boolean(key) && seed.loaded,
    apiKey: {
      present: Boolean(key),
      // Length distinguishes a real key from an empty string or a placeholder
      // like "your-key-here" without disclosing the key itself.
      length: key ? key.length : 0,
      resolvedFrom: source,
      lookedFor: API_KEY_CANDIDATES,
    },
    relatedEnvNames,
    seed,
    effort: process.env.SHEPHERD_EFFORT || 'medium (default)',
    offlineFixtures: process.env.SHEPHERD_USE_FIXTURES === '1',
    node: process.version,
  });
}
