import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readJobsTab,
  readApplyQueue,
  setJobStatus,
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

test('readJobsTab — extrait la colonne url (index 4), ignore la ligne d’en-tête', async () => {
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
  const { urls } = await readJobsTab({
    sheetsClient: client,
    sheetId: 'sheet123',
    sheetName: 'Jobs',
  });
  assert.ok(urls.has('https://jobs.lever.co/acme/1'));
  assert.ok(urls.has('https://jobs.lever.co/beta/2'));
  assert.equal(urls.size, 2);
});

test('readJobsTab — feuille vide (juste l’en-tête, ou totalement vide) renvoie un Set vide', async () => {
  const client = fakeSheetsClient({ getValues: [] });
  const { urls } = await readJobsTab({
    sheetsClient: client,
    sheetId: 'sheet123',
    sheetName: 'Jobs',
  });
  assert.equal(urls.size, 0);
});

test('readJobsTab — échoue de façon explicite (JobsTabReadError) si l’appel Sheets échoue', async () => {
  const client = fakeSheetsClient({ getError: new Error('permission denied') });
  await assert.rejects(
    () => readJobsTab({ sheetsClient: client, sheetId: 'sheet123', sheetName: 'Jobs' }),
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

test('readJobsTab — renvoie les urls et l’historique { dateFound, company } des lignes datées', async () => {
  const client = fakeSheetsClient({
    getValues: [
      ['date_found', 'company', 'title', 'location', 'url'],
      ['2026-09-28', 'Acme', 'Analyst', 'Remote', 'https://x/1'],
      ['2026-09-29', ' Beta ', 'Engineer', 'NYC', 'https://x/2'],
      ['not a date', 'Gamma', 'Engineer', 'NYC', 'https://x/3'],
      ['2026-09-29', '', 'Engineer', 'NYC', 'https://x/4'],
    ],
  });
  const { urls, history } = await readJobsTab({
    sheetsClient: client,
    sheetId: 'sheet123',
    sheetName: 'Jobs',
  });
  assert.equal(urls.size, 4);
  assert.deepEqual(history, [
    { dateFound: '2026-09-28', company: 'Acme' },
    { dateFound: '2026-09-29', company: 'Beta' },
  ]);
});

test('readJobsTab — échoue de façon explicite (JobsTabReadError) si l’appel Sheets échoue', async () => {
  const client = fakeSheetsClient({ getError: new Error('quota') });
  await assert.rejects(
    () => readJobsTab({ sheetsClient: client, sheetId: 'sheet123', sheetName: 'Jobs' }),
    JobsTabReadError
  );
});

const HEADER = [
  'date_found',
  'company',
  'title',
  'location',
  'url',
  'platform',
  'apply_url',
  'status',
  'notes',
];

test('readApplyQueue — only rows with status "apply" (any case), with row numbers', async () => {
  const client = fakeSheetsClient({
    getValues: [
      HEADER,
      [
        '2026-09-29',
        'Acme',
        'Data Analyst',
        'NYC',
        'https://x/1',
        'lever',
        'https://x/1/apply',
        'apply',
      ],
      ['2026-09-29', 'Beta', 'Engineer', 'SF', 'https://x/2', 'ashby', '', 'applied'],
      ['2026-09-29', 'Gamma', 'Scientist', 'LA', 'https://x/3', 'greenhouse', '', ' Apply '],
      ['2026-09-29', 'Delta', 'Engineer', 'SF', 'https://x/4', 'ashby', ''],
    ],
  });
  const queue = await readApplyQueue({ sheetsClient: client, sheetId: 's', sheetName: 'Jobs' });
  assert.deepEqual(queue, [
    {
      row: 2,
      url: 'https://x/1',
      applyUrl: 'https://x/1/apply',
      company: 'Acme',
      title: 'Data Analyst',
    },
    { row: 4, url: 'https://x/3', applyUrl: '', company: 'Gamma', title: 'Scientist' },
  ]);
});

test('setJobStatus — finds the row by url and writes only its status cell (column H)', async () => {
  const updates = [];
  const client = fakeSheetsClient({
    getValues: [
      HEADER,
      ['2026-09-29', 'Beta', 'Engineer', 'SF', 'https://x/2', 'ashby', '', ''],
      ['2026-09-29', 'Acme', 'Data Analyst', 'NYC', 'https://x/1', 'lever', '', 'apply'],
    ],
  });
  client.spreadsheets.values.update = async (params) => {
    updates.push(params);
    return {};
  };
  const r = await setJobStatus({
    sheetsClient: client,
    sheetId: 's',
    sheetName: 'Jobs',
    url: 'https://x/1',
    status: 'applied',
  });
  assert.deepEqual(r, { row: 3 });
  assert.deepEqual(updates, [
    {
      spreadsheetId: 's',
      range: 'Jobs!H3',
      valueInputOption: 'RAW',
      requestBody: { values: [['applied']] },
    },
  ]);
});

test('setJobStatus — throws if the url is no longer in the sheet', async () => {
  const client = fakeSheetsClient({ getValues: [HEADER] });
  client.spreadsheets.values.update = async () => {
    throw new Error('must not write');
  };
  await assert.rejects(
    () =>
      setJobStatus({
        sheetsClient: client,
        sheetId: 's',
        sheetName: 'Jobs',
        url: 'https://x/9',
        status: 'applied',
      }),
    /no row with url/
  );
});
