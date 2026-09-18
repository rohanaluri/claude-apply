import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformBreakdown,
  topCompanies,
  buildJobsTabUrl,
  buildDigestHtml,
  appendDigestRow,
} from '../../src/digest/index.mjs';

test('platformBreakdown — compte par plateforme, trié par count décroissant puis nom', () => {
  const offers = [
    { platform: 'lever' },
    { platform: 'greenhouse' },
    { platform: 'lever' },
    { platform: 'lever' },
    { platform: 'ashby' },
  ];
  assert.deepEqual(platformBreakdown(offers), [
    { platform: 'lever', count: 3 },
    { platform: 'ashby', count: 1 },
    { platform: 'greenhouse', count: 1 },
  ]);
});

test('platformBreakdown — liste vide renvoie []', () => {
  assert.deepEqual(platformBreakdown([]), []);
});

test('topCompanies — top N par nombre d’offres, ties par ordre alphabétique', () => {
  const offers = [
    { company: 'Acme' },
    { company: 'Beta' },
    { company: 'Acme' },
    { company: 'Gamma' },
    { company: 'Beta' },
    { company: 'Acme' },
  ];
  assert.deepEqual(topCompanies(offers, 2), [
    { company: 'Acme', count: 3 },
    { company: 'Beta', count: 2 },
  ]);
});

test('buildJobsTabUrl — sans gid, pointe juste sur le classeur', () => {
  assert.equal(
    buildJobsTabUrl('sheet123', null),
    'https://docs.google.com/spreadsheets/d/sheet123/edit'
  );
});

test('buildJobsTabUrl — avec gid, cible l’onglet précis', () => {
  assert.equal(
    buildJobsTabUrl('sheet123', 42),
    'https://docs.google.com/spreadsheets/d/sheet123/edit#gid=42'
  );
});

test('buildDigestHtml — 0 nouveau job affiche quand même un email (pas de branche "no send")', () => {
  const html = buildDigestHtml({ today: '2026-09-18', newJobs: [], jobsTabUrl: 'https://x' });
  assert.match(html, /0 new roles found today/);
  assert.match(html, /No new roles today/);
});

test('buildDigestHtml — inclut le lien vers l’onglet Jobs', () => {
  const html = buildDigestHtml({
    today: '2026-09-18',
    newJobs: [{ company: 'Acme', platform: 'lever' }],
    jobsTabUrl: 'https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0',
  });
  assert.match(html, /href="https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet123\/edit#gid=0"/);
  assert.match(html, /1 new role found today/);
});

test('appendDigestRow — un seul append, plage A:D, valeurs dans l’ordre attendu', async () => {
  const calls = [];
  const fakeClient = {
    spreadsheets: {
      values: {
        append: async (params) => {
          calls.push(params);
          return {};
        },
      },
    },
  };
  await appendDigestRow({
    sheetsClient: fakeClient,
    sheetId: 'sheet123',
    sheetName: 'Digest',
    row: ['2026-09-18', 'Job Digest — 2026-09-18 — 3 new roles', 3, '<div>...</div>'],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, 'Digest!A:D');
  assert.deepEqual(calls[0].requestBody.values, [
    ['2026-09-18', 'Job Digest — 2026-09-18 — 3 new roles', 3, '<div>...</div>'],
  ]);
});
