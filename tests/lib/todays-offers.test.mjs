import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeTodaysOffers, readTodaysOffers } from '../../src/lib/todays-offers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todays-offers-'));

afterEach(() => {
  for (const f of fs.readdirSync(tmp)) {
    fs.unlinkSync(path.join(tmp, f));
  }
});

test('readTodaysOffers — fichier absent renvoie date null et offers vide', () => {
  const result = readTodaysOffers(path.join(tmp, 'nope.json'));
  assert.deepEqual(result, { date: null, offers: [] });
});

test('writeTodaysOffers puis readTodaysOffers — round-trip', () => {
  const filePath = path.join(tmp, 'todays-offers.json');
  const offers = [
    {
      url: 'https://jobs.lever.co/acme/1',
      apply_url: 'https://jobs.lever.co/acme/1/apply',
      title: 'Data Analyst',
      company: 'Acme',
      location: 'Remote',
      platform: 'lever',
    },
  ];
  writeTodaysOffers(filePath, { date: '2026-09-18', offers });
  const result = readTodaysOffers(filePath);
  assert.equal(result.date, '2026-09-18');
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].apply_url, 'https://jobs.lever.co/acme/1/apply');
});

test('writeTodaysOffers — remplit les champs manquants avec des chaînes vides', () => {
  const filePath = path.join(tmp, 'todays-offers.json');
  writeTodaysOffers(filePath, { date: '2026-09-18', offers: [{ url: 'https://x/1' }] });
  const result = readTodaysOffers(filePath);
  assert.deepEqual(result.offers[0], {
    url: 'https://x/1',
    apply_url: '',
    title: '',
    company: '',
    location: '',
    platform: '',
  });
});

test('writeTodaysOffers — écrase le run précédent (pas d’accumulation)', () => {
  const filePath = path.join(tmp, 'todays-offers.json');
  writeTodaysOffers(filePath, { date: '2026-09-17', offers: [{ url: 'https://x/1' }] });
  writeTodaysOffers(filePath, { date: '2026-09-18', offers: [{ url: 'https://x/2' }] });
  const result = readTodaysOffers(filePath);
  assert.equal(result.date, '2026-09-18');
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].url, 'https://x/2');
});

test('readTodaysOffers — lève une erreur claire si le JSON est invalide', () => {
  const filePath = path.join(tmp, 'bad.json');
  fs.writeFileSync(filePath, 'not json{');
  assert.throws(() => readTodaysOffers(filePath), /not valid JSON/);
});
