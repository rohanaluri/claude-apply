import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchBoard,
  isRetryable,
  BoardTimeoutError,
  BOARD_FETCH_TIMEOUT_MS,
  BOARD_FETCH_ATTEMPTS,
} from '../../src/scan/aggregators/fetch-board.mjs';
import { fetchGreenhouse } from '../../src/scan/ats/greenhouse.mjs';
import { fetchLever } from '../../src/scan/ats/lever.mjs';
import { fetchAshby } from '../../src/scan/ats/ashby.mjs';

const BOARD = { slug: 'acme', company: 'Acme' };
const FAST = { timeoutMs: 30, retryDelayMs: 0 };

test('défauts — 30 s par board, 2 tentatives', () => {
  assert.equal(BOARD_FETCH_TIMEOUT_MS, 30_000);
  assert.equal(BOARD_FETCH_ATTEMPTS, 2);
});

test('isRetryable — timeout, erreur réseau, 429 et 5xx oui ; 404 et 403 non', () => {
  assert.equal(isRetryable(new BoardTimeoutError('acme', 10)), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
  assert.equal(isRetryable(new Error('Lever API acme: HTTP 429')), true);
  assert.equal(isRetryable(new Error('Ashby API acme: HTTP 503')), true);
  assert.equal(isRetryable(new Error('Greenhouse API acme: HTTP 404')), false);
  assert.equal(isRetryable(new Error('Lever API acme: HTTP 403')), false);
});

test('fetchBoard — un timeout annule la requête (signal) puis réessaie avec succès', async () => {
  const signals = [];
  const retried = [];
  let calls = 0;
  const fetchFn = async (slug, company, opts) => {
    calls++;
    signals.push(opts.signal);
    assert.equal(opts.includeBody, false);
    if (calls === 1) return new Promise(() => {}); // hangs forever
    return [{ url: 'https://x/1', company }];
  };
  const offers = await fetchBoard(fetchFn, BOARD, {
    ...FAST,
    onRetry: (b, err) => retried.push([b.slug, err.message]),
  });
  assert.deepEqual(offers, [{ url: 'https://x/1', company: 'Acme' }]);
  assert.equal(calls, 2);
  assert.equal(signals[0].aborted, true, 'first attempt must be aborted, not just abandoned');
  assert.ok(signals[0].reason instanceof BoardTimeoutError);
  assert.equal(signals[1].aborted, false);
  assert.deepEqual(retried, [['acme', 'timed out after 30ms: acme']]);
});

test('fetchBoard — abandonne après 2 timeouts avec le message "timed out"', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return new Promise(() => {});
  };
  await assert.rejects(() => fetchBoard(fetchFn, BOARD, FAST), /timed out after 30ms: acme/);
  assert.equal(calls, 2);
});

test('fetchBoard — HTTP 404 échoue immédiatement, sans retry', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    throw new Error('Lever API acme: HTTP 404');
  };
  await assert.rejects(() => fetchBoard(fetchFn, BOARD, FAST), /HTTP 404/);
  assert.equal(calls, 1);
});

test('fetchBoard — erreur réseau transitoire puis succès', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return [];
  };
  assert.deepEqual(await fetchBoard(fetchFn, BOARD, FAST), []);
  assert.equal(calls, 2);
});

let restore;
afterEach(() => {
  if (restore) restore();
  restore = null;
});

test('fetchers ATS — transmettent le signal à fetch()', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts?.signal);
    const body = url.includes('lever') ? [] : { jobs: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  restore = () => {
    globalThis.fetch = original;
  };
  const { signal } = new AbortController();
  await fetchGreenhouse('acme', 'Acme', { includeBody: false, signal });
  await fetchLever('acme', 'Acme', { includeBody: false, signal });
  await fetchAshby('acme', 'Acme', { includeBody: false, signal });
  assert.deepEqual(seen, [signal, signal, signal]);
});
