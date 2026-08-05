// Resolves the AI key from the environment.
//
// ANTHROPIC_API_KEY is the canonical name and what .env.example documents.
// The alternates are accepted because a key provisioned by an integration or
// named by hand often lands under a different variable, and a demo failing for
// that reason is a bad way to lose ten minutes. Which name was used is
// reported by /api/health, so a fallback is visible rather than silent.

const CANDIDATES = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'ANTHROPIC_KEY',
  'ANTHROPIC_API_TOKEN',
];

export function resolveApiKey() {
  for (const name of CANDIDATES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return { key: value.trim(), source: name };
    }
  }
  return { key: null, source: null };
}

export { CANDIDATES as API_KEY_CANDIDATES };
