// Supplementary to the repo's existing tests/apply/react-select-helper.test.mjs
// (13 pure-function tests) — this file adds NEW coverage for the
// 2026-09-19 menu-scoping fix and does not duplicate the existing cases.
// Needs jsdom: npm install --save-dev jsdom (dev dependency only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  matchOptionText,
  ReactSelectError,
  REACT_SELECT_SNIPPET,
} from '../../src/apply/react-select-helper.mjs';

// ---------- pure-function tests (unchanged behavior) ----------

test('matchOptionText: exact trimmed match wins', () => {
  assert.equal(matchOptionText(['Non', 'Oui', 'NON'], 'Non'), 'Non');
});

test('matchOptionText: returns null when no match', () => {
  assert.equal(matchOptionText(['Oui', 'Non'], 'Peut-être'), null);
});

test('ReactSelectError: extends Error with code and optional found', () => {
  const err = new ReactSelectError('OPTION_NOT_FOUND', 'missing', { found: ['A', 'B'] });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'OPTION_NOT_FOUND');
  assert.deepEqual(err.found, ['A', 'B']);
});

// ---------- source-level regression guards for the 2026-09-19 fixes ----------

test('REACT_SELECT_SNIPPET: no longer falls back to a document-wide menu lookup', () => {
  // This is the exact bug: `|| document.querySelector('.select__menu')` as a
  // fallback could grab an ENTIRELY DIFFERENT field's still-open menu. (Not
  // a bare string search for "document.querySelector('.select__menu')" —
  // that phrase legitimately appears in this file's own comments.)
  assert.ok(
    !REACT_SELECT_SNIPPET.includes("|| document.querySelector('.select__menu')"),
    'snippet must not fall back to a document-wide .select__menu lookup'
  );
});

test('REACT_SELECT_SNIPPET: closes the menu on every failure path', () => {
  const failureReturns = [
    "return { ok: false, code: 'MENU_NOT_OPENED' }",
    "return { ok: false, code: 'OPTION_NOT_FOUND', found: labels }",
    "return { ok: false, code: 'SELECTION_NOT_APPLIED', found: labels }",
  ];
  for (const line of failureReturns) {
    const idx = REACT_SELECT_SNIPPET.indexOf(line);
    assert.ok(idx > -1, `expected to find: ${line}`);
    const precedingCode = REACT_SELECT_SNIPPET.slice(Math.max(0, idx - 80), idx);
    assert.ok(precedingCode.includes('closeMenu()'), `closeMenu() must precede: ${line}`);
  }
});

// ---------- full functional test via jsdom: actually runs the snippet ----------

/** Builds a minimal react-select-like DOM fixture for one field. */
function buildReactSelectField(document, { idx, options }) {
  const container = document.createElement('div');
  container.className = 'select__container';
  container.setAttribute('data-field', String(idx));

  const control = document.createElement('div');
  control.className = 'select__control';
  control.setAttribute('data-ca-idx', String(idx));
  container.appendChild(control);

  document.body.appendChild(container);

  // Opening the menu is simulated on mousedown, exactly like real
  // react-select — this is what lets the test simulate a menu that's
  // ALREADY open (by opening it up front) vs. one that opens on demand.
  const openMenu = () => {
    if (container.querySelector('.select__menu')) return;
    const menu = document.createElement('div');
    menu.className = 'select__menu';
    for (const label of options) {
      const opt = document.createElement('div');
      opt.className = 'select__option';
      opt.textContent = label;
      opt.addEventListener('mousedown', () => {
        const existing = container.querySelector('.select__single-value');
        if (existing) existing.remove();
        const valueEl = document.createElement('div');
        valueEl.className = 'select__single-value';
        valueEl.textContent = label;
        container.appendChild(valueEl);
      });
      menu.appendChild(opt);
    }
    container.appendChild(menu);
  };
  control.addEventListener('mousedown', openMenu);

  return { container, control };
}

async function runSnippet(window, controlSelector, optionText) {
  window.__controlSelector = controlSelector;
  window.__optionText = optionText;
  window.eval(
    'globalThis.__snippetPromise = (() => { const controlSelector = globalThis.__controlSelector; ' +
      `const optionText = globalThis.__optionText; return ${REACT_SELECT_SNIPPET}; })()`
  );
  return window.__snippetPromise;
}

test('REACT_SELECT_SNIPPET: does not steal a stale open menu from a different field', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  const { document } = window;

  // Field A: simulate a menu that's ALREADY open (as if a previous failed
  // fill on this field left it open) — but we are NOT targeting field A.
  const fieldA = buildReactSelectField(document, {
    idx: 0,
    options: ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability'],
  });
  fieldA.control.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.ok(fieldA.container.querySelector('.select__menu'), 'fixture setup: field A menu should be open');

  // Field B: the field we are actually trying to fill. Its own menu has NOT
  // opened (simulate react-select failing to respond to mousedown at all).
  const fieldB = document.createElement('div');
  fieldB.className = 'select__container';
  const controlB = document.createElement('div');
  controlB.className = 'select__control';
  controlB.setAttribute('data-ca-idx', '1');
  fieldB.appendChild(controlB);
  document.body.appendChild(fieldB);
  // Deliberately NOT wiring up an openMenu handler on controlB.

  const result = await runSnippet(window, '[data-ca-idx="1"]', 'No, I do not have a disability');

  // Before the fix, this would find field A's menu via the document-wide
  // fallback and WRONGLY click "No, I do not have a disability" onto field
  // A's own single-value (or worse, whichever option matched). After the
  // fix, field B's own menu never opened, so this must fail cleanly.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MENU_NOT_OPENED');
  // And field A must be untouched by field B's fill attempt.
  assert.equal(fieldA.container.querySelector('.select__single-value'), null);
});

test('REACT_SELECT_SNIPPET: fills the correct field when its own menu opens normally', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  const { document } = window;

  const field = buildReactSelectField(document, {
    idx: 5,
    options: ['I am a protected veteran', 'I am not a protected veteran', "I don't wish to answer"],
  });

  const result = await runSnippet(window, '[data-ca-idx="5"]', 'I am not a protected veteran');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'I am not a protected veteran');
});

test('REACT_SELECT_SNIPPET: unambiguous substring hint resolves the real option', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  const { document } = window;

  const field = buildReactSelectField(document, {
    idx: 2,
    options: ['I am a protected veteran', 'I am not a protected veteran'],
  });

  // This is the first candidate in EEO_INTENT_HINTS.eeo_veteran.negative
  // (eeo-match.mjs) — index.mjs tries it before the shorter "not a veteran"
  // fallback, since real forms commonly say "protected veteran".
  const result = await runSnippet(window, '[data-ca-idx="2"]', 'not a protected veteran');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'I am not a protected veteran');
});

test('REACT_SELECT_SNIPPET: ambiguous substring hint resolves to nothing (never guesses)', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  const { document } = window;

  // Neither option starts with "disability", so exact/prefix matching both
  // fail and this exercises the substring step specifically — which must
  // refuse to pick between two options that both contain "disability".
  const field = buildReactSelectField(document, {
    idx: 3,
    options: ['Yes, I have a disability', 'No, I do not have a disability'],
  });

  const result = await runSnippet(window, '[data-ca-idx="3"]', 'disability');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTION_NOT_FOUND');
});
