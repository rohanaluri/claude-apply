# Daily Recap — 2026-08-20

**One-line summary:** Got the local WSL2/Ubuntu environment fully working, discovered and
corrected a major wrong assumption about Phase 4 (it's AI-agent-driven, not free
deterministic code), redesigned the architecture around it, and built + iterated a working
proof-of-concept that auto-fills a real job application form.

References the architecture doc: `docs/project-notes/job-pipeline-architecture.md`
(all section numbers below refer to that document).

---

## What We Accomplished

### 1. Environment setup (Sections 1 of the architecture doc)

- Forked `LeoLaborie/claude-apply` to `rohanaluri/claude-apply` (private).
- Discovered the repo's `scripts/setup.sh` has no Windows support at all — Linux/macOS
  only. Decided to run the whole local stack inside **WSL2/Ubuntu** rather than patch
  around Windows gaps piecemeal.
- Installed WSL2: enabled the Windows feature, enabled virtualization in BIOS/UEFI
  (ASUS TUF B550-Plus — SVM Mode was off by default), installed Ubuntu.
- Inside Ubuntu: installed Node 20 via `nvm` (matching `.nvmrc`), installed Google Chrome
  via `apt`, set up `git`/`gh` auth, cloned the fork to `~/claude-apply`.
- Ran `bash scripts/setup.sh --no-rc` successfully (this is the step that silently failed
  on Windows) — populated `config/*.yml` and `cv.md` from templates.
- Manually added the `chrome-apply` alias to `~/.bashrc` (used `--no-rc` so we could see
  and control the exact alias text rather than let the script auto-write it).
- Confirmed `chrome-apply` launches a real, working Chrome window (after one WSLg display
  glitch, fixed with `wsl --shutdown` + relaunch).
- Installed the `claude-in-chrome` extension in that dedicated Chrome profile.
- Installed Claude Code natively inside Ubuntu (separate from any Windows-side install);
  hit and fixed a PATH issue (`~/.local/bin` wasn't on PATH after install).

### 2. Ran Phase 1 (discovery scan) — confirmed working

- `node src/scan/index.mjs --dry-run` executed successfully against placeholder companies
  in `portals.yml` — hit real Lever API endpoints, correctly found zero results (bad
  placeholder slugs, not a bug), correctly wrote no files.

### 3. Major correction: Phase 4 was never a free deterministic script

- Asked Claude Code (running inside the Ubuntu repo) to patch the auto-submit tripwire.
  It reported the patch was **already done** — traced this to a separate earlier session
  on the Windows-side Claude Code install, before today's WSL work. Verified this was real
  (not hallucinated) via `git log`, `git show 976437b`, and viewing the diff directly on
  GitHub. The tripwire patch (commit `976437b`) is confirmed correct: unconditional halt,
  amber review banner, waits for `continue`, no auto-submit path left, old logic kept only
  as a dead HTML comment.
- In the process, discovered the repo's real `/apply` entry point
  (`.claude/commands/apply.md`) is an **AI agent playbook** — Claude Code itself reads the
  page and drives the fill via `claude-in-chrome`, not a standalone Playwright script. This
  contradicted the entire v2.0 architecture's "$0 token" assumption for Phase 4.
- Searched for alternatives (`workday-autofill`, `job-application-agent`) to understand
  what a genuinely code-driven version looks like.

### 4. Verified actual Claude/Anthropic billing mechanics (don't trust assumptions)

- Confirmed via Anthropic's own Help Center that a planned June 15, 2026 billing split
  (moving `claude -p`/Agent SDK usage to a separate credit pool) was **announced, then
  paused** — currently, `claude -p` still draws from the same shared Pro subscription pool
  as interactive use.
- Read the actual `src/score/index.mjs` file directly: confirmed it calls `claude -p` via
  `child_process.spawn`, not a separate `ANTHROPIC_API_KEY`-based API call — so Phase 2 also
  draws from the shared Pro pool, contrary to the README's "$0.03/offer" implying separate
  billing.
- Did the real math: at realistic volume (~10 scored + ~3 applied/day, all single-turn
  calls), total usage is comfortably within Pro's budget — **no separate API key needed**
  right now.

### 5. Redesigned Phase 4 around real, verified code

- Pulled and read every file in `src/apply/` directly (user pasted actual file contents,
  not paraphrased) to avoid repeating the assumption mistake:
  `field-classifier.mjs`, `dom-label.mjs`/`dom-label.browser.js`, `react-select-helper.mjs`,
  `upload-file.mjs`, `step-detect.mjs`, `confirmation-detector.mjs`, `accounts.mjs`,
  `language-detect.mjs`, `cover-letter.mjs`/`letter-generator.mjs`, `apply-log.mjs`.
- Key discovery: `field-classifier.mjs`'s `classifyField()` + `mapProfileValue()` already
  handle ~30 field types with **zero AI** — pure regex matching against profile data. Only
  genuine free-text/essay questions need an actual AI call.
- Rewrote the architecture doc cleanly as a fresh v1 (no "replaces v2" framing per your
  request) reflecting: WSL2/Ubuntu as the real local architecture (not a workaround),
  Phase 4 as scan → classify/fill (0 AI) → free-text (≤1 AI call) → tripwire, and a
  "Verified Reusable Code Inventory" table so nothing in the doc is unverified again.
- Discussed and added three efficiency decisions into the doc: extract clean job text
  before Phase 2 (not raw HTML), place prompt caching in Phase 4 (not Phase 2, since
  Phase 2 is already one batched call), and lock Phases 1-3 to a strict single daily cron.

### 6. Built and iterated a working POC

Built (`poc/` folder, standalone, references the repo's real modules):

- `mock-profile.yml` / `mock-cv.md` — fake identity, matching `field-classifier.mjs`'s
  expected keys.
- `test-form.html` — a local mock application form.
- `poc-fill.mjs` — scans fields (via the repo's real `dom-label.browser.js`), classifies
  and fills known fields from the mock profile ($0 AI), makes one Claude call for anything
  it can't answer deterministically, fills that, and stops. No submit logic exists in it.

**Test 1 — local mock form:** 100% success. All 7 standard fields filled correctly from
the profile; the one essay question got a genuinely grounded, non-generic Claude answer
using only mock-CV facts. Zero submit risk since no submit code exists.

**Test 2 — real live posting (Epoch AI, Lever):** found real, useful bugs, not failures:

- My `.fill()`-only approach broke on `<select>` and `<input type="radio">` (need
  `selectOption`/`check`, not `fill`).
- Essay answers came back blank with no error — a silent key-mismatch bug in my own script.
- Two genuine classifier bugs, unrelated to my script: "earliest start date" was
  misclassified as a past job's start date (rule-ordering issue), and "how did you hear
  about us **or this position**" was misclassified as a job-title question (regex matched
  the bare word "position").

**Fixes applied and verified:**

- Classifier: reordered `availability` ahead of `experience_start`; tightened
  `experience_title`'s regex so it requires real job-title phrasing; added a fallback so
  short open-ended text inputs (not just `<textarea>`) route to the AI instead of being
  silently skipped. Unit-tested all 12 relevant real-world labels from the Epoch form
  against the patched classifier — 12/12 pass.
- Script: added option-harvesting for dropdowns and radio groups (reads the real
  `<option>`/radio-label text off the page first, so Claude only ever picks something
  that actually exists — this also fixed a 30-second timeout bug from blind guessing).
  Folded free-text + dropdown/radio matching into **one** Claude call instead of separate
  calls. Added a "REVIEW THESE" summary at the end of every run.
- Expanded the mock profile with location, EEO answers, desired hours, and an explicit
  work-authorization yes/no, since many of the earlier blanks were caused by missing mock
  data, not code bugs.
- Radio-click robustness: added a 3-step fallback (check the input → click its label →
  force-check) after discovering Lever hides the real `<input>` behind a styled proxy.

**Test 3 — re-run on Epoch AI after fixes:** 14 of 19 fields filled correctly in one AI
call, including the country dropdown, work-authorization radio, all three EEO dropdowns,
and the relocation dropdown. Remaining 4 items all landed correctly on the "REVIEW THESE"
list rather than silently failing: resume upload (not wired in yet), the two essay
questions the form explicitly says not to use AI for (correctly declined), and one
"share your info" radio + the location autocomplete field — both of which are
**React-controlled custom widgets**, not plain HTML, which don't respond to Playwright's
standard fill/check/click and need React-aware event handling (the repo's
`react-select-helper.mjs` handles this pattern but isn't wired into the POC yet).

---

## What's Verified vs. Still Assumed

**Verified today, by direct testing or direct file reads:**

- WSL2/Ubuntu environment works end-to-end for this repo.
- Phase 1 scan logic works against real APIs.
- The tripwire patch is real and correct.
- `field-classifier.mjs`, `dom-label.mjs`, `upload-file.mjs`, etc. are real, working code.
- The core POC loop (scan → classify → fill → 1 AI call → stop) works on both a simple
  local form and a messy real-world Lever form, with a known, bounded set of exceptions.
- Standard HTML `<select>` and most `<input type="radio">` groups can be filled reliably
  once options are harvested first.

**Still assumed / not yet tested:**

- Whether the same approach holds up on Greenhouse or Ashby forms (only tested on Lever).
- React-controlled custom widgets (location autocomplete, at least one Lever radio) are
  not yet handled — real gap, not a hidden one.
- Resume upload isn't wired into the POC yet (repo's `upload-file.mjs` should work, but
  hasn't been tested from this script).
- Phase 2's batching (one call for the whole scan) hasn't been built yet — POC only proves
  the Phase 4 pattern.
- The cloud Routine hasn't been set up or tested at all.

---

## Files Created/Changed Today

- `docs/project-notes/job-pipeline-architecture.md` — rewritten clean, then updated with
  the three efficiency decisions (extraction, caching placement, cron trigger).
- `poc/mock-profile.yml` — created, then expanded (location/EEO/hours/work-auth).
- `poc/mock-cv.md` — created.
- `poc/test-form.html` — created.
- `poc/poc-fill.mjs` — created, then rewritten twice (type-aware filling; then
  option-harvesting + batched single Claude call + robust radio clicking).
- `poc/field-classifier.patched.mjs` — created as a local patched copy of the repo's real
  classifier (repo's original untouched, pending these fixes being proven out further).
- `poc/README-POC.md` — created.
- Commit `976437b` (tripwire patch) — pre-existing from an earlier session, verified today.
- Commit `c551e97` (architecture doc added to repo) — from earlier today.

---

## Where We Left Off / Next Steps

**Priority for next session, set explicitly at the end of today:** focus on coding/repo
tasks before further exploratory testing. In order:

1. **Rewrite Phase 2 scoring for true batching.** `src/score/index.mjs`'s `--batch` flag
   currently parallelizes separate `claude -p` calls (one per job) — it does NOT combine
   them into a single prompt. Needs a real rewrite: one prompt containing the CV + every
   pending job posting, one response with all scores. This was reconfirmed today as a
   hard requirement (token savings), not optional.
2. **Wire up a real `/apply` command.** Two disconnected things currently exist:
   `poc-fill.mjs` (our new, cheap, code-driven approach — proven working) and
   `.claude/commands/apply.md` (the actual command Claude Code recognizes as `/apply` —
   still the OLD agent-driven playbook we moved away from). Nothing connects them yet.
   `apply.md` needs to be rewritten to invoke our script's logic instead of driving the
   browser itself turn-by-turn.
3. **Create the actual cloud Routine.** Confirmed today: no Routine exists for this
   project yet — the "routine already set up" was the unrelated morning news briefing.
   Phases 1-3 have never run as an automated Routine, only Phase 1 has been dry-run
   manually and Phase 4 tested manually.

**After the above (lower priority, previously noted):**

- Diagnose the one remaining failing radio button (`poc_field_14` on the Epoch AI form)
  by comparing its real HTML against the working radio's HTML — don't guess "React" again,
  actually look.
- Wire resume upload into the script (`upload-file.mjs` exists in the repo, untested from
  our script).
- Test the approach on a second ATS (Greenhouse or Ashby) — only Lever has been tested.

**Full realistic user walkthrough discussed today** (see chat): confirmed steps 4-8 of a
9-step daily-use flow are proven (open Ubuntu → run apply → fields fill → review →
submit). Steps 1-3 (cron fires → Phase 2 scores → digest email arrives) are still 100%
unbuilt — this is the gap items 1 and 3 above are meant to close.

- The architecture doc itself was **not** updated with today's POC findings (per your
  instruction — you'll say explicitly when it should be).
