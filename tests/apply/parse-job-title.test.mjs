import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobTitle } from '../../src/apply/index.mjs';

test('parseJobTitle — Ashby "<role> @ <company>"', () => {
  assert.deepEqual(parseJobTitle('Software Engineer (Dashboard) - New York @ Browserbase', ''), {
    role: 'Software Engineer (Dashboard) - New York',
    company: 'Browserbase',
  });
});

test('parseJobTitle — Ashby prefers the h1 for the role once the page has rendered', () => {
  assert.deepEqual(parseJobTitle('Machine Learning Engineer @ Ramp', 'Machine Learning Engineer'), {
    role: 'Machine Learning Engineer',
    company: 'Ramp',
  });
});

test('parseJobTitle — Lever "<company> - <role>" unchanged', () => {
  assert.deepEqual(parseJobTitle('Epoch AI - Data Scientist', 'Epoch AI - Data Scientist'), {
    role: 'Data Scientist',
    company: 'Epoch AI',
  });
  assert.deepEqual(parseJobTitle('Hermeus - Software Engineer', 'Software Engineer'), {
    role: 'Software Engineer',
    company: 'Hermeus',
  });
});

test('parseJobTitle — single-part title: role = title, company null', () => {
  assert.deepEqual(parseJobTitle('Careers', ''), { role: 'Careers', company: null });
});

test('parseJobTitle — Greenhouse "Job Application for <role> at <company>"', () => {
  assert.deepEqual(
    parseJobTitle('Job Application for Software Engineer, CDP - Foundations at Coinbase', ''),
    { role: 'Software Engineer, CDP - Foundations', company: 'Coinbase' }
  );
  assert.deepEqual(
    parseJobTitle('Job Application for Data Analyst at Pure Storage', 'Data Analyst'),
    { role: 'Data Analyst', company: 'Pure Storage' }
  );
});
