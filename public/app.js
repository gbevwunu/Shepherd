// Shepherd — frontend entry point.
//
// Skeleton only: no features yet. Phase 1 builds here.
//
// Ground rules for everything added to this file:
//   - All endpoint calls use relative paths (e.g. fetch('/api/summarize')).
//     Never a localhost URL, never a hardcoded deploy origin.
//   - All source text and all model output is rendered with textContent.
//     Never innerHTML — the source document is untrusted input shown back
//     to the user, and is the likeliest real XSS vector in this app.
//   - No API key or model call ever lives on this side of the wire.

'use strict';
