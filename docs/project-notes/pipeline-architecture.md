# Job Application Pipeline — Architecture

Base repo: https://github.com/LeoLaborie/claude-apply (forked to `rohanaluri/claude-apply`, private)
Orchestration: Claude Code Routines (cloud, Anthropic-managed)
Local execution environment: WSL2 (Ubuntu) on a Windows host
Notification: Zapier MCP → Gmail

---

## 0. Key Decisions Log

1. **No AI agent ever reads a live page turn-by-turn.** Every AI call in this pipeline is
   one prompt in, one structured answer out — never an agent deciding what to click next.
   Reading pages and filling forms is done by plain code (Playwright), confirmed to already
   exist in the base repo (see Section 7).
2. **Most form fields need zero AI at all.** The repo's `field-classifier.mjs` matches a
   field's label/name against known patterns (email, phone, name, education, work
   authorization, EEO questions, etc.) and pulls the answer straight from your profile
   data. Only genuine open-ended essay questions need an actual AI-written answer.
3. **Phase 2 (scoring) is batched into one call per scan run**, not one call per job. All
   pending postings + your CV go into a single prompt; Claude returns an array of scores.
   Essay drafting for the digest email stays in this same call, gated at score ≥ 85.
4. **Phase 4 (apply) makes at most one AI call per application** — only if that specific
   form has a genuine free-text/essay question the classifier can't answer from profile
   data. Many applications may need zero AI calls entirely.
5. **This runs on the existing Pro subscription — no separate API key needed** at current
   volume (~10 jobs scored + ~3 applications/day ≈ 4 short calls/day, well under Pro's
   budget). Revisit only if volume scales up substantially.
6. **Safety tripwire: the script halts at the final review screen and never clicks
   Submit.** You always click Submit yourself, every time, no exceptions.
7. **Local execution runs inside WSL2/Ubuntu**, not Windows directly — the base repo's
   setup script and Chrome-detection logic only support Linux/macOS.
8. **Phase 2 sends only extracted core text (title/requirements/description), not raw
   page HTML.** Job postings can contain thousands of words of navigation, cookie
   banners, and boilerplate around the actual description — sending that raw inflates
   every prompt for no benefit. The scan/score pipeline must extract clean text before
   it ever reaches a prompt. `src/score/index.mjs` already caps job text at
   `jdMaxTokens: 1500` — needs verifying whether that's smart extraction or a blunt
   cutoff (see Open Items).
9. **Prompt caching is used where it actually helps: Phase 4, not Phase 2.** Phase 2 is
   already one batched call, so `cv.md` is only sent once regardless — caching has
   little to add there. Phase 4 makes a separate call per application, each repeating
   the same `cv.md` prefix, so structuring that prompt with `cv.md` and core instructions
   as a fixed, cacheable prefix (unchanged across applications) is where caching earns
   its keep — cutting repeated input-token cost across a day's worth of applications.
10. **Phases 1-3 run on a strict single daily cron trigger** (e.g. 7:00 AM once/day) —
    not on-demand, not multiple times while testing. This protects the ~5 routine-run/day
    cap on Pro from being burned accidentally during development.

---

## 1. Local Execution Environment

**Host:** Windows 11 PC with WSL2 (Ubuntu). Real Linux kernel, not emulation. GUI apps
(Chrome) forward to the Windows desktop natively via WSLg.

**Repo location:** `~/claude-apply` inside Ubuntu's own filesystem (not `/mnt/c/...`) —
avoids performance/permission issues when crossing the Windows/Linux boundary.

**Runtimes:** Node 20 via `nvm` (matching `.nvmrc`), Google Chrome installed inside Ubuntu
via `apt` — fully separate from Windows Chrome.

**Chrome CDP profile:** dedicated, isolated, launched via a `chrome-apply` alias in
`~/.bashrc`:
```bash
alias chrome-apply='"/usr/bin/google-chrome" --user-data-dir="/home/rohan/.config/google-chrome-claude-apply" --remote-debugging-port=9222 &'
```
Signed into the job-search Gmail account. `claude-in-chrome` extension installed in this
profile per the repo's setup instructions (its exact role alongside the redesigned,
code-driven Phase 4 below is still unconfirmed — see Open Items).

**GitHub auth:** `gh auth login`, browser OAuth, against the private fork.

**Claude Code:** installed natively inside Ubuntu, separate from any Windows-side install.

**What doesn't run here:** Phases 1-3 run in the cloud Routine, cloning the repo fresh
each run. This environment is specifically for Phase 4.

---

## 2. Architecture Diagram

```
[Cloud Routine fires — scan + score]
        │
        ▼
PHASE 1 — Discovery & Prefilter (cloud, deterministic, $0 AI)
  node src/scan/index.mjs
  reads config/portals.yml → hits Greenhouse/Lever/Ashby/Workable public APIs
  title filter: excludes Senior/Lead/Manager/Director/Staff/Principal/III/IV
                includes Associate/Junior/I/II/Entry-level/New Grad/Data Scientist
        │
        ▼  data/pipeline.md
        │
PHASE 2 — Batched Score + Essay Draft (cloud, 1 AI call for the whole batch)
  input: cv.md (once) + ALL pending job postings in one prompt
  output: array of { url, score, why_fit[], essay_answer | null }
  essay_answer populated ONLY for entries scoring >= 85
  → data/evaluations.jsonl
        │
        ▼  filter: score >= 85
        │
PHASE 3 — Digest Email (cloud, Zapier MCP, $0 AI)
  markdown email per qualifying job: company, title, score, why-fit bullets,
  essay snippet, /apply <url> command block
        │
        ▼
[You review digest, pick a job, paste /apply <url> — WSL2/Ubuntu]
        │
        ▼
PHASE 4 — Local Apply (WSL2/Ubuntu, 0-1 AI calls per application)
  Step A ($0 AI): Playwright/CDP opens the page via chrome-apply, scans every
    field, extracts label via dom-label.browser.js, classifies via
    field-classifier.mjs
  Step B ($0 AI): standard fields (name, email, phone, education, work auth,
    EEO, etc.) filled directly from config/candidate-profile.yml — no AI call
  Step C (1 AI call, ONLY if a genuine free-text/essay field exists on this
    form): send that question + cv.md to Claude, get back an 80-150 word
    grounded answer
  Step D ($0 AI): resume PDF attached via upload-file.mjs (Playwright CDP,
    bypasses page sandbox restrictions)
  Step E (TRIPWIRE): halts unconditionally at the final review screen —
    never clicks Submit
  → you review, solve CAPTCHA if present, click Submit yourself
```

---

## 3. Phase 1 — Discovery & Prefilter (Cloud, $0 AI)

**Command:** `node src/scan/index.mjs`

**Confirmed working** via `--dry-run` against placeholder companies — connected to real
Lever endpoints, correctly wrote zero files, correctly found zero results (placeholder
board slugs, not a bug). Real results require real companies in `config/portals.yml`
(intentionally not filled in yet).

---

## 4. Phase 2 — Batched Score + Essay Draft (Cloud, 1 AI call per run)

**Trigger:** strict single daily cron run (e.g. 7:00 AM), not on-demand. Prevents
accidentally exhausting the ~5 routine-run/day cap on Pro during testing or iteration.

**Input text must be extracted, not raw HTML.** Job postings on real career pages often
carry thousands of words of navigation, cookie banners, and site boilerplate around the
actual description. Phase 1's scan step should extract just the core text — title,
requirements, description — before anything reaches a prompt. This keeps every batch
compact regardless of how bloated the source page is.

**What needs to be built:** the repo's existing `src/score/index.mjs` has a `--batch`
flag, but it *parallelizes* many separate `claude -p` calls (one per job) rather than
combining them into a single prompt. Matching this design requires rewriting that batching
logic to build one combined prompt for all pending offers instead.

**Prompt caching not a priority here.** Since this is already one call for the whole
batch, `cv.md` is only sent once regardless — there's no repeated prefix across separate
calls to cache. (Caching matters more in Phase 4 — see Section 6.)

**Prompt shape (one call, whole batch):**
```
System: [cv.md] + scoring instructions (1-100, Python/SQL/Scikit-Learn/Pandas fit)
        + "Only include essay_answer for entries scoring >= 85, else null"
User:   [job 1 text], [job 2 text], ... [job N text], each tagged with its URL
```

**Response:**
```json
[
  { "url": "...", "score": 91, "why_fit": ["...","...","..."], "essay_answer": "..." },
  { "url": "...", "score": 62, "why_fit": ["...","...","..."], "essay_answer": null }
]
```

**Output:** `data/evaluations.jsonl`, one line per job.

---

## 5. Phase 3 — Digest Email (Cloud, Zapier MCP, $0 AI)

Filter `evaluations.jsonl` for `score >= 85`, send via the Zapier MCP Gmail connector
(confirmed authorized). Email includes company, title, score, why-fit bullets, essay
snippet, and an `/apply <url>` command block per qualifying job.

---

## 6. Phase 4 — Local Apply (WSL2/Ubuntu, 0-1 AI calls, TRIPWIRE)

**Precondition:** `chrome-apply` running (confirmed working — real Chrome window,
authenticated, isolated profile, port 9222).

**Step A — Scan the page ($0 AI, code confirmed to exist):**
Playwright, connected via CDP, walks the page. Label extraction uses the real
`dom-label.browser.js` script (injectable via `page.evaluate()`), which already handles
Lever/Ashby/Greenhouse-specific label patterns plus generic `label[for]`/`aria-label`
fallbacks.

**Step B — Classify and fill standard fields ($0 AI, code confirmed to exist):**
`field-classifier.mjs`'s `classifyField()` matches each field against ~30 known patterns
(email, phone, first/last name, education, work experience, work authorization,
sponsorship, EEO questions, file uploads, etc.) and `mapProfileValue()` pulls the answer
directly from `config/candidate-profile.yml`. **No AI call for any of this** — it's pure
regex matching against your profile data. React-based custom dropdowns are handled by the
separate `react-select-helper.mjs` snippet (also $0 AI, deterministic).

**Step C — Free-text fields (1 AI call, only if needed):**
Only fields `classifyField()` returns as `free_text` (a `<textarea>` matching no other
pattern) need an actual generated answer. If a form has one or more such fields, one
prompt is sent: the question(s) + `cv.md`, grounded, 80-150 words, "never invent
experience." Many applications — those with only standard fields — will need **zero**
AI calls in this step.

**Prompt caching applies here.** Unlike Phase 2, Phase 4 makes a separate call per
application, and every one of those calls repeats the same `cv.md` + instructions prefix.
Structuring this prompt with that fixed content first, unchanged across every
application, lets caching cut the repeated input-token cost across a day's worth of
applications — this is where caching actually earns its keep in this pipeline.

**Step D — Resume upload ($0 AI, code confirmed to exist):**
`upload-file.mjs` connects via Playwright's `connectOverCDP` and sets the file directly
on the `<input type="file">` element — bypasses page-level upload restrictions. Genuinely
tested, real CDP mechanics, not a placeholder.

**Step E — TRIPWIRE:**
Halts unconditionally at the final review screen. Never calls Submit. You review, solve
any CAPTCHA, and click Submit yourself.

**What still needs to be built:** none of the individual pieces above are missing — they
all exist as real, working modules in the repo. What's missing is the **top-level script**
that calls them in this order. The repo's current entry point for `/apply` is
`.claude/commands/apply.md`, an AI-agent playbook that reads the page live instead of
calling these modules directly — that's the piece to replace with a plain orchestration
script.

---

## 7. Verified Reusable Code Inventory

Every file below was opened and read directly — not assumed from the README — to avoid
repeating an earlier mistake where a described-but-unverified script turned out not to
exist.

| File | Confirmed contents | AI involved? |
|---|---|---|
| `field-classifier.mjs` | `classifyField()` — regex-matches ~30 field types; `mapProfileValue()` — maps to profile data | No |
| `dom-label.mjs` / `dom-label.browser.js` | `extractLabel()` — finds a field's human label across multiple ATS-specific patterns; `clickInQuestion()` — clicks a radio/checkbox by matched question+choice text | No |
| `react-select-helper.mjs` | `REACT_SELECT_SNIPPET` — opens and selects from React-Select-style custom dropdowns | No |
| `upload-file.mjs` | `uploadFile()` — genuine Playwright `connectOverCDP` file upload | No |
| `step-detect.mjs` | `detectStep()` — detects which page of a multi-step flow you're on via URL/DOM markers shaped like Workday's flow | No (but see Open Items — conflicts with README) |
| `confirmation-detector.mjs` | Old success/fail page detection — confirmed dead code, not called since the auto-submit tripwire patch | No |
| `accounts.mjs` | Generates/stores per-ATS email aliases + random passwords for platforms requiring account creation | No |
| `language-detect.mjs` | Detects French vs. English from job posting text; **defaults to French when ambiguous** | No |
| `cover-letter.mjs` / `letter-generator.mjs` | Optional cover-letter generation — calls `claude -p` (same subscription billing as Phase 2) | **Yes, if used** |
| `apply-log.mjs` | Simple JSON-line logging of each apply attempt | No |

---

## 8. Open Items

- [ ] **Top-level Phase 4 orchestration script doesn't exist yet.** All the pieces in
      Section 7 are real, but nothing currently calls them in sequence outside of the
      agent-driven `apply.md`. This is the main thing to build.
- [ ] **Phase 2 batching code doesn't exist yet.** Needs a rewrite of `src/score/index.mjs`
      to build one combined prompt instead of parallel per-job calls.
- [ ] **Workday step-detection conflict.** `step-detect.mjs` contains real, Workday-shaped
      step signatures, but the README explicitly says "`/apply` support not yet
      implemented" for Workday. Don't assume Workday applications work until this is
      resolved directly — the code may be partial/unused scaffolding.
- [ ] **Account-creation flow (`accounts.mjs`) isn't accounted for in this design yet.**
      Some ATS platforms require creating a login before applying — this needs a step in
      the Phase 4 flow we haven't designed.
- [ ] **`claude-in-chrome` extension's exact role is still unclear** now that Phase 4 is
      code-driven rather than agent-driven. May not be needed at all for the new design —
      needs confirming before assuming it's required.
- [ ] **`config/cv.md`, `config/candidate-profile.yml`, `config/portals.yml` are still
      templates.** Real data needed before either phase produces meaningful output.
- [ ] **`config/` and `data/` are `.gitignore`'d by default** — `cv.md` needs to be
      explicitly committed to the private fork for the cloud Routine to see it.
- [ ] **Verify `jdMaxTokens: 1500` in `src/score/index.mjs` does smart extraction, not
      a blunt cutoff.** If it just truncates raw scraped text at a token count, it could
      cut off mid-requirements or waste budget on boilerplate before the real content —
      needs reading the actual truncation logic, not assumed from the flag name.
- [ ] **Phase 4's prompt-caching structure isn't implemented yet** — needs the free-text
      call built with `cv.md`/instructions as a stable prefix from the start, not
      retrofitted later.
- [ ] Confirm Claude Code Routines' daily run cap (previously found to be ~5/day on Pro,
      shared with all Claude Code/chat usage) comfortably fits a single daily 7:00 AM
      trigger plus normal interactive development usage.

---

*Every code claim in this document was verified by opening the actual file — either
directly, or pasted from the user's local clone when direct access wasn't possible.
If anything here turns out to be wrong, verify by reading the real file again before
changing the design — don't reason from the README or from what a related file implies.*
