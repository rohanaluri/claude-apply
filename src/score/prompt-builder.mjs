import { truncateJd } from './jd-truncate.mjs';

// --- Single-offer prompt (kept for manual ad-hoc use: `/score <url>`) ---
// Rewritten from the original French/internship-focused version to match the
// actual candidate: a US-based Associate/entry-level Data Scientist search,
// not a French engineering-student internship search. Score scale (0-10) and
// response shape ({score, reason}) intentionally UNCHANGED from the original —
// every downstream consumer (computeVerdict, DEFAULT_AUTO_APPLY_MIN_SCORE=7,
// the TSV tracker writer) already assumes this scale. Only the prompt content
// changed, not the contract.
const SYSTEM = `You score job postings for a candidate applying to Associate/entry-level
Data Scientist roles in the US.
Respond with ONLY valid JSON, no markdown, no text outside the JSON:
{"score": X.X, "reason": ["<bullet, 15 words max>", "<bullet, 15 words max>"]}
Scale 0-10: 10=perfect fit, 8=very good, 7=good, 5=average, <5=weak. Do NOT return a
verdict — it's computed downstream from a user-configured threshold.`;

const CRITERIA = `# Scoring criteria
- Technical match (40%): Python/SQL/Scikit-Learn/Pandas and related DS tooling vs CV
- Role level fit (30%): genuinely Associate/entry-level/Junior — not a Senior/Staff/Lead
  role mislabeled or requiring 5+ years
- Domain fit (20%): Data Science/ML/Analytics as the core function, not a tangential title
- Red flags (10%): years-of-experience requirement clearly beyond entry-level, a required
  degree/clearance the candidate lacks, or an explicitly excluded tech stack`;

export function buildPrompt({ cvMarkdown, offer, jdMaxTokens = 1500 }) {
  const jd = truncateJd(offer.body || '', jdMaxTokens);
  const user = `# Candidate profile
${cvMarkdown}

${CRITERIA}

# Offer
Company: ${offer.company || 'unknown'}
Title: ${offer.title || 'unknown'}
Location: ${offer.location || 'unknown'}
JD:
${jd}`;
  return { system: SYSTEM, user };
}

// --- Batched prompt: ALL pending offers in ONE call ---
// This is the real Phase 2 fix. The old `--batch` flag looped buildPrompt()
// per job and made N separate `claude -p` calls. This builds a SINGLE prompt
// containing the CV once + every pending offer, so scoring the whole day's
// batch costs one call, not N.
const BATCH_SYSTEM = `You score job postings for a candidate applying to Associate/entry-level
Data Scientist roles in the US.
You will receive the candidate's CV/profile once, followed by multiple job postings,
each tagged with its URL. Score EVERY posting independently — do not let one offer's
content influence another's score.
Respond with ONLY a valid JSON array, no markdown, no text outside the JSON:
[{"url": "<exact url from the offer>", "score": X.X, "reason": ["<bullet, 15 words max>", "<bullet, 15 words max>"]}, ...]
Return exactly one array entry per offer given, using the EXACT url provided for that
offer (do not paraphrase or shorten the url). Include 2-3 short reason bullets per offer.
Scale 0-10: 10=perfect fit, 8=very good, 7=good, 5=average, <5=weak. Do NOT return a
verdict — it's computed downstream from a user-configured threshold.`;

export function buildBatchPrompt({ cvMarkdown, offers, jdMaxTokens = 1500 }) {
  const offerBlocks = offers
    .map((offer, i) => {
      const jd = truncateJd(offer.body || '', jdMaxTokens);
      return `## Offer ${i + 1}
URL: ${offer.url}
Company: ${offer.company || 'unknown'}
Title: ${offer.title || 'unknown'}
Location: ${offer.location || 'unknown'}
JD:
${jd}`;
    })
    .join('\n\n---\n\n');

  const user = `# Candidate profile
${cvMarkdown}

${CRITERIA}

# Offers to score (${offers.length} total)
${offerBlocks}`;

  return { system: BATCH_SYSTEM, user };
}
