import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostedAt } from '../../src/lib/posted-at.mjs';

test('normalizePostedAt — epoch ms et chaînes ISO avec offset → ISO UTC', () => {
  assert.equal(normalizePostedAt(1786470000000), '2026-08-11T17:40:00.000Z');
  assert.equal(normalizePostedAt('2026-09-03T13:30:34-04:00'), '2026-09-03T17:30:34.000Z');
});

test('normalizePostedAt — valeur absente ou invalide → ""', () => {
  for (const v of [undefined, null, '', 'not a date']) {
    assert.equal(normalizePostedAt(v), '');
  }
});
