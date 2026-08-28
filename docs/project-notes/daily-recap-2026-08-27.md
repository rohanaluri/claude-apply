# Daily Recap — 2026-08-27

## Headline

**First real, complete Phase 4 run against a full 20-field live application form** —
Epoch AI's Lever posting, start to finish, no hangs, tripwire correctly stopping at
Submit. 7 fields filled, 13 flagged for review with specific reasons, every field
resolving in under a second except the one legitimate AI call.

Getting there required one architectural change (dropping the Claude Code slash command
in favor of a direct terminal call) and five real bug fixes, four of which were only
findable by running against a real form. The debugging path is recorded in detail below —
several of these were misdiagnosed at least once before the real cause was found, and
that's worth remembering.

---

## The architectural change: `/apply` → `capply` (Decision #24)

**What happened:** repeated attempts to run `/apply` inside Claude Code failed without
the script ever executing — a rejected Bash permission prompt, a tool call silently
denied because a new message arrived while the dialog was still open, and one
harness-level "Tool result missing due to internal error." Every failure was in Claude
Code's permission/tool-call layer, never in `src/apply/index.mjs` itself.

**Decision:** Phase 4's daily-use entry point is now a direct terminal command. Added to
`~/.bashrc`:

```bash
capply() { (cd ~/claude-apply && node src/apply/index.mjs "$1"); }
```

Daily use is now `capply "<job-url>"`. The `/apply` slash command still exists and still
works — it just isn't the documented path anymore.

**Important second-order consequence, which drove the rest of the day's work:** without
Claude Code in the loop, there's no session transcript to review after a run. **The
terminal is now the only record of what happened.** That raised the bar on logging from
"nice to have" to "the only source of truth," and directly motivated the live per-field
output added later in the session.

**Discussed but not built:** a fully clickable link from the digest email that opens a
terminal and runs the command. Technically possible via a custom URL protocol handler
registered in Windows that shells into WSL2, but genuinely fragile across
Windows/WSL2/email-client combinations. The one-word alias captures most of the
convenience at a fraction of the risk. Not pursued.

---

## Bug 1 — WSL2 WebGL log spam burying real output

**Symptom:** terminal flooded with hundreds of
`ContextResult::kFatalFailure: WebGL1/WebGL2 blocklisted` lines, making Claude Code's
output completely unreadable. Looked exactly like a hang.

**Cause:** WSL2 has no GPU hardware acceleration by default, so Chrome retries and fails
WebGL rendering in a loop, logging every failure.

**Fix:** added `--disable-gpu --disable-software-rasterizer 2>/dev/null` to the
`chrome-apply` alias.

**Gotcha worth remembering:** the first attempt at this appeared to do nothing. Editing
the alias has no effect on an **already-running** Chrome under the same `--user-data-dir`
— Chrome just opens a new window in the existing process and silently ignores the new
flags. Had to fully kill it first
(`pkill -f "user-data-dir=/home/rohan/.config/google-chrome-claude-apply"`), confirm via
`ps aux | grep remote-debugging-port`, then relaunch. Also worth noting: the first
`~/.bashrc` edit silently didn't save at all — caught only by running
`grep -n "alias chrome-apply" ~/.bashrc` and seeing the old line still there. Verifying
after every edit paid off again.

---

## Bug 2 — Captcha handling (Decision #25), three rounds

This took the longest and was misdiagnosed twice.

**Round 1 — the script stopped dead on captcha.** The original `detectBlockers()` ran
**once**, right after `page.goto()`, and on finding a captcha simply exited the run with
"resolve it and re-run." Meanwhile Lever's hCaptcha was triggering *reactively during
filling*, not at page load — so a captcha that appeared mid-run wasn't detected at all,
and the script just hung on whatever Playwright call was blocked behind the overlay.

**Fix:** rewrote to pause-and-auto-resume — `waitOutCaptcha()` prints a clear message,
polls every 3 seconds, and continues automatically once the challenge clears (10 min
cap). No manual restart.

**Round 2 — false positives on every single page.** The new DOM-based detection flagged a
captcha on every run, even with nothing visible on screen. Two separate causes:
- Lever embeds a **dormant, invisible** hCaptcha widget on every page for passive
  bot-scoring. A presence-only iframe check saw it and called it active. Fixed by
  requiring real rendered visibility (non-zero size, not `display:none`).
- The text-pattern fallback (`/captcha/i`, `/challenge/i`) matched Lever's standard
  "This site is protected by hCaptcha…" footer, and the word "challenge" appearing in
  ordinary job descriptions. Narrowed to active-challenge phrasing only.

**This one was my own regression** — the original text check was too narrow (missed real
challenges), and I overcorrected into something too broad without checking what those
patterns would match on a normal page. Live testing caught it.

**Round 3 — real captcha appeared but wasn't caught.** A genuine drag-the-animal
hCaptcha challenge appeared on screen and the script sailed past it. Initially suspected
a novel widget type the selectors didn't cover. Ran a live diagnostic against the real
page instead of guessing:

```bash
node -e "... connectOverCDP ... querySelectorAll('iframe[src*=\"hcaptcha\"]') ..."
```

Result: the iframe was found, `display: block`, **1666×1777 px** — comfortably clearing
the visibility threshold. Detection was working correctly. **The real cause was
timing**: checks ran at step boundaries, but Lever's form is a single page, so all 20
fields fill in one continuous burst with no step break — a challenge could appear *and*
clear entirely between two checks.

**Fix:** check after **every individual field**, in both the deterministic-fill loop and
the AI-answer loop. Consolidated into a shared `stopIfBlocked()` helper so all
checkpoints behave identically. Confirmed working: captcha appeared mid-fill, paused,
cleared in 6-9s across two runs, resumed correctly and kept filling.

---

## Bug 3 — No per-field timeout (Decision #26)

**Symptom:** the run consistently froze after the LinkedIn field, with zero output — not
even a `[review]` line for the next field.

**Cause:** `page.selectOption()` doesn't fail fast when no option matches the requested
value. It retries internally for its own default timeout (~30s), twice over in the
original code path (label attempt, then value attempt in a `.catch()`).

**Fix:** wrapped every field-fill attempt in `withTimeout(..., FIELD_TIMEOUT_MS)` (8s).
Any field that can't resolve now fails cleanly, gets flagged for review with a reason,
and the run continues — the "say so and move on" behavior requested explicitly. Applied
at all five fill call sites (fill, radio, location, upload, AI-answer).

This immediately turned an invisible hang into four clearly-reported timeouts, which is
what made the next round of diagnosis possible.

---

## Bug 4 — Live terminal logging (the fix that made everything else findable)

**Problem:** every field-fill outcome was recorded silently in memory and only printed at
the very end in the summary. A quiet terminal was indistinguishable from a hung one —
directly responsible for several rounds of confusion earlier in the day, including
prematurely killing a run that was actually working.

**Fix:** print one line the instant each field resolves, plus phase markers for every
step of a run. Sample output now:

```
✓ profile + cv.md loaded
→ connecting to Chrome DevTools at http://localhost:9222...
✓ connected to Chrome
→ opening https://jobs.lever.co/epoch-ai/... ...
✓ page loaded, checking for blockers...
Detected: company="Epoch AI"  role="Data Scientist"  language=en

── step 1: 20 field(s) found, filling now ──
  [fill]    ✓ full_name        → Alice Martin
  [review] ✗ location          — location autocomplete: no value confirmed
  → calling Claude for 4 free-text question(s) (this can take 10-30s)...
  ✓ AI responded (usage={...})
```

Every silence now has a labeled reason — connecting, loading, calling the AI, waiting on
a captcha. Also fixed a logging bug this introduced: AI-pending fields were printing a
premature blank line during the deterministic loop, before any answer existed.

---

## Bug 5 — Two classifier bugs + slow-fail selects (Decision #27)

All three found by reading the *first clean run's* output, which the logging above made
possible.

**Word-boundary bug.** `experience_end`'s regex was `end.*(work|job)` — no word boundary.
"Which country do you **int-end** to primarily **work** from?" contains "end" inside
"intend", and "work" later in the sentence, so it matched by accident and the country
dropdown was told to select a past job's end date. Fixed with `\bend\b` in
`field-classifier.mjs`, plus `\bstart\b` preventatively for the symmetric rule.

**Long-paragraph misclassification.** A Yes/No consent question — *"Are you happy for us
to share your information… we may share your full name, **email**, resume…"* — was
classified as the **email field**, because radio-groups feed `classifyField()` the entire
300-char question paragraph, not a short label, and the generic `/email/` regex matched a
word buried deep in the explanation.

Fixed structurally rather than per-instance: a new `RADIO_INVALID_KEYS` guard in
`planFields()`. Personal-data classes (`email`, `phone`, `experience_*`, name fields,
uploads, etc.) can never legitimately describe a Yes/No question — a radio-group matching
one of them now falls back to `unknown` instead of silently mis-mapping. This guards the
whole category of future long-paragraph false positives.

**Slow-fail selects.** Initially suspected the country dropdown was a custom React widget
needing reverse-engineering. Grabbed the real HTML — **it's a plain native `<select>`**
with ~195 `<option>` tags. The "custom widget" theory was wrong. The real problem was
purely a value mismatch (see Bug 3), so `fillSimple()` now checks that a matching option
actually exists *before* calling `selectOption()`, failing in milliseconds with a
specific `no option matches "X"` reason.

This also explained the three EEO dropdown timeouts: the code's default is
`"Prefer not to say"`, but Epoch's real option text is `"Decline to self-identify"` —
never a match, so Playwright hung on all three.

---

## Final result — first clean full-form run

Epoch AI, Data Scientist, 20 fields, via `capply`. No hangs anywhere.

**7 filled:** `full_name`, `email`, `phone`, `experience_company`, `linkedin`,
`experience_start`, and one genuine AI-written free-text answer.

**13 flagged for review (6 required)**, each with a specific reason:
- `cv_upload` — `config/cv.pdf` doesn't exist (only `cv.md`)
- `location` — known autocomplete gap, still unfixed
- `work_auth` — "no confident option match" (**real open bug**, see below)
- 3 fields with no classifier rule at all → correctly `unknown`, not guessed
- 3 EEO selects — `no option matches "Prefer not to say"`
- 3 free-text questions Claude correctly declined per its grounding rules (one of them
  requires filling out a separate Google Doc, which no text answer could satisfy)

Captcha appeared mid-run, paused, cleared in 6s, resumed cleanly. Tripwire correctly
detected "Submit application" and stopped without clicking.

**Test suite:** 695/700 throughout, same 5 known pre-existing unrelated failures (3
cover-letter date-formatting, 1 stale French-prompt test, 1 `--re-score` mock shape). No
regressions from any of today's changes.

---

## Files changed today

- `src/apply/index.mjs` — substantially rewritten: `waitOutCaptcha()` pause/resume,
  `stopIfBlocked()` shared checkpoint helper, `withTimeout()` + `FIELD_TIMEOUT_MS`,
  `logFieldResult()` live logging, `RADIO_INVALID_KEYS` guard, fast-fail `<select>`
  handling, phase markers throughout
- `src/apply/field-classifier.mjs` — `\bend\b` / `\bstart\b` word boundaries
- `~/.bashrc` — `chrome-apply` alias GPU flags; new `capply` function
- `docs/project-notes/pipeline-architecture.md` — Decisions #24-27 added, Sections 1/2/6/7
  rewritten, architecture diagram updated (manual terminal handoff + captcha pause loop),
  Open Items updated

---

## Carried forward to next session

**Real, newly-identified bugs from the live run:**
- **`work_auth` "no confident option match"** — the profile's `work_authorization` is a
  descriptive sentence ("EU citizen — no sponsorship needed") but `chooseOption()` only
  recognizes literal yes/no/true/false for a Yes/No radio. Needs a design decision:
  dedicated boolean profile field, or derive yes/no from the text.
- **No classifier rule for "which country do you work from"** — the profile already has a
  `country` field that would answer it, and we now have the real HTML. Cheap win.
- **EEO select defaults don't match real option text** — `"Prefer not to say"` vs Lever's
  `"Decline to self-identify"`. Likely varies per company, so a hardcoded default may
  never reliably match; worth reusing `chooseOption()`'s existing decline-detection logic
  for select-type fields, not just radio-groups.

**Still open from before:**
- Location-autocomplete fill — still failing on every live test; needs the real widget's
  HTML (input + suggestion item selectors).
- `config/cv.pdf` doesn't exist, so resume upload has still never run for real.
- Phase 3's digest email still says `/apply <url>` — stale after Decision #24.
- Cover-letter wiring, non-Lever ATS testing, real profile/CV data entry.

**Recommended next step:** the three newly-found bugs above are all small, well-understood
and independently fixable — good candidates for a focused next session that would push
the "filled" count meaningfully above 7 on the same test form.
