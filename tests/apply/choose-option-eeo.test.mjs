// Exercises index.mjs's exported chooseOption() with real dependencies
// stubbed out (playwright/js-yaml aren't needed for this pure function) —
// see the repo's real tests/apply/*.test.mjs for the full suite, which
// should be run there with the real dependencies installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOption, classifyButton } from '../../src/apply/index.mjs';

// ---------- regression guards: unchanged behavior for non-EEO classKeys ----------

test('chooseOption: sponsorship Yes/No unaffected by the EEO change', () => {
  assert.equal(chooseOption(['Yes', 'No'], 'No', 'sponsorship'), 'No');
  assert.equal(chooseOption(['Yes', 'No'], 'yes', 'sponsorship'), 'Yes');
});

test('chooseOption: ambiguous substring still refuses to guess', () => {
  assert.equal(
    chooseOption(['Master of Science', 'Master of Arts'], 'Master', 'education_degree'),
    null
  );
});

test('classifyButton: submit still wins ties (unaffected by this patch)', () => {
  assert.equal(classifyButton('Submit and Continue'), 'submit');
});

// ---------- the actual bug: real profile values now resolve ----------

test('chooseOption: eeo_veteran "not a veteran" (the exact live profile value) resolves', () => {
  const options = ['I am a protected veteran', 'I am not a protected veteran', "I don't wish to answer"];
  assert.equal(chooseOption(options, 'not a veteran', 'eeo_veteran'), 'I am not a protected veteran');
});

test('chooseOption: eeo_disability "No disabilities" (the exact live profile value) resolves', () => {
  const options = [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability',
    "I don't wish to answer",
  ];
  assert.equal(
    chooseOption(options, 'No disabilities', 'eeo_disability'),
    'No, I do not have a disability'
  );
});

test('chooseOption: eeo_gender "Male" (verbatim path) still works exactly as before', () => {
  assert.equal(chooseOption(['Male', 'Female', 'Prefer not to say'], 'Male', 'eeo_gender'), 'Male');
});

test('chooseOption: eeo_ethnicity "Asian" (verbatim path) still works exactly as before', () => {
  const options = ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)'];
  assert.equal(chooseOption(options, 'Asian', 'eeo_ethnicity'), 'Asian (Not Hispanic or Latino)');
});

test('chooseOption: existing EEO null -> decline tests still pass unchanged', () => {
  assert.equal(
    chooseOption(['Male', 'Female', 'Prefer not to say'], 'Prefer not to say', 'eeo_gender'),
    'Prefer not to say'
  );
  assert.equal(
    chooseOption(['Male', 'Female', 'Decline to self-identify'], '', 'eeo_gender'),
    'Decline to self-identify'
  );
  assert.equal(chooseOption(['Male', 'Female'], '', 'eeo_gender'), null);
});
