// Hand-off file between `scan` and `digest`. The two run as separate `node`
// processes (one per Routine step), so `scan`'s in-memory `result.added`
// can't reach `digest` directly — it's written here instead.
//
// This file is OVERWRITTEN on every scan run (it only ever holds "what this
// run found"), unlike scan-history.tsv/pipeline.md which accumulate. In the
// cloud Routine, data/ doesn't survive between days anyway (fresh checkout
// each run), so "today's offers" and "everything currently in this file"
// are the same thing there. Locally, overwriting keeps a stale previous
// run's offers from leaking into today's digest if `scan` is skipped.

import fs from 'node:fs';
import path from 'node:path';

export function writeTodaysOffers(filePath, { date, offers }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    date,
    offers: (offers || []).map((o) => ({
      url: o.url || '',
      apply_url: o.apply_url || '',
      title: o.title || '',
      company: o.company || '',
      location: o.location || '',
      platform: o.platform || o._resultPlatform || '',
    })),
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// Returns { date: null, offers: [] } if the file doesn't exist yet (e.g.
// digest run manually before any scan) — callers treat that as "nothing
// new today", not an error.
export function readTodaysOffers(filePath) {
  if (!fs.existsSync(filePath)) return { date: null, offers: [] };
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
  return {
    date: parsed?.date || null,
    offers: Array.isArray(parsed?.offers) ? parsed.offers : [],
  };
}
