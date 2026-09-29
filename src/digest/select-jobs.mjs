// Decides which of today's unseen offers actually get sent (Decision #38 in
// docs/project-notes/pipeline-architecture.md). Runs AFTER the Jobs-tab URL
// dedupe, never in `scan`: the cloud Routine's scan starts with an empty
// history every day, so a cap applied there would pick the same N jobs
// daily and the URL dedupe would then drop all of them.
//
// Rules, in order:
//   1. Freshness: drop offers whose `posted_at` is older than
//      maxPostingAgeDays. Offers with no `posted_at` are kept (but sort last).
//   2. Newest first by `posted_at`, so the per-company slots go to the
//      newest postings.
//   3. Per company, allow at most perCompanyPerDay (minus rows already
//      found today) AND at most perCompanyPerWindow within the last
//      windowDays (counting today, from the Jobs tab `history`).
// Anything held back is NOT recorded anywhere — it's re-evaluated on the
// next run, and ages out once it passes the freshness window.
//
// A limit set to null disables that rule.

export const DEFAULT_DIGEST_LIMITS = Object.freeze({
  maxPostingAgeDays: 14,
  perCompanyPerDay: 3,
  windowDays: 30,
  perCompanyPerWindow: 10,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Reads `digest_limits` from candidate-profile.yml (snake_case) on top of
// the defaults. An explicit `null` disables a rule; a missing key keeps
// the default.
export function resolveDigestLimits(profileLimits) {
  const map = {
    max_posting_age_days: 'maxPostingAgeDays',
    per_company_per_day: 'perCompanyPerDay',
    window_days: 'windowDays',
    per_company_per_window: 'perCompanyPerWindow',
  };
  if (profileLimits === null || profileLimits === undefined) return { ...DEFAULT_DIGEST_LIMITS };
  if (typeof profileLimits !== 'object' || Array.isArray(profileLimits)) {
    throw new Error('digest_limits must be a mapping');
  }
  for (const k of Object.keys(profileLimits)) {
    if (!(k in map)) throw new Error(`digest_limits: unknown field ${k}`);
  }
  const limits = { ...DEFAULT_DIGEST_LIMITS };
  for (const [yamlKey, key] of Object.entries(map)) {
    if (!(yamlKey in profileLimits)) continue;
    const v = profileLimits[yamlKey];
    if (v === null) {
      limits[key] = null;
    } else if (Number.isInteger(v) && v >= 0) {
      limits[key] = v;
    } else {
      throw new Error(`digest_limits.${yamlKey} must be a non-negative integer or null, got ${v}`);
    }
  }
  return limits;
}

function companyKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase();
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function postedMs(offer) {
  const t = offer.posted_at ? Date.parse(offer.posted_at) : NaN;
  return Number.isNaN(t) ? null : t;
}

export function selectJobs(offers, { now = new Date(), history = [], limits } = {}) {
  const { maxPostingAgeDays, perCompanyPerDay, windowDays, perCompanyPerWindow } = {
    ...DEFAULT_DIGEST_LIMITS,
    ...limits,
  };
  const today = isoDay(now);

  const fresh = [];
  let stale = 0;
  for (const o of offers) {
    const t = postedMs(o);
    if (
      maxPostingAgeDays !== null &&
      t !== null &&
      now.getTime() - t > maxPostingAgeDays * DAY_MS
    ) {
      stale++;
      continue;
    }
    fresh.push(o);
  }

  const sorted = fresh
    .map((o, i) => ({ o, i, t: postedMs(o) }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return b.t - a.t || a.i - b.i;
    })
    .map(({ o }) => o);

  const windowStart =
    windowDays !== null ? isoDay(new Date(now.getTime() - (windowDays - 1) * DAY_MS)) : null;
  const sentToday = new Map();
  const sentInWindow = new Map();
  for (const h of history) {
    const key = companyKey(h.company);
    if (h.dateFound === today) sentToday.set(key, (sentToday.get(key) || 0) + 1);
    if (windowStart !== null && h.dateFound >= windowStart && h.dateFound <= today) {
      sentInWindow.set(key, (sentInWindow.get(key) || 0) + 1);
    }
  }

  const selected = [];
  let heldByDailyCap = 0;
  let heldByWindowCap = 0;
  for (const o of sorted) {
    const key = companyKey(o.company);
    const todayCount = sentToday.get(key) || 0;
    const inWindow = sentInWindow.get(key) || 0;
    if (perCompanyPerWindow !== null && windowDays !== null && inWindow >= perCompanyPerWindow) {
      heldByWindowCap++;
      continue;
    }
    if (perCompanyPerDay !== null && todayCount >= perCompanyPerDay) {
      heldByDailyCap++;
      continue;
    }
    selected.push(o);
    sentToday.set(key, todayCount + 1);
    sentInWindow.set(key, inWindow + 1);
  }

  return { selected, stale, heldByDailyCap, heldByWindowCap };
}
