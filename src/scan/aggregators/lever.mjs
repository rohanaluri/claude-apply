// Public Lever aggregator.
//
// Same purpose as aggregators/greenhouse.mjs — discover offers across MANY
// Lever-hosted boards without requiring each company to be declared in
// portals.yml. Uses the same public API (`api.lever.co`) already used by
// ats/lever.mjs for tracked_companies.
//
// Board list source: known-lever-boards.json, a one-time import of
// Feashliaa/job-board-aggregator's data/lever_companies.json (4,368 slugs,
// harvested from Common Crawl — see that repo's README). This is a static
// snapshot, not a live sync: new Lever companies that started after that
// crawl won't appear here until the list is refreshed by hand.
//
// TEMPORARY (2026-09-05): to keep Phase 2 cheap while we validate this
// works, the daily run caps at 10 new offers per scan and does NOT
// accumulate a backlog — anything beyond 10 is simply not looked at that
// day, not queued. See index.mjs's MAX_NEW_OFFERS_PER_RUN. Revisit once
// real volume is observed.

import { fetchLever } from '../ats/lever.mjs';
import { pLimit } from '../../lib/p-limit.mjs';
import knownBoards from './known-lever-boards.json' with { type: 'json' };

const FETCH_CONCURRENCY = 6;

// TEMPORARY (2026-09-05): fetchLever() has no built-in timeout. At 4,368
// boards, even one hung request (no response, not even an error) permanently
// occupies one of only 6 concurrency slots and stalls the whole run —
// same failure shape as Decision #26 in pipeline-architecture.md
// (Playwright's selectOption() not failing fast). This does NOT cancel the
// underlying HTTP request (fetchLever takes no AbortSignal) — it just stops
// waiting on it so the aggregator can move on to the next board.
const BOARD_FETCH_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function compileWordRegex(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const escaped = terms.map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}

function compileSubstringRegex(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const escaped = terms.map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:${escaped.join('|')})`, 'i');
}

// Fisher-Yates shuffle, returns a new array (does not mutate input).
// Used so the daily scan doesn't always hit the same alphabetically-early
// slugs first and starve the rest of the list.
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function fetchAggregator({
  keywords = [],
  locations = [],
  limit = Infinity,
  boards = knownBoards,
  maxBoardsPerRun = Infinity,
} = {}) {
  const titleRe = compileWordRegex(keywords);
  const locationRe = compileSubstringRegex(locations);

  const shuffled = shuffle(boards.filter((b) => b && typeof b.slug === 'string'));
  // TEMPORARY (2026-09-05): cap how many boards get FETCHED this run, not
  // just how many offers get kept. Without this, every run checks all
  // 4,368 boards regardless of how few offers you actually want — a
  // multi-minute run for a 10-offer result. Random shuffle happens first,
  // so which boards get checked still varies day to day.
  const validBoards =
    Number.isFinite(maxBoardsPerRun) && maxBoardsPerRun < shuffled.length
      ? shuffled.slice(0, maxBoardsPerRun)
      : shuffled;
  const concurrency = pLimit(FETCH_CONCURRENCY);

  let completed = 0;
  const PROGRESS_EVERY = 100;
  const startedAt = Date.now();
  process.stderr.write(
    `[lever aggregator] scanning ${validBoards.length}/${shuffled.length} boards (concurrency ${FETCH_CONCURRENCY}, ${BOARD_FETCH_TIMEOUT_MS}ms/board timeout)...\n`
  );

  const settled = await Promise.all(
    validBoards.map((board) =>
      concurrency(async () => {
        const company = board.company || board.slug;
        try {
          const raw = await withTimeout(
            fetchLever(board.slug, company),
            BOARD_FETCH_TIMEOUT_MS,
            board.slug
          );
          return { board, company, raw, error: null };
        } catch (err) {
          return { board, company, raw: null, error: err };
        } finally {
          completed++;
          if (completed % PROGRESS_EVERY === 0 || completed === validBoards.length) {
            process.stderr.write(
              `[lever aggregator] ${completed}/${validBoards.length} boards checked\n`
            );
          }
        }
      })
    )
  );

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(`[lever aggregator] done in ${elapsedSec}s\n`);

  const offers = [];
  const warnings = [];

  for (const r of settled) {
    if (r.error) {
      warnings.push({ slug: r.board.slug, company: r.company, error: r.error?.message });
      continue;
    }
    for (const o of r.raw) {
      const tagged = { ...o, source: 'aggregator:lever' };
      if (titleRe && !titleRe.test(tagged.title || '')) continue;
      if (locationRe && !locationRe.test(tagged.location || '')) continue;
      offers.push(tagged);
      if (offers.length >= limit) {
        return { offers, warnings };
      }
    }
  }

  return { offers, warnings };
}

export { knownBoards };
