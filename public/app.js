// Shepherd — frontend.
//
// Ground rules for this file:
//   - Endpoint calls use relative paths only. Never a localhost URL, never a
//     hardcoded deploy origin.
//   - Every piece of source text and model output reaches the DOM through
//     textContent. innerHTML is never used anywhere in this file. The source
//     document is untrusted input displayed back to the user and is the
//     likeliest real XSS vector in this app.
//   - No API key and no model call lives on this side of the wire.

'use strict';

const els = {
  docSelect: document.getElementById('doc-select'),
  summarizeBtn: document.getElementById('summarize-btn'),
  sourceText: document.getElementById('source-text'),
  outputBody: document.getElementById('output-body'),
  tabs: Array.from(document.querySelectorAll('.toggle__btn')),
  customSource: document.getElementById('custom-source'),
  customText: document.getElementById('custom-text'),
  customFile: document.getElementById('custom-file'),
  customCount: document.getElementById('custom-count'),
  customFileLabel: document.getElementById('custom-file-label'),
  outputSub: document.getElementById('output-sub'),
};

// Sentinel for the "paste or upload your own" option in the picker. Not a real
// document id — resolveRequest() swaps it for one the server will accept.
const CUSTOM_ID = '__custom__';

// Mirrors the server's cap so an oversized paste is caught here, with a useful
// message, instead of making a round trip to be rejected.
const MAX_SOURCE_TEXT = 20000;

const state = {
  documents: [],
  activeDocId: null,
  result: null,
  view: 'patient',
  loading: false,
  error: null,
  // Held in memory only for the current page view. Never written to storage,
  // never sent anywhere except the summarize request the user asks for.
  customText: '',
  // Phase 2.1. Null until the grounding check returns. Kept separate from
  // state.result so a grounding failure can never affect whether the summary
  // renders.
  grounding: null,
  groundingStatus: 'idle', // idle | checking | done | failed
};

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function loadDocuments() {
  try {
    const res = await fetch('/api/documents');
    if (!res.ok) throw new Error(`Request failed (${res.status})`);

    const data = await res.json();
    state.documents = Array.isArray(data.documents) ? data.documents : [];

    if (state.documents.length === 0) {
      state.error = 'No documents are available to summarize.';
      renderOutput();
      return;
    }

    state.activeDocId = state.documents[0].id;
    renderDocOptions();
    renderSource();
  } catch (err) {
    state.error = 'Could not load the demo documents. Check that the server is running.';
    els.summarizeBtn.disabled = true;
    renderOutput();
  }
}

async function summarize() {
  if (state.loading) return;

  const request = resolveRequest();
  if (request.error) {
    state.error = request.error;
    state.result = null;
    renderOutput();
    return;
  }

  state.loading = true;
  state.error = null;
  state.result = null;
  resetGrounding();
  els.summarizeBtn.disabled = true;
  els.summarizeBtn.textContent = 'Summarizing…';
  renderOutput();

  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      state.error =
        (data && typeof data.error === 'string' && data.error) ||
        `The summary could not be generated (${res.status}).`;
    } else if (!data || typeof data.patientSummary !== 'string') {
      state.error = 'The server returned an unexpected response.';
    } else {
      state.result = data;
    }
  } catch (err) {
    state.error = 'Could not reach the server. Check your connection and try again.';
  } finally {
    state.loading = false;
    els.summarizeBtn.disabled = false;
    els.summarizeBtn.textContent = 'Summarize';
    renderOutput();
  }

  // Phase 2.1. Runs after the summary is already on screen, in its own request.
  // Deliberately not awaited inside the try above: the summary must render
  // whether or not grounding succeeds.
  if (state.result) checkGrounding(request.sourceText, state.result.patientSummary);
}

// Never throws and never sets state.error — a grounding failure degrades to a
// small notice beside the summary, never to a missing summary.
async function checkGrounding(sourceText, patientSummary) {
  state.grounding = null;
  state.groundingStatus = 'checking';
  renderOutput();

  try {
    const res = await fetch('/api/check-grounding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceText, patientSummary }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || !Array.isArray(data.claims)) {
      state.groundingStatus = 'failed';
    } else {
      state.grounding = data;
      state.groundingStatus = 'done';
    }
  } catch {
    state.groundingStatus = 'failed';
  }

  renderOutput();
}

function resetGrounding() {
  state.grounding = null;
  state.groundingStatus = 'idle';
}

function activeDoc() {
  return state.documents.find((d) => d.id === state.activeDocId) || null;
}

function isCustomMode() {
  return state.activeDocId === CUSTOM_ID;
}

// Produces the request body, or an error message to show instead of sending.
function resolveRequest() {
  if (isCustomMode()) {
    const text = state.customText.trim();
    if (text === '') {
      return { error: 'Paste a document, or upload a PDF or text file, before summarizing.' };
    }
    if (text.length > MAX_SOURCE_TEXT) {
      return {
        error: `That document is ${text.length.toLocaleString()} characters. The limit is ${MAX_SOURCE_TEXT.toLocaleString()}.`,
      };
    }
    return { documentId: 'CUSTOM-PASTED', sourceText: text };
  }

  const doc = activeDoc();
  if (!doc) return { error: 'Choose a document first.' };
  return { documentId: doc.id, sourceText: doc.sourceText };
}

/* ------------------------------------------------------------------ *
 * Render — controls and source panel
 * ------------------------------------------------------------------ */

function renderDocOptions() {
  els.docSelect.replaceChildren();

  for (const doc of state.documents) {
    const opt = document.createElement('option');
    opt.value = doc.id;
    opt.textContent = `${doc.label} (${doc.id})`;
    els.docSelect.append(opt);
  }

  const custom = document.createElement('option');
  custom.value = CUSTOM_ID;
  custom.textContent = 'Paste or upload your own…';
  els.docSelect.append(custom);

  els.docSelect.value = state.activeDocId;
}

function renderSource() {
  const custom = isCustomMode();

  els.sourceText.classList.toggle('is-hidden', custom);
  els.customSource.classList.toggle('is-hidden', !custom);

  if (custom) {
    els.customText.value = state.customText;
    renderCustomCount();
    return;
  }

  const doc = activeDoc();
  els.sourceText.textContent = doc ? doc.sourceText : '';
}

function renderCustomCount() {
  const length = state.customText.trim().length;
  const over = length > MAX_SOURCE_TEXT;
  els.customCount.textContent =
    `${length.toLocaleString()} / ${MAX_SOURCE_TEXT.toLocaleString()} characters`;
  els.customCount.classList.toggle('is-over', over);
}

/* ------------------------------------------------------------------ *
 * Render — output panel
 * ------------------------------------------------------------------ */

function renderOutput() {
  els.outputBody.replaceChildren();

  if (state.error) {
    els.outputBody.append(buildError(state.error));
    return;
  }

  if (state.loading) {
    els.outputBody.append(buildPlaceholder('Rewriting this document…'));
    return;
  }

  if (!state.result) {
    els.outputSub.textContent = 'The same document, rewritten';
    els.outputBody.append(
      buildPlaceholder('Select Summarize to see this document in plain language.')
    );
    return;
  }

  if (state.result.demo) wrap0Notice(els.outputBody);

  const detected = state.result.documentType;
  els.outputSub.textContent = detected
    ? `Detected: ${detected}`
    : 'The same document, rewritten';

  const wrap = document.createElement('div');
  wrap.className = 'output';

  if (state.view === 'patient') {
    wrap.classList.add('output--patient');
    const ungrounded = ungroundedClaims();
    const matched = new Set();
    // The status strip goes in the panel, not inside .output. renderPatientSummary
    // marks its first paragraph as the lead by checking that no <p> exists in its
    // parent yet, and a status <p> in there would suppress that styling forever.
    els.outputBody.append(buildGroundingStatus(ungrounded.length));
    renderPatientSummary(wrap, state.result.patientSummary, state.result.glossary, ungrounded, matched);
    const missed = ungrounded.filter((c) => !matched.has(c));
    if (missed.length > 0) wrap.append(buildUnplacedClaims(missed));
  } else {
    renderClinicianHighlights(wrap, state.result.clinicianHighlights);
  }

  els.outputBody.append(wrap);
}

// A demo case's summary is hand-authored with a planted unsupported claim. It
// must never read as something the model produced, so the notice is rendered
// before anything else in the panel and is not dismissible.
function wrap0Notice(parent) {
  const p = document.createElement('p');
  p.className = 'demo-notice';
  p.textContent =
    'Demonstration case. This summary was written by hand and contains one ' +
    'deliberately unsupported statement, so the grounding check has something ' +
    'to catch. It is not model output.';
  parent.append(p);
}

function ungroundedClaims() {
  if (!state.grounding || !Array.isArray(state.grounding.claims)) return [];
  return state.grounding.claims.filter(
    (c) => c && c.grounded === false && typeof c.text === 'string' && c.text.trim() !== ''
  );
}

// A one-line strip above the summary saying what the check found. Without it,
// "no amber" is ambiguous between "checked and clean" and "never checked".
function buildGroundingStatus(ungroundedCount) {
  const p = document.createElement('p');
  p.className = 'grounding-status';

  if (state.groundingStatus === 'checking') {
    p.classList.add('grounding-status--pending');
    p.textContent = 'Checking every statement against the source document…';
    return p;
  }

  if (state.groundingStatus === 'failed') {
    p.classList.add('grounding-status--failed');
    p.textContent =
      'The source-grounding check could not run, so nothing below has been verified against the source.';
    return p;
  }

  if (state.groundingStatus !== 'done') {
    p.classList.add('grounding-status--pending');
    p.textContent = 'Not yet checked against the source document.';
    return p;
  }

  if (ungroundedCount === 0) {
    p.classList.add('grounding-status--clear');
    p.textContent = 'Every statement below is supported by the source document.';
    return p;
  }

  p.classList.add('grounding-status--flagged');
  p.textContent =
    ungroundedCount === 1
      ? '1 statement below is not supported by the source document. It is highlighted; hover or select it for the reason.'
      : `${ungroundedCount} statements below are not supported by the source document. They are highlighted; hover or select one for the reason.`;
  return p;
}

// Any flagged claim whose text could not be located in the rendered summary is
// listed here rather than dropped. A flag that silently disappears is
// indistinguishable from no flag at all, which is the worst outcome for a
// safety feature.
function buildUnplacedClaims(claims) {
  const section = document.createElement('section');
  section.className = 'unplaced';

  const heading = document.createElement('h3');
  heading.textContent = 'Also flagged';
  section.append(heading);

  const note = document.createElement('p');
  note.className = 'unplaced__note';
  note.textContent =
    'These statements were flagged as unsupported but could not be located in the text above.';
  section.append(note);

  const ul = document.createElement('ul');
  for (const claim of claims) {
    const li = document.createElement('li');
    li.textContent = claim.text;
    if (typeof claim.reason === 'string' && claim.reason.trim() !== '') {
      const reason = document.createElement('span');
      reason.className = 'unplaced__reason';
      reason.textContent = ` — ${claim.reason}`;
      li.append(reason);
    }
    ul.append(li);
  }
  section.append(ul);
  return section;
}

function buildPlaceholder(message) {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = message;
  return p;
}

function buildError(message) {
  const p = document.createElement('p');
  p.className = 'error';
  p.setAttribute('role', 'alert');
  p.textContent = message;
  return p;
}

// The patient summary arrives as a plain string. Blank lines separate blocks;
// lines starting with "- " become list items. A short block with no ending
// punctuation is treated as a section heading — a formatting heuristic only,
// so a miss is cosmetic and never changes the words shown.
function renderPatientSummary(parent, text, glossary, ungrounded = [], matched = new Set()) {
  const terms = normalizeGlossary(glossary);
  const lines = String(text).split('\n');

  let paragraph = [];
  let listItems = [];
  let activeSection = null;

  const sectionTarget = () => activeSection || parent;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const block = paragraph.join(' ').trim();
    paragraph = [];
    if (block === '') return;

    if (isHeading(block)) {
      activeSection = document.createElement('section');
      activeSection.className = 'summary-section';
      const h = document.createElement('h3');
      h.textContent = block;
      activeSection.append(h);
      parent.append(activeSection);
      return;
    }

    const p = document.createElement('p');
    if (!activeSection && parent.querySelector('p') === null) {
      p.className = 'summary-lead';
    }
    appendTextWithClaims(p, block, terms, ungrounded, matched);
    sectionTarget().append(p);
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const ul = document.createElement('ul');
    for (const item of listItems) {
      const li = document.createElement('li');
      appendTextWithClaims(li, item, terms, ungrounded, matched);
      ul.append(li);
    }
    listItems = [];
    sectionTarget().append(ul);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    if (line.startsWith('- ')) {
      flushParagraph();
      listItems.push(line.slice(2).trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  if (terms.length > 0) {
    parent.append(buildGlossary(terms));
  }
}

function isHeading(block) {
  return block.length < 48 && !/[.,:;!?]$/.test(block);
}

function renderClinicianHighlights(parent, highlights) {
  const list = Array.isArray(highlights) ? highlights : [];

  if (list.length === 0) {
    parent.append(buildPlaceholder('No highlights were returned for this document.'));
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'highlights';

  for (const item of list) {
    const li = document.createElement('li');
    li.textContent = String(item);
    ul.append(li);
  }

  parent.append(ul);
}

function buildGlossary(terms) {
  const section = document.createElement('section');
  section.className = 'glossary';

  const heading = document.createElement('h3');
  heading.textContent = 'Medical words explained';
  section.append(heading);

  const dl = document.createElement('dl');
  for (const { term, plain } of terms) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = plain;
    dl.append(dt, dd);
  }

  section.append(dl);
  return section;
}

/* ------------------------------------------------------------------ *
 * Glossary term highlighting
 *
 * Splits a string on known glossary terms and appends the pieces as text
 * nodes and <span> elements. Term text is set with textContent and the
 * definition with setAttribute — neither parses HTML, so a term or
 * definition containing markup stays inert.
 * ------------------------------------------------------------------ */

// Splits a block of summary text on any ungrounded claim it contains, wrapping
// those ranges in an amber span carrying the reason. Everything — highlighted
// or not — still goes through appendTextWithTerms, so glossary definitions
// survive inside a flagged claim.
//
// Claim text and reason both reach the DOM via textContent and setAttribute.
// Neither parses HTML, so a claim or reason containing markup stays inert.
function appendTextWithClaims(parent, text, terms, ungrounded, matched) {
  if (!ungrounded || ungrounded.length === 0) {
    appendTextWithTerms(parent, text, terms);
    return;
  }

  // Locate each flagged claim in this block. Longest first, so a claim that
  // contains another does not get carved up by it.
  const ranges = [];
  for (const claim of [...ungrounded].sort((a, b) => b.text.length - a.text.length)) {
    const needle = claim.text.trim();
    if (needle === '') continue;
    const index = text.indexOf(needle);
    if (index === -1) continue;
    if (ranges.some((r) => index < r.end && index + needle.length > r.start)) continue;
    ranges.push({ start: index, end: index + needle.length, claim });
    matched.add(claim);
  }

  if (ranges.length === 0) {
    appendTextWithTerms(parent, text, terms);
    return;
  }

  ranges.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      appendTextWithTerms(parent, text.slice(cursor, range.start), terms);
    }

    const mark = document.createElement('mark');
    mark.className = 'claim claim--ungrounded';
    mark.setAttribute('tabindex', '0');
    const reason =
      typeof range.claim.reason === 'string' && range.claim.reason.trim() !== ''
        ? range.claim.reason
        : 'This statement is not supported by the source document.';
    mark.setAttribute('title', `Not supported by the source: ${reason}`);
    mark.setAttribute('aria-label', `Unsupported statement. ${reason}`);
    appendTextWithTerms(mark, text.slice(range.start, range.end), terms);
    parent.append(mark);

    cursor = range.end;
  }

  if (cursor < text.length) {
    appendTextWithTerms(parent, text.slice(cursor), terms);
  }
}

function normalizeGlossary(glossary) {
  if (!Array.isArray(glossary)) return [];

  return glossary
    .filter((g) => g && typeof g.term === 'string' && typeof g.plain === 'string')
    .filter((g) => g.term.trim() !== '')
    .map((g) => ({ term: g.term.trim(), plain: g.plain.trim() }))
    // Longest first, so "amoxicillin-clavulanate" wins over a shorter substring.
    .sort((a, b) => b.term.length - a.term.length);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendTextWithTerms(parent, text, terms) {
  if (terms.length === 0) {
    parent.append(document.createTextNode(text));
    return;
  }

  const pattern = new RegExp(
    `(?<![A-Za-z0-9-])(${terms.map((t) => escapeRegExp(t.term)).join('|')})(?![A-Za-z0-9-])`,
    'gi'
  );

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const matched = match[0];
    const entry = findTerm(terms, matched);

    if (!entry) continue;

    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const span = document.createElement('span');
    span.className = 'term';
    span.textContent = matched;
    span.setAttribute('title', entry.plain);
    span.setAttribute('tabindex', '0');
    parent.append(span);

    lastIndex = match.index + matched.length;
  }

  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

// Short abbreviations must match case exactly, so a glossary entry for "OR"
// does not light up every "or" in a sentence.
function findTerm(terms, matched) {
  const lower = matched.toLowerCase();
  const entry = terms.find((t) => t.term.toLowerCase() === lower);
  if (!entry) return null;
  if (entry.term.length <= 3 && entry.term !== matched) return null;
  return entry;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

els.docSelect.addEventListener('change', () => {
  state.activeDocId = els.docSelect.value;
  state.result = null;
  state.error = null;
  resetGrounding();
  renderSource();
  renderOutput();
});

els.customText.addEventListener('input', () => {
  state.customText = els.customText.value;
  state.error = null;
  renderCustomCount();
});

// Text files are read in the browser. PDFs go to /api/extract, and the text
// comes back into the same textarea — so an uploaded document takes an
// identical path to a pasted one, and the user sees exactly what will be sent
// before sending it.
els.customFile.addEventListener('change', async () => {
  const file = els.customFile.files && els.customFile.files[0];
  els.customFile.value = ''; // so re-selecting the same file still fires
  if (!file) return;

  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const isText = /\.(txt|md|text)$/i.test(file.name) || /^text\//.test(file.type);

  // Anything that is neither a PDF nor plain text is refused outright. Reading
  // an image or a .docx as text would fill the box with binary garbage and look
  // like a bug rather than an unsupported format.
  if (!isPdf && !isText) {
    state.error =
      'That file type is not supported. Upload a PDF or a plain text file, ' +
      'or paste the text directly.';
    renderOutput();
    return;
  }

  setFileBusy(true);
  state.error = null;

  try {
    const text = isPdf ? await extractPdf(file) : await file.text();
    state.customText = text;
    els.customText.value = text;
    state.result = null;
    renderCustomCount();
  } catch (err) {
    state.error =
      err && err.message
        ? err.message
        : 'That file could not be read. Try pasting the text instead.';
  } finally {
    setFileBusy(false);
    renderOutput();
  }
});

function setFileBusy(busy) {
  els.customFileLabel.textContent = busy ? 'Reading…' : 'Upload a PDF or text file';
  els.customFileLabel.classList.toggle('is-busy', busy);
}

// Sends the PDF as base64 and gets plain text back. Extraction runs on the
// server so no PDF library has to be vendored into the page, which keeps the
// frontend dependency-free and the CSP strict.
async function extractPdf(file) {
  const buffer = await file.arrayBuffer();

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // chunked so a large file cannot blow the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }

  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, dataBase64: btoa(binary) }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      (data && typeof data.error === 'string' && data.error) ||
        `That PDF could not be read (${res.status}).`
    );
  }
  if (!data || typeof data.text !== 'string') {
    throw new Error('The server returned an unexpected response for that PDF.');
  }
  if (data.truncated) {
    state.error =
      `That PDF was longer than the ${MAX_SOURCE_TEXT.toLocaleString()}-character limit, ` +
      'so only the beginning was kept. Check the text before summarizing.';
  }
  return data.text;
}

els.summarizeBtn.addEventListener('click', summarize);

for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;

    for (const t of els.tabs) {
      const isActive = t === tab;
      t.classList.toggle('is-active', isActive);
      t.setAttribute('aria-selected', String(isActive));
    }

    renderOutput();
  });
}

renderOutput();
loadDocuments();
