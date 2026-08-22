# Daily Recap — 2026-08-22

**One-line summary:** Morning session resolved Phase 2/3's open decisions, rewrote Phase 2
for true single-call batching, built Phase 3's digest script, and ran the first real
(non-mock) pipeline test. Afternoon session promoted Phase 4 from POC to a real
code-driven script (`src/apply/index.mjs`), rewrote `/apply` as a thin wrapper around it,
and — critically — tested both live against a real posting instead of mock data only,
which surfaced and fixed three real bugs unit tests alone hadn't caught.

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

### 7. Phase 4 promoted: POC → real `src/apply/index.mjs`
Unblocked by finally receiving `config/candidate-profile.yml`'s real key structure
(the repo's own Alice Martin template — flat identity/address fields, nested
`education[]`/`experiences[]` arrays, `languages[]` as `{code, level}` objects). Also
received the real `field-classifier.mjs`, `apply.md`, `dom-label.mjs`, `upload-file.mjs`,
`language-detect.mjs`, `apply-log.mjs`, `candidate-profile.schema.mjs`, `cover-letter.mjs`,
`react-select-helper.mjs`, `confirmation-detector.mjs` — all read directly, not assumed.

Built `src/apply/index.mjs`: a plain Playwright/CDP script implementing Section 6's
Steps A-E deterministically, replacing the AI-agent playbook. Key design choices:
- Multi-step "Next" forms auto-advance (your explicit choice), guarded by a
  `classifyButton()` function that checks submit-patterns *before* next-patterns, so any
  ambiguous button ("Submit and Continue") always resolves to submit and is never
  clicked. Capped at 6 steps; aborts if a page doesn't actually change after a click.
- Fields that can't be confidently resolved (no matching dropdown option, unrecognized
  label) fill what they can and flag the rest for review — your explicit choice — rather
  than halting the whole run.
- Cover-letter generation was deliberately left unwired: `cover-letter.mjs`'s
  `generateCoverLetter()` makes its own separate `claude -p` call, which combined with
  the batched free-text call would be **two** AI calls per application — a direct
  violation of Decision #4. Left as manual-review for now; wiring `renderLatex()`
  directly (skipping the redundant AI call) is a follow-up, not done today.

Wrote 50 unit tests (`test-apply.mjs`) covering the pure logic — button classification,
option matching, AI response parsing, field grouping/routing. One real bug caught by the
tests themselves: `chooseOption()` was silently picking the first of two ambiguous
dropdown matches ("Master of Science" vs "Master of Arts" for input "Master") — fixed to
require unambiguous matches, falling back to manual review instead of guessing.

### 8. Live-tested against a real posting — found 3 more real bugs
Ran the actual script (dry-run, then a real fill) against a live PointClickCare
Associate Data Scientist posting on Lever — not mock data. This surfaced bugs the unit
tests couldn't have caught, since they depend on real-world label phrasing:

1. **Company/Role parsed backwards** from the page title-splitting logic — fixed and
   verified against three real title patterns (PointClickCare, Bumble, Epoch AI).
2. **Work-authorization and sponsorship questions misclassified** as `experience_company`
   — both questions are phrased "...for our Company?", and a broader, earlier classifier
   rule matched the word "Company" before the correct rule got a chance. Fixed by
   reordering `work_auth`/`sponsorship` ahead of `experience_company` in
   `field-classifier.mjs` (documented in-file as "Fix 4").
3. **Location field misrouted to the AI free-text pool** — its on-page helper text ("No
   location found...") was getting swept into the label by the DOM label-reader, making
   it look like a long essay question. Fixed detection (routes to a dedicated `location`
   action using `profile.city`/`profile.country`, bypassing the classifier entirely for
   this case). **Fill itself — typing + selecting a real dropdown suggestion — is
   attempted via real keystrokes (not JS value-setting, which Places-style widgets
   reject) but has NOT been confirmed working in either live test.** This remains open;
   need the real widget's HTML to build an accurate selector instead of a generic guess.

Confirmed live and working, unchanged by any bug: the tripwire (correctly detected
"Submit application" and refused to click it), the single-batched-AI-call design (1 real
call answered 3 free-text questions, confirmed via actual usage data in the run output,
not per-field calls), and graceful handling of a missing local CV file (flagged for
review instead of crashing the run).

### 9. Rewrote `.claude/commands/apply.md` as a thin wrapper
Replaced the ~440-line AI-agent playbook with a short command file: checks the profile
exists, runs `node src/apply/index.mjs $ARGUMENTS` as a single Bash call, relays the
output verbatim. Explicitly instructed not to re-summarize or re-interpret what the
script already reported — the whole point of Decision #1 is that Claude shouldn't spend
tokens re-deciding something a deterministic script already determined.

**Tested via the real `/apply` slash command** (not just direct `node` calls) — confirmed
it runs as a single fast Bash call and shows the same output already verified via direct
invocation, with no agent-style page-reading behavior.

### 10. Updated the architecture doc again
Added Decision #16 (today's Phase 4 promotion). Rewrote Section 6 from "what still needs
building" to "confirmed working live, here's what's still open." Added `index.mjs` and
the rewritten `apply.md` to the Section 7 inventory. Open Items: marked the top-level
orchestration item resolved; added six new items reflecting exactly what today's live
testing surfaced (location-autocomplete unverified, unmapped field types, conservative
EEO/Yes-No matching, unwired cover-letter generation, need-to-confirm-committed, and
single-ATS-only testing).

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
- Phase 4's core mechanic (scan → classify → fill → 1 batched AI call → tripwire) works
  live against a real posting, via the real `/apply` slash command, not just direct
  `node` calls or mock data.
- The tripwire is real and held under live testing — correctly detected and refused to
  click "Submit application" both times.
- The single-AI-call design is real — confirmed via actual usage data in the run output
  (not inferred), one call answered all 3 free-text questions on the form.
- `chooseOption()`'s refuse-to-guess behavior is real — caught its own bug in testing
  (ambiguous "Master" match) and correctly flags unmatched EEO/Yes-No fields rather than
  guessing wrong, exactly as designed.

**Still assumed / not yet tested:**
- Phase 2's batching with more than 1 offer surviving in the same call — today's test
  only had 1 live survivor, so "multiple offers in one prompt, correctly matched back by
  URL" is implemented and unit-tested in isolation, but not yet proven against a real
  multi-offer live batch.
- Phase 3 has never actually sent an email — no webhook exists yet, and no evaluation
  has cleared the ≥7 threshold in testing so far.
- Cache-read pricing/savings — need a same-day repeat call to see a real number instead
  of the pure cache-write cost from today.
- **Location-autocomplete fill — attempted, not confirmed.** Detection is fixed, but
  actually selecting a real suggestion from the dropdown has failed both live attempts.
  Needs the real widget's HTML to fix properly, not another guess.
- Everything Lever-specific in today's fixes is unverified on Greenhouse, Ashby, or
  Workday — deliberately deferred, per today's explicit "accuracy later" decision.
- Cover letter generation is not wired into Phase 4 at all yet.

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
- `src/apply/index.mjs` — **new file.** Phase 4's real orchestrator, replacing the POC.
- `src/apply/field-classifier.mjs` — merged the 3 POC fixes (start-date ordering,
  job-title regex, short-text free_text fallback), then a 4th fix from live testing
  (work_auth/sponsorship reordered ahead of experience_company).
- `.claude/commands/apply.md` — rewritten from a ~440-line agent playbook to a thin
  wrapper around `index.mjs`.
- `test-apply.mjs` — new file, 50 unit tests for `index.mjs`'s pure logic.
- `poc/field-classifier.patched.mjs` — deleted, superseded by the merged fix in `src/apply`.
- `docs/project-notes/pipeline-architecture.md` — Decision #16 added, Section 6 rewritten
  from future-tense to confirmed-working, inventory and Open Items updated again.

---

## Where We Left Off / Next Steps

**Immediately pending as of end-of-session:** confirm all of today's Phase 4 files
(`index.mjs`, the reordered `field-classifier.mjs`, the rewritten `apply.md`,
`test-apply.mjs`) are actually committed and pushed to the fork — verify this before
treating anything below as built on solid ground.

1. **Fix the location-autocomplete fill for real**, using the actual widget's HTML
   instead of a generic guess — needed before Phase 4 can reliably handle any ATS's
   location field, not just detect it.
2. **Find 2-3 fresh live postings and re-run `--batch`** to actually prove multi-offer
   Phase 2 batching (still unproven since the 08-22 morning session — 2 of 3 test
   postings had gone dead that day).
3. **Create the real Zapier webhook** ("Webhook trigger → Send Gmail" Zap) so Phase 3
   can be tested for real, not just `--dry-run`.
4. **Create the actual cloud Routine** for Phases 1-3 — still fully unbuilt, nothing has
   ever run unattended.
5. Lower priority, explicitly deferred today: wiring cover-letter generation into Phase
   4, expanding EEO/Yes-No option-matching coverage, testing on a second ATS beyond
   Lever, the Workday step-detection question.
6. Still using mock/template data throughout (Alice Martin's CV, fabricated candidate
   profile) — real personal data intentionally still not entered anywhere.

**The honest gate on "full POC done" is unchanged from this morning's framing:** once
items 2-4 above are done, the whole loop — scan, score, email, apply — runs end-to-end
unattended on mock data. Phase 4's *mechanism* is now proven live; what's left before the
loop is complete is Phases 2's multi-offer proof and Phases 3/Routine's delivery
plumbing, not more Phase 4 work.
