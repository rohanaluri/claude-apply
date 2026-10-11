import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAiPrompt } from '../../src/apply/index.mjs';

const base = {
  company: 'Acme',
  role: 'Data Scientist',
  language: 'en',
  jdText: 'Build models.',
  cvMd: '# Alice Martin — CV\n- Designed a Flask service for 52 sources',
  preferences: '',
};

test('buildAiPrompt — open-ended answers must rephrase the CV, not restate it', () => {
  const prompt = buildAiPrompt({
    ...base,
    questions: [{ id: 'q1', question: 'What is your proudest accomplishment?' }],
  });
  assert.match(prompt, /source of FACTS, not of WORDING/);
  assert.match(prompt, /Never reuse a CV bullet's phrasing/);
  assert.match(prompt, /pick ONE experience/);
  assert.match(prompt, /do not list the tech stack/);
});

test('buildAiPrompt — rephrasing rules keep the no-invention guarantee', () => {
  const prompt = buildAiPrompt({
    ...base,
    questions: [{ id: 'q1', question: 'Why this role?' }],
  });
  assert.match(prompt, /NEVER invent experience, employers, or skills/);
  assert.match(prompt, /Rewording must not change the facts/);
});

test('buildAiPrompt — multiple-choice questions still list their exact options', () => {
  const prompt = buildAiPrompt({
    ...base,
    questions: [{ id: 'q2', question: 'Willing to relocate?', options: ['Yes', 'No'] }],
  });
  assert.match(prompt, /\[id=q2\] \(MULTIPLE CHOICE .*"Yes" \| "No"\) Willing to relocate\?/);
});
