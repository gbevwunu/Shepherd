# Shepherd — demo runbook

Everything needed to test and run the demo. Delete before any real deployment.

## 0. Before you can demo

| # | Step | Why |
|---|---|---|
| 1 | Merge the Phase 2 PR into `main` | `main` has no `/api/check-grounding` yet, so the deployed site has Phase 1 only |
| 2 | Confirm `ANTHROPIC_API_KEY` is set for **Production** (and Preview) | Without it every summary returns a clean "not configured" 503 |
| 3 | Redeploy after step 2 | Env vars only apply to builds that run after they are added |
| 4 | Open `/api/health` | Confirms the key is visible and the seed file bundled |
| 5 | Run the live checks in section 2 | The model path has never been exercised from the build environment |

## 1. What to click, in order

The two-panel layout is the demo. Source on the left as the clinician wrote it,
Shepherd's rewrite on the right.

**Beat 1 — the transformation (Phase 1).**
Pick `Discharge summary — pneumonia`. Summarize. The left panel is dense jargon;
the right is grade 6–8 plain language addressed to "you". Hover an underlined
term for its definition. Toggle to **For clinicians** — same document, terse
bullets, abbreviations kept.

**Beat 2 — it is not just discharge summaries.**
Pick `Blood test result`. Summarize. Values, reference ranges and H/L flags are
restated; what they *mean* is not. Shepherd hands interpretation back to the
clinician, because a raw lab report contains none.

**Beat 3 — the catch (Phase 2).**
Pick `Demo — pneumonia summary with a planted error`. Summarize. One sentence
comes back amber. Hover it:

> The source document says nothing about bed rest or a two-week activity
> restriction. This instruction was not written by the clinician.

The line to say:

> The AI didn't decide this was wrong by re-reading its own work. Shepherd
> checked every claim against the source document, so a plausible-sounding
> fabrication can't reach the patient.

Backup, if asked whether it only catches one kind of mistake: `Demo —
appendectomy summary with a planted error` invents a *medication* instead of an
instruction.

> The demo cases carry an on-screen notice saying the summary is hand-authored
> with a deliberate error. Say so out loud too — Phase 1 is built not to
> fabricate, which is why the fabrication has to be planted.

**Beat 4 — bring your own.** Pick `Paste or upload your own…`, paste a
fictional document or upload a PDF. Synthetic only.

## 2. Live checks to run before demoing

The model path cannot be exercised from the build environment, so run these
against the deployed site once.

```bash
BASE=https://shepherd-dun.vercel.app

# Configured correctly?
curl -s $BASE/api/health | python3 -m json.tool

# Phase 1: does the pneumonia summary clear the plain-language bar?
curl -s $BASE/api/documents \
| python3 -c "import sys,json;d=json.load(sys.stdin)['documents'][0];print(json.dumps({'documentId':d['id'],'sourceText':d['sourceText']}))" \
> /tmp/req.json
curl -s -w '\n[%{http_code}] [%{time_total}s]\n' -X POST $BASE/api/summarize \
  -H 'Content-Type: application/json' --data-binary @/tmp/req.json
```

Then in the browser:

| Check | Expect | If it fails |
|---|---|---|
| Pneumonia doc | "Every statement below is supported" | A false positive here is worse than a missed catch — raise `SHEPHERD_GROUNDING_EFFORT` to `high` |
| Demo case A, three times | Exactly one amber flag, same sentence each time | Set `SHEPHERD_USE_FIXTURES=1` to serve the hand-authored payload |
| Lab result | No "this means", no "nothing to worry about" | Tighten the NEVER REASSURE rule in `api/_lib/prompt.js` |
| Time per summary | Under ~20s | Lower `SHEPHERD_EFFORT` to `low` |

## 3. If something breaks mid-demo

| Symptom | Fix |
|---|---|
| "not configured on the server" | Key missing for this environment. Check `/api/health` |
| Slow or timing out | `SHEPHERD_EFFORT=low`, redeploy |
| Grounding flaky or wrong | `SHEPHERD_USE_FIXTURES=1` — serves the hand-authored demo payloads, amber lands every time |
| Wifi gone | `SHEPHERD_USE_FIXTURES=1` runs the whole demo with no model calls |

## 4. Automated tests

Browser suites live in the session scratchpad, not the repo. To re-run, serve
the app locally and point each at it:

```bash
BASE=http://localhost:3000 node check.mjs      # 21 Phase 1 regression
BASE=http://localhost:3000 node phase1.mjs     # 18 Phase 1 checklist
BASE=http://localhost:3000 node custom.mjs     # 13 paste/upload
BASE=http://localhost:3000 node general.mjs    # 12 multi-document + PDF
BASE=http://localhost:3000 node grounding.mjs  # 19 grounding UI, failure, XSS
BASE=http://localhost:3000 node demo.mjs       # 20 demo fixtures, x3 for determinism
node contrast2.mjs                             # 33 WCAG AA colour pairs
```

Server-side, with no browser:

```bash
node --input-type=module -e "
import { splitClaims } from './api/_lib/claims.js';
import { DEMO_CASES } from './api/_lib/demo-cases.js';
for (const [id, d] of Object.entries(DEMO_CASES)) {
  const c = splitClaims(d.patientSummary);
  console.log(id, c.length, 'claims | planted present:', c.includes(d.plantedClaim));
}"
```

## 5. Known limits — say these before a judge finds them

- The rate limit is in-memory and per-instance. It stops a stuck tab, not an
  attacker. Durable limiting needs shared state.
- Scanned/image-only PDFs are detected and refused, not OCR'd.
- The grounding check is a second model call, so it inherits model variance.
  The demo cases are fixed inputs, which is why they are fixed inputs.
- No auth, no database, no audit log. All Phase 2.3 / roadmap.
- Synthetic data only. The paste box warns, but nothing enforces it.
