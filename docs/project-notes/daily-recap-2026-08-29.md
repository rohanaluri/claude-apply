# Daily Recap — 2026-08-29

## Headline

Two distinct rounds of accuracy work on Lever, on top of the Epoch AI baseline from
2026-08-27 (7 filled / 13 review that session). **First:** unified how unrecognized
dropdowns/radios get answered — folded into the same batched AI call as free-text
questions, grounded by seven new profile preference fields. **Second, and more
consequential:** found and fixed a genuine root-cause bug in the shared DOM
label-extraction code that had been silently corrupting every radio-button question's
option text, which is what was actually blocking `work_auth`, the info-sharing consent
question, and "how did you hear about us" — not a matching or grounding problem at all.

**Result, same Epoch AI form, before → after both rounds: 8 fields needing review (5
required) → 5 needing review (2 required).** The 2 still required are both free-text
questions Claude correctly declines (one needs a separate Google Doc filled out first,
which no text answer could satisfy).

---

## Round 1 — Unifying free-text and multiple-choice into one AI call

**Problem:** unrecognized dropdowns/radios (relocation willingness, "how did you hear
about us," info-sharing consent) had no classifier rule and no deterministic profile
mapping — their wording and options vary too much per company to hardcode. They were
falling straight to manual review with no attempt at all.

**Fix:** extended the existing free-text AI mechanism to also cover these. Any
unrecognized dropdown/radio with real on-page options now gets routed into the *same*
batched call as free-text questions — Claude sees the real option list and must answer
with the exact text of one of them, or decline. Never invents a choice that isn't
actually on the page; the matched answer is verified against the real list again before
it ever gets filled.

**Grounding added — seven new profile fields**, all validated in the schema:
`work_authorized` (bool), `relocation_flexible` (bool), `preferred_hours_per_week`,
`remote_preference` (priority-ordered list), `willing_to_travel_percent`,
`salary_expectation`, `referral_source`. Values set today after checking real market
data for the salary figure (PayScale's "Associate Data Scientist, 1-4yr experience"
band) rather than guessing: **$100,000–$125,000**.

**A word-boundary bug caught before it shipped:** the new `country` classifier rule
(`/\bcountry\b/`) initially sat too early in the rule list and stole a match from
`work_auth`'s own phrasing — "...in **the country** you have stated above?" contains
the word "country." Caught by testing against real values before handing the file over,
not after a live run. Fixed by moving `country` to the very end of the rule list, so
every more-specific rule gets priority.

**`work_auth` itself remapped** from the old `work_authorization` field (a descriptive
sentence, "EU citizen — no sponsorship needed," which could never match a Yes/No radio)
to the new boolean `work_authorized`, mirroring the existing `sponsorship` pattern.

---

## Round 2 — the real root cause: a DOM label-extraction bug

Round 1 shipped, but a live run still showed all three target questions failing —
`work_auth` with "no confident option match," the other two with "AI returned no
answer" despite correct grounding being sent. Added debug logging (raw AI answers,
outgoing question+options, radio-match failures with the real captured options) rather
than guessing again, and the logs immediately showed something wrong upstream of
anything built in Round 1:

```
real options=["Are you legally authorized to work for us in the country you have
stated above?✱", "...same text again✱"]
```

Both "options" for a Yes/No question were the full question text, duplicated. Same
pattern on "how did you hear about us" — the question text repeated 7 times instead of
7 real distinct choices (LinkedIn, Twitter, etc.).

**Confirmed the real page was normal** before touching any code — fetched the live
Epoch AI apply page directly and confirmed clean, standard "Yes"/"No" and 7-option
lists really do exist there. This ruled out "weird page structure" and pointed
squarely at our own label-reading code.

**Root cause, found in `dom-label.browser.js`'s `extractLabel()`:** for any
radio/checkbox, the function's *first* check climbed up to the enclosing question
container and returned the question's own text — before ever checking whether the
individual radio had its own `label[for]` or wrapping `<label>`. Every option under a
question hit this same early return and got the identical question text back.

**Fix:** reordered the function to try the element's own direct label first,
falling back to the question-level text only when no direct label exists. Verified
against a hand-built DOM matching Rohan's real captured HTML (the sandbox couldn't
install `jsdom` for a real headless-DOM test — reproduced enough of `closest()` /
`querySelector()` by hand instead): old code confirmed to reproduce the exact bug
byte-for-byte, new code confirmed to correctly return "Yes" and "No" separately.

**Two existing tests updated, not just patched around.** `dom-label.test.mjs` had two
tests asserting the *old* buggy behavior as if it were correct — checked the real test
fixture first (`lever-question.html`) and confirmed it uses proper `label[for]`
pairing, meaning the tests were encoding a real bug as expected output. Updated both to
expect the correct per-option label instead.

**Scope check, since this is shared, general-purpose code, not Lever-specific:** the
fix only reorders standard label-lookup logic (`label[for]`, wrapping `<label>`) ahead
of a question-level fallback — not something tied to Lever's markup specifically. Should
generalize to any platform using normal label conventions. Not yet verified live on
Greenhouse/Ashby/Workday, which have their own separate fallback branches further down
in the same file, untouched by today's change either way.

---

## Final result — same Epoch AI form, full before/after

**Before today:** 7 filled, 13 review (6 required).
**After Round 1:** 12 filled, 8 review (5 required) — relocation and hours-per-week
now answered by AI; `work_auth`/share-info/referral-source still broken.
**After Round 2 (today's real fix):** **15 filled, 5 review (2 required).**

All three original targets confirmed working live:
- `work_auth` → filled "Yes" as a proper radio, not AI-answered (deterministic)
- "Share your info with related groups" → AI correctly answered "Yes" via
  `share_info_consent`
- "How did you hear about us" → AI correctly answered "AI or internet search," an exact
  real option match

Remaining 5, all legitimate, not bugs: `cv_upload` (no `cv.pdf` yet), `location`
(known open autocomplete gap), and 3 free-text questions Claude correctly declines
(genuinely no basis to answer — one requires a separate Google Doc first).

---

## Files changed today

- `src/lib/candidate-profile.schema.mjs` — 7 new OPTIONAL_FIELDS + boolean validation
  for `work_authorized`/`relocation_flexible`/`share_info_consent`
- `config/candidate-profile.yml` — real values set for all new preference fields, plus
  `work_authorized: true`, `gender: Male`, `ethnicity: Asian`,
  `veteran_status: not a veteran`, `country: United States`
- `src/apply/field-classifier.mjs` — new `country` rule (repositioned after catching a
  real collision with `work_auth`), `work_auth` remapped to the boolean field
- `src/apply/index.mjs` — `RADIO_INVALID_KEYS` extended with `country`; new `ai-choice`
  action type and routing in `planFields()`; `buildAiPrompt()` extended for
  multiple-choice formatting + preferences grounding; `matchOptionText()` shared
  smart-matching helper (exact → unambiguous prefix → unambiguous substring) reused by
  both `chooseOption()` and `fillSimple()`'s `<select>` handling; EEO select-decline
  reuse; debug logging for radio-match failures and outgoing AI questions/preferences
- `src/apply/dom-label.browser.js` — **the real fix**: `extractLabel()` reordered to
  check the element's own direct label before falling back to question-level text
- `tests/apply/dom-label.test.mjs` — two tests updated to expect the correct per-option
  label instead of the bug's output

---

## Carried forward to next session

- **`location` autocomplete** — still the one open, unfixed gap on every Lever run so
  far. Needs the real widget's HTML (input + suggestion item) to build an accurate
  selector.
- **`config/cv.pdf` doesn't exist** — resume upload has still never run for real.
- **Non-Lever platforms (Greenhouse, Ashby, Workday) unverified against today's
  `dom-label.browser.js` fix.** Should generalize (standard label pattern, not
  Lever-specific) but genuinely untested live.
- **Test a second and third real Lever posting** before calling Lever fully solid —
  Epoch AI is one data point; different companies phrase EEO/consent questions
  differently and may surface new gaps the same way this form did.
- Cover-letter wiring, Phase 3 digest still saying `/apply` instead of `capply`, and the
  rest of the longer-standing Open Items remain untouched.
