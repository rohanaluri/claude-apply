// New file — 2026-09-19.
//
// EEO fields (gender/ethnicity/veteran/disability) are the one place the
// pipeline answers a legally sensitive question, so it must never guess.
//
// The bug this fixes: mapProfileValue() reads the candidate's own free-form
// sentence ("not a veteran", "No disabilities"), while real forms word their
// options completely differently per company ("Decline to self-identify" vs
// "Prefer not to say"; "I am not a protected veteran" vs "Not a veteran" vs
// plain "No"). The existing exact/prefix/substring matcher (matchOptionText
// in index.mjs) correctly refuses to guess across that mismatch, but that
// meant a real, correctly-set profile value like "not a veteran" or "No
// disabilities" ALWAYS fell to manual review, even though a human would see
// the right answer on the page instantly (confirmed live on the Anthropic
// Greenhouse posting, 2026-09-19: eeo_veteran and eeo_disability both logged
// "fill verification failed").
//
// This module closes that gap WITHOUT ever guessing across intents: it
// classifies the profile value's INTENT (decline / negative / affirmative /
// an explicit category like "Asian"), then only returns a page option that
// is unambiguously the same intent. Anything it can't classify, or where
// more than one option plausibly matches, returns null — exactly like
// matchOptionText's own contract — so the caller sends the field to review
// instead of clicking a guess.
//
// Scope note: the negative/decline intents are implemented for eeo_veteran
// and eeo_disability specifically, because those are the two real failures
// seen so far. eeo_gender/eeo_ethnicity fall through to 'verbatim' (the
// existing exact/prefix/substring matcher), unchanged, since profile values
// like "Male"/"Asian" already match real option text fine on their own.

const DECLINE_RE =
  /prefer not to (say|answer|disclose)|decline to (self[- ]?identify|answer|say)|do not wish|don't wish|i do not want to answer|i don't want to answer/i;

// Fragments distinctive enough to identify a real page option's intent
// without cross-triggering on the OTHER intent for the same classKey (e.g.
// disability's negative regex must not also match the affirmative option,
// and vice versa) — checked in decline → negative → affirmative order below,
// with each later check excluding anything the earlier checks already
// claimed, so overlapping wording (both intents can contain the word
// "disability") never causes a false double-match.
const NEGATIVE_RE = {
  eeo_veteran: /\bnot a (protected )?veteran\b|^\s*no\b/i,
  eeo_disability: /\b(do not|don't|does not|doesn't) have( a| had a)? disability\b|^\s*no\b/i,
};
const AFFIRMATIVE_RE = {
  eeo_veteran: /\bi am a (protected )?veteran\b|^\s*yes\b/i,
  eeo_disability: /\bi have( a| had a)? disability\b|^\s*yes\b/i,
};

export const isDeclineOption = (o) => DECLINE_RE.test(String(o ?? ''));

function isNegativeOption(classKey, o) {
  const re = NEGATIVE_RE[classKey];
  return re ? re.test(String(o ?? '')) && !isDeclineOption(o) : false;
}

function isAffirmativeOption(classKey, o) {
  const re = AFFIRMATIVE_RE[classKey];
  return re
    ? re.test(String(o ?? '')) && !isDeclineOption(o) && !isNegativeOption(classKey, o)
    : false;
}

/** Classify a candidate's own profile value into an intent. Pure, no page access. */
export function classifyIntent(rawValue) {
  const v = String(rawValue ?? '')
    .trim()
    .toLowerCase();
  if (!v || DECLINE_RE.test(v)) return 'decline';
  if (/^no\b|^not a\b|^none\b|no disabilit|not a veteran/.test(v)) return 'negative';
  if (/^yes\b|^i am a\b|^i have\b/.test(v)) return 'affirmative';
  return 'verbatim'; // e.g. an explicit category value like "Male", "Asian"
}

/**
 * Resolve an EEO profile value against REAL page options for `classKey`.
 * Returns the option string to select, or null if nothing can be safely
 * chosen (the caller must then flag the field for review — never guess).
 *
 * `matchOptionText` is passed in (rather than imported) so this stays a
 * standalone, dependency-free module callers can unit test in isolation —
 * index.mjs passes its own matchOptionText for the 'verbatim' fallback.
 */
export function matchEeoOption(classKey, rawValue, options, matchOptionText) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const intent = classifyIntent(rawValue);

  if (intent === 'decline') {
    const hits = options.filter(isDeclineOption);
    return hits.length === 1 ? hits[0] : null;
  }
  if (intent === 'negative') {
    const hits = options.filter((o) => isNegativeOption(classKey, o));
    return hits.length === 1 ? hits[0] : null;
  }
  if (intent === 'affirmative') {
    const hits = options.filter((o) => isAffirmativeOption(classKey, o));
    return hits.length === 1 ? hits[0] : null;
  }
  // verbatim — same exact/prefix/substring matcher used everywhere else.
  return matchOptionText(options, rawValue);
}

/**
 * Ordered lists of candidate intent-fragment hints for react-select fields
 * where we have NO real option text to check ahead of time (no native
 * <select> mirror exposing selectOptions). Each candidate is tried in turn
 * as the react-select snippet's `optionText`, which only ever accepts an
 * UNAMBIGUOUS match (exact/prefix, then substring only if it matches
 * exactly one rendered option) — so a candidate that happens to match two
 * real options on some company's form safely resolves to nothing rather
 * than guessing which one, and the caller moves on to the next candidate
 * (or, if all fail, to review).
 *
 * More than one candidate per intent because a single fixed phrase isn't a
 * literal substring of every company's wording — e.g. "not a veteran" is
 * NOT contained in "I am not a PROTECTED veteran" (a real, common wording),
 * so a plain veteran-negative hint needs both forms tried.
 *
 * Deliberately covers only decline and negative — the two intents actually
 * seen in a real run so far — not affirmative, where "veteran"/"disability"
 * alone are too likely to appear in BOTH the affirmative and negative
 * option text to ever resolve safely without seeing the real DOM.
 */
export const EEO_INTENT_HINTS = {
  eeo_veteran: {
    decline: ['prefer not', "don't wish", 'decline to'],
    negative: ['not a protected veteran', 'not a veteran'],
  },
  eeo_disability: {
    decline: ['prefer not', "don't wish", 'decline to'],
    negative: ['do not have a disability', "don't have a disability", 'not have a disability'],
  },
};
