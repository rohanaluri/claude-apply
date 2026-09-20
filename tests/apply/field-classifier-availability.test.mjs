// Supplementary to the repo's existing tests/apply/field-classifier.test.mjs
// — added alongside FIX 7 (2026-09-19). Covers only the new/changed
// behavior; doesn't duplicate the existing file's full case list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyField } from '../../src/apply/field-classifier.mjs';

test('classifyField: real-world "earliest you would want to start" label -> availability', () => {
  // This is the exact label from the live Anthropic Greenhouse run
  // (2026-09-19) that was misclassified as experience_start and filled with
  // the candidate's ADP job start date instead of being left for review.
  assert.equal(
    classifyField({
      name: 'availability',
      type: 'text',
      label: 'When is the earliest you would want to start working with us?',
    }),
    'availability'
  );
});

test('classifyField: bare "earliest start" (old phrasing) still -> availability', () => {
  assert.equal(
    classifyField({ name: 'avail', type: 'text', label: 'Earliest start date' }),
    'availability'
  );
});

test('classifyField: generic "Start Date" (job history) still -> experience_start, not availability', () => {
  // Regression guard for FIX 6 (2026-08-22): the widened regex must not
  // re-break this existing case.
  assert.equal(
    classifyField({ name: 'start', type: 'date', label: 'Start Date' }),
    'experience_start'
  );
});

test('classifyField: plain "Availability Date" still -> availability', () => {
  assert.equal(
    classifyField({ name: 'availability', type: 'date', label: 'Availability Date' }),
    'availability'
  );
});
