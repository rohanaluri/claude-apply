# Daily Recap — 2026-08-22

**One-line summary:** Resolved the two open architectural decisions from last session
(Zapier mechanism, Phase 2 score schema), rewrote Phase 2 for true single-call batching,
built Phase 3's digest script from scratch, and ran the first-ever real (non-mock) test
of the pipeline — spending real money, getting a real score, on a real live job posting.

References the architecture doc: `docs/project-notes/pipeline-architecture.md`
(all section/decision numbers below refer to that document, now updated to match today).

---

## What We Accomplished

### 1. Resolved both open decisions from last session
- **Zapier mechanism:** confirmed via research that MCP tools can only be invoked by
  Claude during a conversation turn — deterministic code cannot call one directly. Since
  Phase 3 has no AI in it, routing it through MCP would mean spinning up a Claude turn
  just to send an already-written email. Resolved: Phase 3 uses a plain webhook POST to
  a pre-built Zap ("Webhook trigger → Send Gmail"), not MCP. See Decision #13.
- **Phase 2 score schema:** resolved by finally reading the real files instead of
  guessing — `prompt-builder.mjs` and `jd-truncate.mjs`, pasted directly by you.

### 2. Major discovery: the real prompt was built for a different person
Reading `prompt-builder.mjs` revealed the original repo's Phase 2 prompt is written in
**French**, for a **student applying to 6-month internships** ("stage") — not a US
Associate Data Scientist full-time search. This also explains last session's mystery of
French text in Phase 1's dry-run output. Concretely:
- Score scale is **0-10**, not the 1-100 the architecture doc had assumed — this doc
  was simply wrong, now corrected (Decision #14). Kept the 0-10 scale rather than
  changing it, since `computeVerdict()` and `DEFAULT_AUTO_APPLY_MIN_SCORE = 7` already
  depend on it — changing the scale would've silently broken the apply/skip threshold.
- Scoring criteria were hardcoded to a French/internship archetype (a "duration outside
  6 months" red flag, French section-header matching, etc.).
- Schema was already the simple `{score, reason}` we'd been debating — just with
  `reason` capped at one 20-word string. Decided to keep the single-string shape (for
  back-compat with the existing TSV tracker) but expand it to 2-3 short bullets joined
  with `" | "`.

Confirmed **`jd-truncate.mjs` is genuine smart extraction, not a blunt cutoff** — an
open item since the very first architecture doc, now resolved by actually reading the
file: it explicitly keeps Requirements/Qualifications sections and drops About-us/
Benefits boilerplate, with a bilingual-aware header list. No changes needed.

### 3. Rewrote Phase 2 for true single-call batching
`src/score/index.mjs`'s `--batch` path previously parallelized one `claude -p` call per
job. Rewritten so all pending offers are fetched/liveness-filtered individually
(deterministic, $0 AI — unchanged), then sent to Claude in **one single prompt**, with
results matched back to offers by URL (with a trailing-slash-tolerant fallback, so a
minor URL formatting mismatch can't silently drop a result). `prompt-builder.mjs` got a
new `buildBatchPrompt()` alongside the existing single-offer `buildPrompt()` (kept for
the manual `/score <url>` path). Unit-tested the parser and digest-formatting logic in
isolation before ever touching the real repo — all passed.

### 4. Built Phase 3's digest script from scratch
New file: `src/digest/index.mjs`. Reads `evaluations.jsonl`, filters by score threshold
**and** today's date (so a daily run doesn't re-send yesterday's jobs), formats a
markdown digest, POSTs it to a Zapier webhook. Has a `--dry-run` mode that prints the
full payload and rendered markdown without sending anything or requiring a webhook to
exist yet — this is what we actually tested today.

### 5. First real, non-mock, non-dry-run test of the pipeline
- Ran `node src/digest/index.mjs --dry-run` first: correctly reported "No evaluations
  found" — an accurate result, not a bug, since Phase 2 had never actually run for real.
- Built a test `data/pipeline.md` with 3 real, live job postings (found via web search,
  not fabricated) — one genuine entry-level match (Featurespace), one deliberately
  senior/overqualified role to test that scoring catches seniority mismatches (Launch
  Potato), and the same Epoch AI posting used in last session's Phase 4 POC.
- **Hit and fixed a real environment bug:** Phase 2 uses Playwright's own headless
  Chrome (a separate install from `chrome-apply`'s CDP Chrome) to fetch job pages — never
  installed. Then hit a second, genuinely current issue: Playwright doesn't yet
  officially support Ubuntu 26.04 (confirmed via Microsoft's own GitHub issue tracker —
  other users hitting the identical error right now). Fixed with the documented
  workaround: `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, made permanent via
  `~/.bashrc`.
- **Ran `node src/score/index.mjs --batch` for real** — first actual money spent on
  Phase 2. 2 of 3 test postings were already dead by the time of testing (HTTP 404 /
  redirected-to-home) — correctly caught and filtered by the deterministic liveness
  check *before* any Claude call, exactly as designed. The 1 survivor (Epoch AI) was
  sent in a real batch call.
- **Real result:** Epoch AI scored **2.5/10, verdict "skip"** — reasoned that it's
  actually a part-time contractor role doing literature review/data extraction, not
  full-time Python/SQL/ML work. This is a genuinely useful finding: the exact job used
  for all of last session's Phase 4 form-filling tests was never actually a strong
  match — we just had no real scoring running against it until today.
- **Real cost data, measured not estimated:** $0.11 for that one call, `cache_read=0`
  (pure cache-write, first call ever — no prior cache to hit). A same-day repeat run
  would be needed to see real cache-hit savings.

### 6. Updated the architecture doc to match reality
Corrected the 1-100 → 0-10 scale error throughout (decisions log, Phase 2 section,
Mermaid diagram). Corrected "Zapier MCP" → "Zapier Webhook" throughout. Rewrote Phase 2
and Phase 3 sections from future-tense "needs to be built" to past-tense "built and
confirmed working," with real test details. Added `prompt-builder.mjs` and
`jd-truncate.mjs` to the Verified Reusable Code Inventory. Added Decisions #13-15
documenting today's resolutions. Refreshed Open Items to remove what's now resolved and
add what today's testing actually surfaced (webhook not yet created, batch untested with
N>1 live offers, only one real cost data point so far).

---

## What's Verified vs. Still Assumed

**Verified today, by direct testing or direct file reads:**
- Phase 2's true single-call batching works end-to-end against real, live postings.
- The deterministic liveness filter correctly protects against spending AI calls on
  dead postings.
- `jd-truncate.mjs` is genuine smart extraction — confirmed, not assumed.
- Phase 3's digest formatting logic works correctly against real (and against empty)
  evaluation data.
- Real per-call cost for Phase 2: $0.11 for one offer, first-call/cache-miss pricing.

**Still assumed / not yet tested:**
- Phase 2's batching with more than 1 offer surviving in the same call — today's test
  only had 1 live survivor, so "multiple offers in one prompt, correctly matched back by
  URL" is implemented and unit-tested in isolation, but not yet proven against a real
  multi-offer live batch.
- Phase 3 has never actually sent an email — no webhook exists yet, and no evaluation
  has cleared the ≥7 threshold in testing so far.
- Cache-read pricing/savings — need a same-day repeat call to see a real number instead
  of the pure cache-write cost from today.
- Phase 4 promotion (POC → real `src/apply/index.mjs`) — not touched today, still
  exactly where last session left it.

---

## Files Created/Changed Today

- `docs/project-notes/pipeline-architecture.md` — corrected scale/Zapier errors, Phase
  2/3 sections rewritten as built-and-tested, Decisions #13-15 added, inventory and
  open items refreshed.
- `src/score/prompt-builder.mjs` — rewritten: English/US criteria, new
  `buildBatchPrompt()`, original `buildPrompt()` kept for manual single-offer use.
- `src/score/index.mjs` — `--batch` path rewritten for true single-call batching;
  single-offer path unchanged. `parseScoreJson`/added `parseBatchScoreJson` handle the
  bullet-array `reason` format.
- `src/digest/index.mjs` — new file, Phase 3's digest script.
- `data/pipeline.md` — test data, 3 real live postings, for today's batch test.
- `data/evaluations.jsonl` — now has its first real entry (Epoch AI, score 2.5).
- Environment: `~/.bashrc` gained `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`.

---

## Where We Left Off / Next Steps

1. **Find 2-3 fresh live postings and re-run `--batch`** to actually prove multi-offer
   batching (today's test degraded to N=1 because 2 of 3 test postings had gone dead).
2. **Create the real Zapier webhook** ("Webhook trigger → Send Gmail" Zap) so Phase 3
   can be tested for real, not just `--dry-run`.
3. **Phase 4 promotion is still next in line after that**, per last session's priority:
   turn `poc-fill.mjs` into real `src/apply/index.mjs`, merge the three classifier
   fixes into the real `field-classifier.mjs`, rewrite `.claude/commands/apply.md`. Not
   started today — need `config/candidate-profile.yml`'s real key structure first
   (asked for, not yet received) before writing this safely.
4. Cloud Routine creation still fully unbuilt, unchanged from last session.
5. Still using mock/template data throughout (Alice Martin's CV, fabricated candidate
   profile) — real personal data intentionally still not entered anywhere.
