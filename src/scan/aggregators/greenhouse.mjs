// Public Greenhouse aggregator.
//
// Unlike per-company ATS fetchers, this module discovers offers across MANY
// Greenhouse-hosted boards without requiring the user to declare each company
// in portals.yml. It piggybacks on the same public API
// (`boards-api.greenhouse.io`) already used by ats/greenhouse.mjs.
//
// Why Greenhouse and not Simplify? Simplify's ToS forbids automated scraping
// of simplify.jobs. Greenhouse's `boards-api` is an unauthenticated, publicly
// documented JSON API meant for board embedding — the same one we already use
// per company.
//
// Board list source: known-greenhouse-boards.json, expanded 2026-09-20 from
// a ~20-company hand-curated list to a one-time import of
// Feashliaa/job-board-aggregator's data/greenhouse_companies.json (8,333
// slugs, harvested from Common Crawl — same source/method as
// known-lever-boards.json's import, see that repo's README). Static
// snapshot, not a live sync. Per that repo's README, the curated `data/`
// datasets are licensed CC BY-NC 4.0 (non-commercial use, attribution
// required) — fine for this personal job-search tool, not for
// redistribution or commercial use.
//
// Timeout + shuffle + progress-logging added 2026-09-20 alongside the list
// expansion, mirroring aggregators/lever.mjs: at 8,333 boards this module
// carries the same risk documented there — fetchGreenhouse() has no
// built-in timeout, so one hung request would permanently occupy one of
// only 6 concurrency slots and stall the whole run. Was safe to omit at the
// old 20-board scale; is not at this one.

import { fetchGreenhouse } from '../ats/greenhouse.mjs';
import { pLimit } from '../../lib/p-limit.mjs';
import { checkTitle } from '../../lib/prefilter-rules.mjs';
import knownBoards from './known-greenhouse-boards.json' with { type: 'json' };

const FETCH_CONCURRENCY = 6;

// Does NOT cancel the underlying HTTP request (fetchGreenhouse takes no
// AbortSignal) — it just stops waiting on it so the aggregator can move on.
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
    `[greenhouse aggregator] scanning ${validBoards.length}/${shuffled.length} boards (concurrency ${FETCH_CONCURRENCY}, ${BOARD_FETCH_TIMEOUT_MS}ms/board timeout)...\n`
  );

  // Filtering happens INSIDE each board's own callback, immediately after
  // that board's response arrives — not in a second pass after every board
  // has already finished. Only the (usually tiny) list of survivors is
  // pushed to the shared `offers` array below; each board's own raw,
  // unfiltered response becomes garbage as soon as its callback returns,
  // instead of every board's full result sitting in memory simultaneously
  // until the very end. Combined with includeBody: false (no full job
  // description downloaded or HTML-stripped here at all), this is the fix
  // for the out-of-memory crash seen at full aggregator scale (2026-09-20)
  // — Greenhouse's own ?content=true was the single largest source of it.
  const offers = [];
  const warnings = [];

  await Promise.all(
    validBoards.map((board) =>
      concurrency(async () => {
        const company = board.company || board.slug;
        try {
          const raw = await withTimeout(
            fetchGreenhouse(board.slug, company, { includeBody: false }),
            BOARD_FETCH_TIMEOUT_MS,
            board.slug
          );
          for (const o of raw) {
            const tagged = { ...o, source: 'aggregator:greenhouse' };
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
              `[greenhouse aggregator] ${completed}/${validBoards.length} boards checked\n`
            );
          }
          if (typeof onProgress === 'function') onProgress(1);
        }
      })
    )
  );

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(`[greenhouse aggregator] done in ${elapsedSec}s\n`);

  return { offers, warnings };
}

export { knownBoards };
