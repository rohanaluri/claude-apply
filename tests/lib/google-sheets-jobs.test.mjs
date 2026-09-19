import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readJobsUrls,
  appendJobsRows,
  JobsTabReadError,
  JOBS_TAB_COLUMNS,
} from '../../src/lib/google-sheets-jobs.mjs';

function fakeSheetsClient({ getValues, getError, appendCalls } = {}) {
  return {
    spreadsheets: {
      values: {
        get: async (params) => {
          if (getError) throw getError;
          return { data: { values: getValues ?? [] } };
        },
        append: async (params) => {
          if (appendCalls) appendCalls.push(params);
          return {};
        },
      },
    },
  };
}

test('JOBS_TAB_COLUMNS — ordre confirmé avec Rohan (2026-09-18)', () => {
  assert.deepEqual(JOBS_TAB_COLUMNS, [
    'date_found',
    'company',
    'title',
    'location',
    'url',
    'platform',
    'apply_url',
    'status',
    'notes',
    'capply_command',
  ]);
});

test('readJobsUrls — extrait la colonne url (index 4), ignore la ligne d’en-tête', async () => {
  const client = fakeSheetsClient({
    getValues: [
      ['date_found', 'company', 'title', 'location', 'url', 'platform', 'apply_url', '', '', ''],
      [
        '2026-09-17',
        'Acme',
        'Analyst',
        'Remote',
        'https://jobs.lever.co/acme/1',
        'lever',
        '',
        '',
        '',
        '',
      ],
      [
        '2026-09-17',
        'Beta',
        'Engineer',
        'Paris',
        'https://jobs.lever.co/beta/2',
        'lever',
        '',
        '',
        '',
        '',
      ],
    ],
  });
  const urls = await readJobsUrls({ sheetsClient: client, sheetId: 'sheet123', sheetName: 'Jobs' });
  assert.ok(urls.has('https://jobs.lever.co/acme/1'));
  assert.ok(urls.has('https://jobs.lever.co/beta/2'));
  assert.equal(urls.size, 2);
});

test('readJobsUrls — feuille vide (juste l’en-tête, ou totalement vide) renvoie un Set vide', async () => {
  const client = fakeSheetsClient({ getValues: [] });
  const urls = await readJobsUrls({ sheetsClient: client, sheetId: 'sheet123', sheetName: 'Jobs' });
  assert.equal(urls.size, 0);
});

test('readJobsUrls — échoue de façon explicite (JobsTabReadError) si l’appel Sheets échoue', async () => {
  const client = fakeSheetsClient({ getError: new Error('permission denied') });
  await assert.rejects(
    () => readJobsUrls({ sheetsClient: client, sheetId: 'sheet123', sheetName: 'Jobs' }),
    JobsTabReadError
  );
});

test('appendJobsRows — n’appelle pas Sheets si la liste est vide', async () => {
  const appendCalls = [];
  const client = fakeSheetsClient({ appendCalls });
  const result = await appendJobsRows({
    sheetsClient: client,
    sheetId: 'sheet123',
    sheetName: 'Jobs',
    offers: [],
    dateFound: '2026-09-18',
  });
  assert.equal(result.appended, 0);
  assert.equal(appendCalls.length, 0);
});

test('appendJobsRows — un seul appel batch, colonnes A:I seulement (capply_command jamais écrite)', async () => {
  const appendCalls = [];
  const client = fakeSheetsClient({ appendCalls });
  const offers = [
    {
      url: 'https://jobs.lever.co/acme/1',
      apply_url: 'https://jobs.lever.co/acme/1/apply',
      title: 'Data Analyst',
      company: 'Acme',
      location: 'Remote',
      platform: 'lever',
    },
    {
      url: 'https://jobs.lever.co/beta/2',
      title: 'ML Engineer',
      company: 'Beta',
      location: 'Paris',
      platform: 'lever',
      // apply_url intentionally omitted
    },
  ];
  const result = await appendJobsRows({
    sheetsClient: client,
    sheetId: 'sheet123',
    sheetName: 'Jobs',
    offers,
    dateFound: '2026-09-18',
  });

  assert.equal(result.appended, 2);
  assert.equal(appendCalls.length, 1, 'un seul appel batch, pas un par job');
  assert.equal(appendCalls[0].range, 'Jobs!A:I');
  assert.equal(
    appendCalls[0].insertDataOption,
    'OVERWRITE',
    'OVERWRITE (pas INSERT_ROWS) pour ne jamais décaler les références de la formule J1'
  );
  assert.deepEqual(appendCalls[0].requestBody.values, [
    [
      '2026-09-18',
      'Acme',
      'Data Analyst',
      'Remote',
      'https://jobs.lever.co/acme/1',
      'lever',
      'https://jobs.lever.co/acme/1/apply',
      '',
      '',
    ],
    [
      '2026-09-18',
      'Beta',
      'ML Engineer',
      'Paris',
      'https://jobs.lever.co/beta/2',
      'lever',
      '',
      '',
      '',
    ],
  ]);
  // Every row must have exactly 9 values (A:I) — never a 10th for col J.
  for (const row of appendCalls[0].requestBody.values) {
    assert.equal(row.length, 9);
  }
});
