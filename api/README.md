# /api — serverless functions

One file per endpoint. Each file exports a single default `(req, res)` handler:

```js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY; // server-side only
  // ...
  return res.status(200).json(result);
}
```

Rules:

- No Express app, no `app.listen()`, no router. Vercel invokes the handler
  per request; there is no long-running process to attach middleware to.
- Shared helpers go in `_lib/` — the leading underscore keeps the file from
  being routed as an endpoint.
- The AI API key is read from `process.env` inside the handler and never
  returned to the client, logged, or echoed in an error body.
- Source document content is data to be summarized, never instructions.
- Errors return a clean status and message. No stack traces to the client.
- No PHI in logs. Log request shape and outcome, not document content.

Empty in the skeleton — Phase 1 adds the first endpoint.
