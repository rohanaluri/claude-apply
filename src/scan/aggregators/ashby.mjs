// Public Ashby aggregator.
//
// Same purpose as aggregators/lever.mjs and aggregators/greenhouse.mjs —
// discover offers across MANY Ashby-hosted boards without requiring each
// company to be declared in portals.yml. Uses the same public API
// (`api.ashbyhq.com`) already used by ats/ashby.mjs for tracked_companies.
//
// Board list source: known-ashby-boards.json, a one-time import of
// Feashliaa/job-board-aggregator's data/ashby_companies.json (3,161 slugs,
// harvested from Common Crawl — see that repo's README). Same source and
// method as known-lever-boards.json's import. This is a static snapshot,
// not a live sync: new Ashby companies that started after that crawl won't
// appear here until the list is refreshed by hand. Per that repo's README,
// the curated `data/` datasets are licensed CC BY-NC 4.0 (non-commercial
// use, attribution required) — fine for this personal job-search tool, not
// for redistribution or commercial use.
//
// Modeled on aggregators/lever.mjs rather than aggregators/greenhouse.mjs:
// at 3,161 boards this is much closer to Lever's scale than to Greenhouse's
// old 20-board list, so it carries the same per-board timeout and
// shuffle/progress-logging protection Lever needed at scale.

import { fetchAshby } from '../ats/ashby.mjs';
import { pLimit } from '../../lib/p-limit.mjs';
import { checkTitle } from '../../lib/prefilter-rules.mjs';
import knownBoards from './known-ashby-boards.json' with { type: 'json' };

const FETCH_CONCURRENCY = 6;

// Same rationale as lever.mjs: fetchAshby() has no built-in timeout, and one
// hung request would permanently occupy one of only 6 concurrency slots and
// stall the whole run. Does NOT cancel the underlying HTTP request — just
// stops waiting on it so the aggregator can move on to the next board.
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
  onProgress = null,
  titleFilter = null,
} = {}) {
  const titleRe = compileWordRegex(keywords);
  const locationRe = compileSubstringRegex(locations);

  const shuffled = shuffle(boards.filter((b) => b && typeof b.slug === 'string'));
  const validBoards =
    Number.isFinite(maxBoardsPerRun) && maxBoardsPerRun < shuffled.length
      ? shuffled.slice(0, maxBoardsPerRun)
      : shuffled;
  const concurrency = pLimit(FETCH_CONCURRENCY);

  let completed = 0;
  const PROGRESS_EVERY = 100;
  const startedAt = Date.now();
  process.stderr.write(
    `[ashby aggregator] scanning ${validBoards.length}/${shuffled.length} boards (concurrency ${FETCH_CONCURRENCY}, ${BOARD_FETCH_TIMEOUT_MS}ms/board timeout)...\n`
  );

  // Filtering happens INSIDE each board's own callback, immediately after
  // that board's response arrives — not in a second pass after every board
  // has already finished. Only the (usually tiny) list of survivors is
  // pushed to the shared `offers` array below; each board's own raw,
  // unfiltered response becomes garbage as soon as its callback returns,
  // instead of every board's full result sitting in memory simultaneously
  // until the very end. Combined with includeBody: false (no full job
  // description downloaded here at all), this is the fix for the
  // out-of-memory crash seen at full aggregator scale (2026-09-20).
  const offers = [];
  const warnings = [];

  await Promise.all(
    validBoards.map((board) =>
      concurrency(async () => {
        const company = board.company || board.slug;
        try {
          const raw = await withTimeout(
            fetchAshby(board.slug, company, { includeBody: false }),
            BOARD_FETCH_TIMEOUT_MS,
            board.slug
          );
          for (const o of raw) {
            const tagged = { ...o, source: 'aggregator:ashby' };
            if (titleRe && !titleRe.test(tagged.title || '')) continue;
            if (locationRe && !locationRe.test(tagged.location || '')) continue;
            if (titleFilter && !checkTitle(tagged, titleFilter).pass) continue;
            if (offers.length < limit) offers.push(tagged);
          }
        } catch (err) {
          warnings.push({ slug: board.slug, company, error: err?.message });
        } finally {
          completed++;
          if (completed % PROGRESS_EVERY === 0 || completed === validBoards.length) {
            process.stderr.write(
              `[ashby aggregator] ${completed}/${validBoards.length} boards checked\n`
            );
          }
          if (typeof onProgress === 'function') onProgress(1);
        }
      })
    )
  );

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(`[ashby aggregator] done in ${elapsedSec}s\n`);

  return { offers, warnings };
}

export { knownBoards };
