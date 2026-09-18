import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApplyUrl } from '../../src/apply/index.mjs';

test('normalizeApplyUrl — ajoute /apply à une URL Lever qui ne l’a pas', () => {
  const out = normalizeApplyUrl('https://jobs.lever.co/mistral/abc-intern-001');
  assert.equal(out, 'https://jobs.lever.co/mistral/abc-intern-001/apply');
});

test('normalizeApplyUrl — laisse intacte une URL Lever qui a déjà /apply', () => {
  const out = normalizeApplyUrl('https://jobs.lever.co/mistral/abc-intern-001/apply');
  assert.equal(out, 'https://jobs.lever.co/mistral/abc-intern-001/apply');
});

test('normalizeApplyUrl — tolère un trailing slash avant d’ajouter /apply', () => {
  const out = normalizeApplyUrl('https://jobs.lever.co/mistral/abc-intern-001/');
  assert.equal(out, 'https://jobs.lever.co/mistral/abc-intern-001/apply');
});

test('normalizeApplyUrl — ne touche pas aux URLs non-Lever', () => {
  const out = normalizeApplyUrl('https://boards.greenhouse.io/anthropic/jobs/12345');
  assert.equal(out, 'https://boards.greenhouse.io/anthropic/jobs/12345');
});

test('normalizeApplyUrl — renvoie la valeur telle quelle si ce n’est pas une URL valide', () => {
  assert.equal(normalizeApplyUrl('not-a-url'), 'not-a-url');
  assert.equal(normalizeApplyUrl(''), '');
  assert.equal(normalizeApplyUrl(null), null);
});
