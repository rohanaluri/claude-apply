import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { extractLabel } from '../../src/apply/dom-label.mjs';

function loadFixture(rel) {
  const html = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  return new JSDOM(html);
}

test('extractLabel: Lever cards[uuid] radio picks up its OWN option label, not the question', () => {
  // Updated 2026-08-27: this fixture's radios each have a proper
  // label[for="..."] pairing (id="q1-yes" -> <label for="q1-yes">Yes</label>),
  // so extractLabel() should return "Yes"/"No", the option's own text — NOT
  // the enclosing question. The old assertion here ('Are you currently in
  // your final year of study?') was asserting a real bug: every option under
  // a Lever question returned the identical question text, confirmed via a
  // live test on Epoch AI's real "Are you legally authorized to work...?"
  // Yes/No question, where both options came back with the same question
  // string. Fixed by trying the option's own label[for]/wrapping <label>
  // BEFORE falling back to the question-level text.
  const dom = loadFixture('tests/fixtures/apply/lever-question.html');
  const input = dom.window.document.querySelector(
    'input[name="cards[abc-uuid][field0]"][value="Yes"]'
  );
  assert.equal(extractLabel(input), 'Yes');
});

test('extractLabel: second Lever question is resolved independently', () => {
  // Updated 2026-08-27 — see comment on the test above for why the expected
  // value changed from the question text to the option's own label.
  const dom = loadFixture('tests/fixtures/apply/lever-question.html');
  const input = dom.window.document.querySelector(
    'input[name="cards[def-uuid][field0]"][value="No"]'
  );
  assert.equal(extractLabel(input), 'No');
});

test('extractLabel: plain <label for> (Greenhouse-style)', () => {
  const dom = loadFixture('tests/fixtures/apply/greenhouse-form.html');
  const input = dom.window.document.querySelector('#first_name');
  assert.equal(extractLabel(input), 'First Name');
});

test('extractLabel: Ashby data-qa container', () => {
  const dom = loadFixture('tests/fixtures/apply/ashby-question.html');
  const input = dom.window.document.querySelector('#ashby-auth');
  assert.equal(extractLabel(input), 'What is your current work authorization status?');
});

test('extractLabel: orphan input returns empty string', () => {
  const dom = loadFixture('tests/fixtures/apply/lever-question.html');
  const input = dom.window.document.querySelector('#orphan');
  assert.equal(extractLabel(input), '');
});
