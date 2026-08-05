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
};

const state = {
  documents: [],
  activeDocId: null,
  result: null,
  view: 'patient',
  loading: false,
  error: null,
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
  const doc = activeDoc();
  if (!doc || state.loading) return;

  state.loading = true;
  state.error = null;
  state.result = null;
  els.summarizeBtn.disabled = true;
  els.summarizeBtn.textContent = 'Summarizing…';
  renderOutput();

  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: doc.id, sourceText: doc.sourceText }),
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
}

function activeDoc() {
  return state.documents.find((d) => d.id === state.activeDocId) || null;
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

  els.docSelect.value = state.activeDocId;
}

function renderSource() {
  const doc = activeDoc();
  els.sourceText.textContent = doc ? doc.sourceText : '';
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
    els.outputBody.append(
      buildPlaceholder('Select Summarize to see this document in plain language.')
    );
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'output';

  if (state.view === 'patient') {
    wrap.classList.add('output--patient');
    renderPatientSummary(wrap, state.result.patientSummary, state.result.glossary);
  } else {
    renderClinicianHighlights(wrap, state.result.clinicianHighlights);
  }

  els.outputBody.append(wrap);
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
function renderPatientSummary(parent, text, glossary) {
  const terms = normalizeGlossary(glossary);
  const lines = String(text).split('\n');

  let paragraph = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const block = paragraph.join(' ').trim();
    paragraph = [];
    if (block === '') return;

    if (isHeading(block)) {
      const h = document.createElement('h3');
      h.textContent = block;
      parent.append(h);
      return;
    }

    const p = document.createElement('p');
    appendTextWithTerms(p, block, terms);
    parent.append(p);
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const ul = document.createElement('ul');
    for (const item of listItems) {
      const li = document.createElement('li');
      appendTextWithTerms(li, item, terms);
      ul.append(li);
    }
    listItems = [];
    parent.append(ul);
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
  renderSource();
  renderOutput();
});

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
