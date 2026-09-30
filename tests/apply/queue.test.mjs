import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, queueStatusFor } from '../../src/apply/index.mjs';

test('parseArgs — --queue needs no URL; flags combine', () => {
  assert.deepEqual(parseArgs(['--queue', '--dry-run']), {
    dryRun: true,
    port: 9222,
    maxAiCalls: 1,
    url: null,
    queue: true,
  });
});

test('parseArgs — a single URL still works as before', () => {
  const a = parseArgs(['https://jobs.lever.co/acme/123']);
  assert.equal(a.queue, false);
  assert.equal(a.url, 'https://jobs.lever.co/acme/123/apply');
});

test('queueStatusFor — filled → applied; anything else → needs attention', () => {
  assert.equal(queueStatusFor('Ready for review'), 'applied');
  for (const s of ['Failed', 'Discarded', undefined]) {
    assert.equal(queueStatusFor(s), 'needs attention');
  }
});
