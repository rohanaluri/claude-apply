import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyField } from '../../src/apply/field-classifier.mjs';
import { groupFields, planFields } from '../../src/apply/index.mjs';

const text = (label) => ({ name: 'q', type: 'text', tag: 'input', label });

test('classifyField — sponsorship still matches real sponsorship/visa questions', () => {
  assert.equal(
    classifyField(
      text('Will you require sponsorship to work in the United States now or in the future?')
    ),
    'sponsorship'
  );
  assert.equal(classifyField(text('Do you require visa sponsorship?')), 'sponsorship');
  assert.equal(
    classifyField(text('If yes, will you require visa sponsorship to work here?')),
    'sponsorship'
  );
  // Seen live on OpenAI's Ashby form.
  assert.equal(
    classifyField(
      text(
        'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?'
      )
    ),
    'sponsorship'
  );
});

test('classifyField — a "describe your visa status" follow-up is not the sponsorship question', () => {
  assert.notEqual(
    classifyField(text('If so, please describe your current visa status.')),
    'sponsorship'
  );
  assert.notEqual(classifyField(text('Please explain your visa details')), 'sponsorship');
});

test('classifyField — eeo_disability still matches the EEO question', () => {
  assert.equal(classifyField(text('Disability Status')), 'eeo_disability');
  assert.equal(classifyField(text('Do you have a disability?')), 'eeo_disability');
});

test('classifyField — interview accommodation questions are not eeo_disability', () => {
  assert.notEqual(
    classifyField(
      text('Would you like any disability or mobility assistance for your interviews?')
    ),
    'eeo_disability'
  );
  assert.notEqual(
    classifyField(text('Do you need a disability accommodation during the interview process?')),
    'eeo_disability'
  );
});

// Raw entries shaped like scanScript's Ashby Yes/No output: one radio per button,
// sharing an `ashby-yesno:<field-path>` name, with the question as questionText.
function yesNo(path, question, firstIdx) {
  return ['Yes', 'No'].map((optionLabel, k) => ({
    idx: firstIdx + k,
    tag: 'button',
    type: 'radio',
    name: `ashby-yesno:${path}`,
    id: '',
    placeholder: '',
    required: true,
    label: optionLabel,
    optionLabel,
    questionText: question,
    selectOptions: [],
    isReactSelect: false,
    maxLength: null,
  }));
}

test('Ashby Yes/No — sponsorship answered from the profile via the radio path', () => {
  const raw = yesNo(
    'p1',
    'Will you require sponsorship to work in the United States now or in the future?',
    0
  );
  const [field] = groupFields(raw);
  assert.equal(field.kind, 'radio-group');
  assert.deepEqual(field.options, ['Yes', 'No']);
  assert.deepEqual(field.optionIdx, [0, 1]);

  const [plan] = planFields([field], { requires_sponsorship: false });
  assert.equal(plan.classKey, 'sponsorship');
  assert.equal(plan.action, 'radio');
  assert.equal(plan.value, 'No');
});

test('Ashby Yes/No — an unrecognized question goes to the AI with the real Yes/No options', () => {
  const raw = yesNo(
    'p2',
    'We work full time out of our office in San Francisco or in New York. Are you willing to relocate?',
    2
  );
  const [plan] = planFields(groupFields(raw), { relocation_flexible: true });
  assert.equal(plan.action, 'ai-choice');
  assert.deepEqual(plan.options, ['Yes', 'No']);
});
