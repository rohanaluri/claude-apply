import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  matchEeoOption,
  isDeclineOption,
  EEO_INTENT_HINTS,
} from '../../src/apply/eeo-match.mjs';

// Minimal stand-in for index.mjs's matchOptionText — same exact/prefix/
// substring contract, used here only for the 'verbatim' fallback path.
function matchOptionText(options, desired) {
  const norm = (s) => String(s ?? '').toLowerCase().trim();
  const want = norm(desired);
  if (want === '') return null;
  const exact = options.find((o) => norm(o) === want);
  if (exact) return exact;
  const starts = options.filter((o) => norm(o).startsWith(want));
  if (starts.length === 1) return starts[0];
  return null;
}

// ---------- classifyIntent ----------

test('classifyIntent: empty/unset -> decline', () => {
  assert.equal(classifyIntent(''), 'decline');
  assert.equal(classifyIntent(undefined), 'decline');
  assert.equal(classifyIntent(null), 'decline');
});

test('classifyIntent: "Prefer not to say" -> decline', () => {
  assert.equal(classifyIntent('Prefer not to say'), 'decline');
});

test('classifyIntent: real profile values from candidate-profile.yml -> negative', () => {
  assert.equal(classifyIntent('not a veteran'), 'negative');
  assert.equal(classifyIntent('No disabilities'), 'negative');
});

test('classifyIntent: affirmative phrasing', () => {
  assert.equal(classifyIntent('Yes'), 'affirmative');
  assert.equal(classifyIntent('I am a veteran'), 'affirmative');
});

test('classifyIntent: explicit category value -> verbatim', () => {
  assert.equal(classifyIntent('Male'), 'verbatim');
  assert.equal(classifyIntent('Asian'), 'verbatim');
});

// ---------- matchEeoOption: the exact real-world case that failed live ----------

test('matchEeoOption: veteran_status "not a veteran" matches Greenhouse-style wording', () => {
  const options = [
    'I am a protected veteran',
    'I am not a protected veteran',
    "I don't wish to answer",
  ];
  assert.equal(
    matchEeoOption('eeo_veteran', 'not a veteran', options, matchOptionText),
    'I am not a protected veteran'
  );
});

test('matchEeoOption: veteran_status "not a veteran" matches plain Lever-style wording', () => {
  const options = ['Yes', 'No', 'Decline to self-identify'];
  assert.equal(matchEeoOption('eeo_veteran', 'not a veteran', options, matchOptionText), 'No');
});

test('matchEeoOption: disability_status "No disabilities" matches real wording', () => {
  const options = [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability',
    "I don't wish to answer",
  ];
  assert.equal(
    matchEeoOption('eeo_disability', 'No disabilities', options, matchOptionText),
    'No, I do not have a disability'
  );
});

test('matchEeoOption: disability negative never collides with the affirmative option', () => {
  // Regression guard for the exact failure mode implicated in the earlier
  // screenshot run: disability_status='No disabilities' must NEVER resolve
  // to the "Yes, I have a disability" option.
  const options = [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability',
  ];
  const result = matchEeoOption('eeo_disability', 'No disabilities', options, matchOptionText);
  assert.notEqual(result, 'Yes, I have a disability, or have had one in the past');
  assert.equal(result, 'No, I do not have a disability');
});

test('matchEeoOption: decline still works for an unset value', () => {
  const options = ['Male', 'Female', 'Decline to self-identify'];
  assert.equal(matchEeoOption('eeo_gender', '', options, matchOptionText), 'Decline to self-identify');
});

test('matchEeoOption: decline with no decline option on the page -> null (never guess)', () => {
  const options = ['Male', 'Female'];
  assert.equal(matchEeoOption('eeo_gender', '', options, matchOptionText), null);
});

test('matchEeoOption: verbatim category value still uses exact/prefix matcher', () => {
  const options = ['Male', 'Female', 'Prefer not to say'];
  assert.equal(matchEeoOption('eeo_gender', 'Male', options, matchOptionText), 'Male');

  const ethnicityOptions = ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)'];
  assert.equal(
    matchEeoOption('eeo_ethnicity', 'Asian', ethnicityOptions, matchOptionText),
    'Asian (Not Hispanic or Latino)'
  );
});

test('matchEeoOption: ambiguous negative match -> null (never guess between two)', () => {
  // Contrived case where two options would both read as "negative" — must
  // not pick one arbitrarily.
  const options = ['No, not a veteran', 'No, never served', 'Yes, I am a veteran'];
  assert.equal(matchEeoOption('eeo_veteran', 'not a veteran', options, matchOptionText), null);
});

test('matchEeoOption: empty options array -> null', () => {
  assert.equal(matchEeoOption('eeo_veteran', 'not a veteran', [], matchOptionText), null);
});

// ---------- EEO_INTENT_HINTS: used by index.mjs's fillSimple react-select fallback ----------

test('EEO_INTENT_HINTS: negative hints are each distinctive against wording they apply to', () => {
  // index.mjs tries these candidates in ORDER until one resolves — not every
  // candidate needs to match every possible company wording (that's the
  // whole point of having several), but whichever candidate DOES match a
  // given wording must match it UNAMBIGUOUSLY (never both the affirmative
  // and negative option), since that's what makes the react-select
  // snippet's substring fallback safe to try blind.
  const wordingSets = [
    ['I am a protected veteran', 'I am not a protected veteran'],
    ['I am a veteran', 'I am not a veteran'],
  ];
  for (const options of wordingSets) {
    const negativeOption = options.find((o) => /not a/i.test(o));
    const matchedByAny = EEO_INTENT_HINTS.eeo_veteran.negative.some((hint) => {
      const matches = options.filter((o) => o.toLowerCase().includes(hint.toLowerCase()));
      if (matches.length === 0) return false;
      assert.equal(matches.length, 1, `hint "${hint}" must never match more than one option`);
      assert.equal(matches[0], negativeOption);
      return true;
    });
    assert.ok(matchedByAny, `no candidate hint matched wording: ${JSON.stringify(options)}`);
  }
});

test('EEO_INTENT_HINTS: first negative candidate covers "protected veteran" wording', () => {
  // Regression guard for the bug this array design fixes: a single fixed
  // phrase like "not a veteran" is NOT a literal substring of "I am not a
  // PROTECTED veteran" (a common real wording), so the first candidate tried
  // must itself handle that phrasing.
  const first = EEO_INTENT_HINTS.eeo_veteran.negative[0];
  assert.ok('I am not a protected veteran'.toLowerCase().includes(first.toLowerCase()));
});

test('isDeclineOption: recognizes common real-world phrasings', () => {
  assert.ok(isDeclineOption('Prefer not to say'));
  assert.ok(isDeclineOption('Decline to self-identify'));
  assert.ok(isDeclineOption("I don't wish to answer"));
  assert.ok(!isDeclineOption('No, I do not have a disability'));
});
