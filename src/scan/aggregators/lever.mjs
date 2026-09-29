// Public Lever aggregator.
//
// Same purpose as aggregators/greenhouse.mjs — discover offers across MANY
// Lever-hosted boards without requiring each company to be declared in
// portals.yml. Uses the same public API (`api.lever.co`) already used by
// ats/lever.mjs for tracked_companies.
//
// Board list source: known-lever-boards.json — 81 companies, in rank
// order: a curated top-250 Lever list (2026-09-29) minus the slugs whose
// board returned HTTP 404 (the company has left Lever). Trimmed down from a
// full 4,368-slug Common Crawl import (Feashliaa/job-board-aggregator, CC
// BY-NC 4.0) that was producing thousands of offers per day. The full list
// is recoverable from git history if the list needs to grow again.
//
// Each board is fetched through fetchBoard() (./fetch-board.mjs): per-board
// timeout with real cancellation, plus one retry — see that file for why.

import { fetchLever } from '../ats/lever.mjs';
import { fetchBoard, BOARD_FETCH_TIMEOUT_MS, BOARD_FETCH_ATTEMPTS } from './fetch-board.mjs';
import { pLimit } from '../../lib/p-limit.mjs';
import { checkTitle } from '../../lib/prefilter-rules.mjs';
import knownBoards from './known-lever-boards.json' with { type: 'json' };

const FETCH_CONCURRENCY = 6;

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
  onProgress = null,
  titleFilter = null,
} = {}) {
  const titleRe = compileWordRegex(keywords);
  const locationRe = compileSubstringRegex(locations);

  const validBoards = shuffle(boards.filter((b) => b && typeof b.slug === 'string'));
  const concurrency = pLimit(FETCH_CONCURRENCY);

  let completed = 0;
  const PROGRESS_EVERY = 100;
  const startedAt = Date.now();
  process.stderr.write(
    `[lever aggregator] scanning ${validBoards.length} boards (concurrency ${FETCH_CONCURRENCY}, ${BOARD_FETCH_TIMEOUT_MS}ms/board timeout, ${BOARD_FETCH_ATTEMPTS} attempts)...\n`
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
          const raw = await fetchBoard(fetchLever, board, {
            onRetry: (b, err) =>
              process.stderr.write(`[lever aggregator] retrying ${b.slug} (${err.message})\n`),
          });
          for (const o of raw) {
            const tagged = { ...o, source: 'aggregator:lever' };
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
              `[lever aggregator] ${completed}/${validBoards.length} boards checked\n`
            );
          }
          if (typeof onProgress === 'function') onProgress(1);
        }
      })
    )
  );

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(`[lever aggregator] done in ${elapsedSec}s\n`);

  return { offers, warnings };
}

export { knownBoards };
