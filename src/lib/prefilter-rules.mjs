// Pure functions for deterministic pre-filtering of job offers.
// Each function returns {pass: true} or {pass: false, reason: string}.

import { detectRequiredLanguages, levelRank, MIN_LANGUAGE_LEVEL } from './language-detect.mjs';

const LOCATION_FR_RE =
  /\b(france|paris|lyon|toulouse|marseille|bordeaux|lille|nantes|grenoble|sophia[- ]antipolis|rennes|compi[eè]gne|strasbourg|montpellier|nice|saclay|issy[- ]les[- ]moulineaux|boulogne[- ]billancourt|la d[eé]fense|courbevoie|nanterre|suresnes|massy|clermont[- ]ferrand|aix[- ]en[- ]provence|toulon|dijon|reims|tours|metz|brest|caen|rouen|le mans|remote.*france|t[eé]l[eé]travail|full.remote.eu)\b/i;
const LOCATION_FOREIGN_RE =
  /\b(new york|nyc|london|berlin|munich|san francisco|sf bay|palo alto|tokyo|seoul|singapore|dubai|mena|morocco|sydney|australia|montreal|warsaw|poland|sweden|stockholm|netherlands|amsterdam|spain|madrid|barcelona|germany|luxembourg|italy|italian|milan|rome|austria|vienna|switzerland|zurich|geneva|denmark|copenhagen|norway|oslo|finland|helsinki|ireland|dublin|belgium|brussels|usa only|uk only|us citizens? only|green card|visa sponsorship not)\b/i;

const LOCATION_SEG_RE = /\s*[-/,]\s*/;
const REMOTE_RE = /^remote$/i;

function splitLocationSegments(loc) {
  return loc
    .split(LOCATION_SEG_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

// US states + DC, full name and postal abbreviation. Real ATS location
// fields are almost always "City, ST" (e.g. "Austin, TX") or occasionally
// "City, State" (e.g. "Austin, Texas") — never "United States" spelled out.
// Fixed 2026-09-18: the old targetLocations substring match (matching
// "Remote"/"United States"/"USA" literally) rejected nearly every plain
// US city/state posting, since none of those strings appear in a normal
// "City, ST" location. See pipeline-architecture.md Decision (2026-09-18,
// location prefilter).
const US_STATES = [
  ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
  ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
  ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'],
  ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
  ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
  ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'],
  ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
  ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
  ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'],
  ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
  ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
  ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'],
  ['Wisconsin', 'WI'], ['Wyoming', 'WY'], ['District of Columbia', 'DC'],
];

// Whole-word match on full state names only (e.g. "Austin, Texas"). Full
// names are distinctive enough that a word-boundary match is safe — unlike
// the 2-letter abbreviations below, no full state name doubles as a common
// English word ("Georgia", "Washington", etc. are unambiguous here).
const US_STATE_NAME_RE = new RegExp(`\\b(?:${US_STATES.map(([name]) => name).join('|')})\\b`, 'i');

// Exact-segment match on abbreviations only (e.g. the "TX" in "Austin, TX"
// after splitting on the comma) — NOT a word-boundary substring match.
// Several abbreviations are common English words/words-in-context ("OR",
// "IN", "ME", "HI", "OK", "PA", "CO"...), so testing them against an
// arbitrary segment risks false positives (e.g. "Remote or Mississauga"
// contains the word "or", which would wrongly match Oregon). Requiring the
// *entire* trimmed segment to equal the abbreviation avoids that: a real
// abbreviation only ever appears as its own segment ("City, ST"), never
// buried inside a longer phrase.
const US_STATE_ABBR_SET = new Set(US_STATES.map(([, abbr]) => abbr));

function isUSSegment(seg) {
  const trimmed = seg.trim();
  if (US_STATE_ABBR_SET.has(trimmed.toUpperCase())) return true;
  return US_STATE_NAME_RE.test(trimmed);
}

function targetsFrance(targetLocations) {
  return (targetLocations || []).some((t) => LOCATION_FR_RE.test(String(t)));
}

// Mirrors targetsFrance — true only if targetLocations explicitly names the
// US/USA (NOT just "Remote" — a candidate targeting France remotely also
// has "Remote" in their list, and this fallback must never fire for them).
const US_TARGET_RE = /\b(united states|usa|u\.s\.a?\.?)\b/i;
function targetsUS(targetLocations) {
  return (targetLocations || []).some((t) => US_TARGET_RE.test(String(t)));
}

export function checkLocation(offer, targetLocations) {
  const loc = offer.location || '';

  // Structured location available — use positive matching
  if (loc) {
    const segments = splitLocationSegments(loc);
    const geoSegments = segments.filter((s) => !REMOTE_RE.test(s));

    if (geoSegments.length === 0) {
      // Pure "Remote" with no geographic qualifier — ambiguous, pass
      return { pass: true };
    }

    const match = geoSegments.some((seg) =>
      (targetLocations || []).some((t) => seg.toLowerCase().includes(t.toLowerCase()))
    );
    if (match) return { pass: true };

    // France-oriented fallback: if the user targets France (country or any FR
    // city in targetLocations) and the offer's location is a recognized French
    // city, accept it. Handles ATSes that return "Paris" bare without country.
    if (targetsFrance(targetLocations) && geoSegments.some((seg) => LOCATION_FR_RE.test(seg))) {
      return { pass: true };
    }

    // US-oriented fallback (added 2026-09-18): if the user targets the US
    // and the offer's location names a US state, accept it — handles the
    // overwhelmingly common "City, ST" / "City, State" shape that never
    // spells out "United States" and was previously rejected outright.
    if (targetsUS(targetLocations) && geoSegments.some((seg) => isUSSegment(seg))) {
      return { pass: true };
    }

    return { pass: false, reason: `location: ${loc} not in target zones` };
  }

  // Fallback: no structured location — use regex heuristic on title + body
  const title = offer.title || '';
  const body = offer.body || '';
  const titleHasForeign = LOCATION_FOREIGN_RE.test(title);
  const titleHasFr = LOCATION_FR_RE.test(title);
  if (titleHasForeign && !titleHasFr) {
    return { pass: false, reason: 'location: foreign in title, no FR' };
  }
  const haystack = `${title} ${body}`;
  if (LOCATION_FR_RE.test(haystack)) return { pass: true };
  if (LOCATION_FOREIGN_RE.test(body)) return { pass: false, reason: 'location: foreign only' };
  return { pass: true };
}

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
};

function parseDates(text) {
  const out = [];
  const re =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    const year = parseInt(m[2], 10);
    if (month && year) out.push(new Date(Date.UTC(year, month - 1, 1)));
  }
  return out;
}

export function checkStartDate(offer, minStartDateIso) {
  const text = offer.body || '';
  const dates = parseDates(text);
  if (dates.length === 0) return { pass: true };
  const min = new Date(minStartDateIso);
  // Keep offer if at least one plausible start date is ≥ min
  const anyValid = dates.some(
    (d) => d >= new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1))
  );
  if (anyValid) return { pass: true };
  return { pass: false, reason: `start_date: all parsed dates before ${minStartDateIso}` };
}

// Compile a title-filter term into a RegExp.
//
// Escape hatch: a term of the form "/pattern/flags" is parsed as a real regex.
// Case-insensitivity is enforced — if the user omits "i", we add it.
//
// Plain string: case-insensitive, word-boundary match with special chars
// escaped. "stage" → /\bstage\b/i, matches "Stage Data" but NOT "Backstage".
function compileMatcher(term) {
  const s = String(term);
  const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (m) {
      const flags = m[2].includes('i') ? m[2] : m[2] + 'i';
      return new RegExp(m[1], flags);
    }
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  } catch (err) {
    const e = new Error(`invalid title_filter term "${s}": ${err.message}`);
    e.code = 'INVALID_TITLE_FILTER_TERM';
    e.term = s;
    throw e;
  }
}

function findMatch(terms, title) {
  for (const t of terms || []) {
    if (compileMatcher(t).test(title)) return t;
  }
  return null;
}

export function checkTitle(offer, whitelist, opts = {}) {
  const title = offer.title || '';
  const body = opts.body || '';
  try {
    const neg = findMatch(whitelist.negative, title);
    if (neg) return { pass: false, reason: `title: negative match "${neg}"` };
    const pos = findMatch(whitelist.positive, title);
    if (!pos) return { pass: false, reason: 'title: no positive match' };
    if (Array.isArray(whitelist.required_any) && whitelist.required_any.length > 0) {
      const haystack = body ? `${title}\n${body}` : title;
      const req = findMatch(whitelist.required_any, haystack);
      if (!req) {
        return {
          pass: false,
          reason: body
            ? 'title: missing required_any (title+description)'
            : 'title: missing required_any keyword',
        };
      }
    }
    return { pass: true };
  } catch (err) {
    if (err.code === 'INVALID_TITLE_FILTER_TERM') {
      return { pass: false, reason: `title: ${err.message}` };
    }
    throw err;
  }
}

export function checkLanguages(offer, profileLanguages) {
  if (!Array.isArray(profileLanguages) || profileLanguages.length === 0) {
    return { pass: true };
  }
  const required = detectRequiredLanguages(offer.title || '');
  if (required.length === 0) return { pass: true };
  const minRank = levelRank(MIN_LANGUAGE_LEVEL);
  const byCode = new Map(profileLanguages.map((l) => [l.code, l.level]));
  for (const code of required) {
    const have = byCode.get(code);
    if (!have || levelRank(have) < minRank) {
      return {
        pass: false,
        reason: `language: requires ${code} (have ${have ?? 'none'})`,
      };
    }
  }
  return { pass: true };
}

export function checkBlacklist(offer, blacklist) {
  const company = (offer.company || '').toLowerCase();
  const hit = (blacklist || []).find((b) => company.includes(b.toLowerCase()));
  if (hit) return { pass: false, reason: `blacklist: ${hit}` };
  return { pass: true };
}

export async function runPrefilter(offer, config) {
  const whitelist = config.whitelist || { positive: [], negative: [] };
  const wantsSoftMatch =
    Array.isArray(whitelist.required_any_in) &&
    whitelist.required_any_in.includes('description') &&
    typeof config.fetchBody === 'function';

  let titleResult = checkTitle(offer, whitelist);
  if (
    !titleResult.pass &&
    titleResult.reason === 'title: missing required_any keyword' &&
    wantsSoftMatch
  ) {
    const body = await config.fetchBody(offer);
    if (body && body.length > 0) {
      titleResult = checkTitle(offer, whitelist, { body });
    } else {
      titleResult = {
        pass: false,
        reason: 'title: missing required_any (title+description)',
      };
    }
  }
  if (!titleResult.pass) return titleResult;

  const blacklistResult = checkBlacklist(offer, config.blacklist);
  if (!blacklistResult.pass) return blacklistResult;

  const langResult = checkLanguages(offer, config.profileLanguages);
  if (!langResult.pass) return langResult;

  const locResult = checkLocation(offer, config.targetLocations);
  if (!locResult.pass) return locResult;

  const dateResult = checkStartDate(offer, config.minStartDate);
  if (!dateResult.pass) return dateResult;

  return { pass: true };
}
