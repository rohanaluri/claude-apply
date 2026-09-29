import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DIGEST_LIMITS,
  resolveDigestLimits,
  selectJobs,
} from '../../src/digest/select-jobs.mjs';

const NOW = new Date('2026-09-29T12:00:00Z');

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function offer(company, id, postedDaysAgo) {
  return {
    url: `https://x/${company}/${id}`,
    company,
    title: `Job ${id}`,
    posted_at: postedDaysAgo === null ? '' : daysAgo(postedDaysAgo),
  };
}

const urls = (offers) => offers.map((o) => o.url);

test('resolveDigestLimits — défauts 14 j / 3 par jour / 10 sur 30 j', () => {
  assert.deepEqual(resolveDigestLimits(undefined), {
    maxPostingAgeDays: 14,
    perCompanyPerDay: 3,
    windowDays: 30,
    perCompanyPerWindow: 10,
  });
  assert.deepEqual(resolveDigestLimits(null), { ...DEFAULT_DIGEST_LIMITS });
});

test('resolveDigestLimits — surcharge partielle, null désactive une règle', () => {
  assert.deepEqual(resolveDigestLimits({ per_company_per_day: 5, max_posting_age_days: null }), {
    maxPostingAgeDays: null,
    perCompanyPerDay: 5,
    windowDays: 30,
    perCompanyPerWindow: 10,
  });
});

test('resolveDigestLimits — rejette clé inconnue et valeurs non entières', () => {
  assert.throws(() => resolveDigestLimits({ per_day: 3 }), /unknown field per_day/);
  assert.throws(() => resolveDigestLimits({ window_days: 1.5 }), /window_days/);
  assert.throws(() => resolveDigestLimits('3'), /mapping/);
});

test('selectJobs — écarte les offres publiées il y a plus de 14 jours, garde celles sans date', () => {
  const offers = [offer('A', 1, 3), offer('B', 1, 15), offer('C', 1, null), offer('D', 1, 14)];
  const r = selectJobs(offers, { now: NOW });
  assert.deepEqual(urls(r.selected).sort(), ['https://x/A/1', 'https://x/C/1', 'https://x/D/1']);
  assert.equal(r.stale, 1);
});

test('selectJobs — 3 max par entreprise, les plus récentes gagnent, sans date en dernier', () => {
  const offers = [
    offer('SpaceX', 'old', 10),
    offer('SpaceX', 'undated', null),
    offer('SpaceX', 'newest', 0),
    offer('SpaceX', 'mid', 5),
    offer('SpaceX', 'new', 1),
    offer('Stripe', 1, 2),
  ];
  const r = selectJobs(offers, { now: NOW });
  const spacex = r.selected.filter((o) => o.company === 'SpaceX').map((o) => o.title);
  assert.deepEqual(spacex, ['Job newest', 'Job new', 'Job mid']);
  assert.ok(r.selected.some((o) => o.company === 'Stripe'));
  assert.equal(r.heldByDailyCap, 2);
});

test('selectJobs — le nom d’entreprise est comparé sans casse ni espaces', () => {
  const offers = [
    offer('Acme', 1, 1),
    offer('acme ', 2, 1),
    offer('ACME', 3, 1),
    offer('Acme', 4, 1),
  ];
  const r = selectJobs(offers, { now: NOW });
  assert.equal(r.selected.length, 3);
});

test('selectJobs — les lignes déjà trouvées aujourd’hui comptent dans le plafond journalier', () => {
  const history = [
    { dateFound: '2026-09-29', company: 'Acme' },
    { dateFound: '2026-09-29', company: 'Acme' },
  ];
  const r = selectJobs([offer('Acme', 1, 0), offer('Acme', 2, 0)], { now: NOW, history });
  assert.equal(r.selected.length, 1);
  assert.equal(r.heldByDailyCap, 1);
});

test('selectJobs — plafond glissant de 10 sur 30 jours (jour J inclus, J-30 exclu)', () => {
  const history = [
    ...Array.from({ length: 8 }, () => ({ dateFound: '2026-08-31', company: 'Acme' })), // J-29
    { dateFound: '2026-08-30', company: 'Acme' }, // J-30: hors fenêtre
    { dateFound: '2026-08-29', company: 'Acme' },
  ];
  const r = selectJobs([offer('Acme', 1, 0), offer('Acme', 2, 0), offer('Acme', 3, 0)], {
    now: NOW,
    history,
  });
  assert.equal(r.selected.length, 2);
  assert.equal(r.heldByWindowCap, 1);
});

test('selectJobs — entreprise déjà au plafond glissant : rien n’est envoyé', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    dateFound: `2026-09-${String(10 + i).padStart(2, '0')}`,
    company: 'Acme',
  }));
  const r = selectJobs([offer('Acme', 1, 0)], { now: NOW, history });
  assert.equal(r.selected.length, 0);
  assert.equal(r.heldByWindowCap, 1);
});

test('selectJobs — règles désactivées (null) laissent tout passer', () => {
  const offers = Array.from({ length: 12 }, (_, i) => offer('Acme', i, 100));
  const r = selectJobs(offers, {
    now: NOW,
    limits: {
      maxPostingAgeDays: null,
      perCompanyPerDay: null,
      windowDays: null,
      perCompanyPerWindow: null,
    },
  });
  assert.equal(r.selected.length, 12);
});
