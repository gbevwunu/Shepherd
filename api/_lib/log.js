// Logging that cannot leak document content.
//
// The data in this demo is synthetic, but the logger is written as if it were
// not: it accepts a fixed set of non-content fields and nothing else. There is
// no code path here that takes sourceText, patientSummary, or any model output.

export function logEvent(event, fields = {}) {
  const safe = {
    event,
    documentId: fields.documentId,
    sourceChars: fields.sourceChars,
    durationMs: fields.durationMs,
    outcome: fields.outcome,
    status: fields.status,
    stopReason: fields.stopReason,
    inputTokens: fields.inputTokens,
    outputTokens: fields.outputTokens,
    // PDF extraction: counts only, never extracted content.
    pages: fields.pages,
    chars: fields.chars,
    // Grounding: counts only, never claim text or reasons.
    claimCount: fields.claimCount,
    ungroundedCount: fields.ungroundedCount,
  };

  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined) delete safe[key];
  }

  console.log(JSON.stringify(safe));
}
