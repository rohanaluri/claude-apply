import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMockFetch } from '../helpers.mjs';
import { fetchLever } from '../../src/scan/ats/lever.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'lever-mistral.json');

let restore;
afterEach(() => {
  if (restore) restore();
});

test('fetchLever — mappe correctement une fixture réelle', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  restore = installMockFetch({
    'https://api.lever.co/v0/postings/mistral?mode=json': fixture,
  });

  const offers = await fetchLever('mistral', 'Mistral AI');

  assert.ok(Array.isArray(offers), 'retourne un array');
  assert.equal(offers.length, fixture.length, 'même nombre que la fixture');

  if (offers.length > 0) {
    const o = offers[0];
    assert.equal(typeof o.url, 'string');
    assert.ok(o.url.startsWith('https://jobs.lever.co/mistral/'));
    assert.equal(typeof o.title, 'string');
    assert.ok(o.title.length > 0);
    assert.equal(o.company, 'Mistral AI');
    assert.equal(typeof o.location, 'string');
    assert.equal(typeof o.body, 'string');
    assert.equal(o.platform, 'lever');
  }
});

test('fetchLever — apply_url vient de applyUrl quand présent, url reste hostedUrl', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  restore = installMockFetch({
    'https://api.lever.co/v0/postings/mistral?mode=json': fixture,
  });

  const offers = await fetchLever('mistral', 'Mistral AI');
  const withApplyUrl = fixture.findIndex((p) => p.applyUrl);
  assert.ok(withApplyUrl >= 0, 'la fixture doit contenir au moins un applyUrl');

  assert.equal(offers[withApplyUrl].apply_url, fixture[withApplyUrl].applyUrl);
  assert.equal(
    offers[withApplyUrl].url,
    fixture[withApplyUrl].hostedUrl,
    'url doit rester hostedUrl (clé de dédup), pas applyUrl'
  );
});

test('fetchLever — apply_url retombe sur "" si Lever omet applyUrl', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  restore = installMockFetch({
    'https://api.lever.co/v0/postings/mistral?mode=json': fixture,
  });

  const offers = await fetchLever('mistral', 'Mistral AI');
  const withoutApplyUrl = fixture.findIndex((p) => !p.applyUrl);
  assert.ok(withoutApplyUrl >= 0, 'la fixture doit contenir au moins une entrée sans applyUrl');
  assert.equal(offers[withoutApplyUrl].apply_url, '');
});

test('fetchLever — array vide si API retourne []', async () => {
  restore = installMockFetch({
    'https://api.lever.co/v0/postings/empty-co?mode=json': [],
  });
  const offers = await fetchLever('empty-co', 'EmptyCo');
  assert.deepEqual(offers, []);
});
