# Job Application Pipeline — Architecture v2.0

Base repo: https://github.com/LeoLaborie/claude-apply (forked to `rohanaluri/claude-apply`, private)
Orchestration: Claude Code Routines (cloud, Anthropic-managed)
Local execution environment: **WSL2 (Ubuntu) running on a Windows host**
Notification: Zapier MCP → Gmail

---

## 0. Key Decisions Log (read this first if confused later)

1. **The repo's default `/apply` auto-submits.** We are patching this. Our version
   MUST stop at the final review screen and never click Submit. This is a deliberate
   deviation from upstream `claude-apply` behavior — do not "fix" it back.
2. **Essay drafting only happens for jobs that score ≥ 85.** Scoring and essay
   drafting are combined into a single Claude API call per job (see Phase 2), but
   the essay field in the response schema is only populated when the model's own
   score comes back ≥ 85. This avoids wasting a generation on jobs that never
   make the digest.
3. **`cv.md` is cached, not resent per-job.** All Phase 2 calls for a given
   morning's batch reuse a single cached prompt block containing the CV. Only the
   per-job posting text is fresh input each call.
4. **Routines run 1x/day at 6:30 AM, cloud-only, PC off.** This uses 1 of 5 daily
   Pro-plan routine runs (shared pool with morning news briefing routine and any
   interactive Claude Code usage that day — budget accordingly, 3 runs/day remain
   in reserve).
5. **Phase 4 (actual browser apply) is local-only, human-triggered, never
   automatic.** Nothing submits without you physically clicking Submit.
6. **Local execution runs inside WSL2/Ubuntu, not Windows directly.** `claude-apply`'s
   `scripts/setup.sh` only supports Linux and macOS — there is no Windows branch in
   the upstream repo. Rather than patch around this gap piecemeal (the whole repo
   assumes a Unix-like environment throughout — file paths, shell aliases, Chrome
   detection, etc.), the entire local stack runs inside a real Ubuntu environment via
   WSL2. This is not a workaround bolted onto a Windows setup — it **is** the local
   architecture. Every local command in this document (`chrome-apply`, `node
   src/scan/index.mjs`, `/apply`, etc.) runs inside this Ubuntu environment.

---

## 1. Local Execution Environment (Architecture Spec)

This section defines the actual local stack the pipeline runs on. Treat this as
infrastructure spec, not a setup log — it's what Phase 1 and Phase 4 assume exists
when they say "run locally."

**Host:** Windows 11 PC, with WSL2 (Windows Subsystem for Linux) enabled and running
an Ubuntu distribution. WSL2 runs a real Linux kernel in a lightweight VM — this is not
emulation, and GUI Linux apps (like Chrome) are forwarded natively to the Windows
desktop via WSLg, so they appear and behave like normal Windows windows despite running
inside Linux.

**Why WSL2 instead of native Windows:** `claude-apply` is written assuming Linux/macOS
throughout — its setup script, its Chrome-detection logic, and its shell-alias-based
command registration (`chrome-apply`) all depend on a Unix-like environment. WSL2 gives
the toolchain the exact environment it expects, eliminating an entire class of
Windows-compatibility bugs rather than patching them one at a time.

**Repo location:** `~/claude-apply` (i.e. `/home/rohan/claude-apply`) — inside Ubuntu's
own filesystem, **not** reached through `/mnt/c/...`. Files living natively in Linux's
filesystem avoid the performance and permission quirks of crossing the Windows/Linux
boundary on every read/write, which matters for `npm install`, Playwright, and
`scripts/setup.sh`.

**Runtime versions:**
- Node.js 20 (via `nvm`, matching the repo's `.nvmrc`) — installed inside Ubuntu,
  independent of any Node version on the Windows side.
- Google Chrome (`google-chrome-stable`), installed inside Ubuntu via `apt` from
  Google's official repository — a **separate Chrome install from the everyday Windows
  Chrome browser**. Ubuntu cannot see or use the Windows Chrome install.

**Chrome CDP profile:** A dedicated, isolated Chrome profile used exclusively by this
pipeline, launched via a shell alias:
```bash
alias chrome-apply='"/usr/bin/google-chrome" --user-data-dir="/home/rohan/.config/google-chrome-claude-apply" --remote-debugging-port=9222 &'
```
- Defined in `~/.bashrc`, active in every new Ubuntu terminal session automatically.
- `--user-data-dir` isolates this profile's cookies, history, extensions, and saved
  logins from any other Chrome profile — separate from personal browsing entirely.
- `--remote-debugging-port=9222` exposes the Chrome DevTools Protocol (CDP) interface
  that `src/apply/index.mjs` connects to for automated form-filling.
- This profile is signed into the Gmail account designated for job applications, and
  has the `claude-in-chrome` extension installed per the repo's setup instructions.

**GitHub authentication (inside Ubuntu):** `gh` (GitHub CLI), authenticated via browser
OAuth (`gh auth login`), authorized against the private fork `rohanaluri/claude-apply`.
Separate from any Git credentials configured on the Windows side.

**Known cosmetic log noise (not architecturally significant, do not debug further):**
Chrome running under WSL2 without full GPU passthrough or a complete desktop
environment logs harmless warnings on every launch — `WebGL1/WebGL2 blocklisted`, `dbus`/
`UPower` service-not-found errors, Google push-notification registration errors,
`Fontconfig` warnings, and `incorrect profile type` messages on new-tab loads. None of
these affect the DOM-level automation Playwright performs against this Chrome instance.

**What this environment is NOT used for:** The cloud Routine (Phases 1-3) does not run
here — it runs on Anthropic-managed cloud infrastructure, cloning the GitHub repo fresh
on each run. This local WSL2/Ubuntu environment is specifically where Phase 4 (the
actual browser-based application submission) executes, since Chrome CDP automation
inherently requires a real, local, authenticated browser session.

---

## 2. Architecture Diagram

```
[6:30 AM — Claude Code Routine fires, cloud, PC off]
        │
        ▼
PHASE 1 — Discovery & Prefilter (cloud, deterministic, $0 LLM)
  node src/scan/index.mjs
  reads config/portals.yml → hits Greenhouse/Lever/Ashby public APIs
  title filter: excludes Senior/Sr./Lead/Manager/Director/Staff/Principal/III/IV
                includes Associate/Junior/I/II/Entry-level/New Grad/Data Scientist
        │
        ▼  data/pipeline.md (surviving postings)
        │
PHASE 2 — Combined Score + Essay Draft (cloud, 1 Claude API call/job, cached CV)
  input: cached cv.md block + job posting text + any detected essay field
  output (structured JSON): { score, why_fit[], essay_answer | null }
  essay_answer populated ONLY if score >= 85
  → data/evaluations.jsonl
        │
        ▼  filter: score >= 85
        │
PHASE 3 — Digest Email (cloud, Zapier MCP → Gmail)
  markdown email per qualifying job:
    company, title, score, why-you-fit bullets, essay snippet (if drafted),
    /apply <url> command block
        │
        ▼
[You open your PC, read the email]
        │
        ▼
PHASE 4 — Local Apply (human-in-the-loop, WSL2/Ubuntu, Chrome CDP)
  you paste `/apply <url>` into Claude Code, running inside your Ubuntu terminal
  → chrome-apply launches the dedicated, authenticated Chrome profile (CDP port 9222)
    — this Chrome instance runs inside WSL2/Ubuntu, displayed natively on your
      Windows desktop via WSLg
  → node src/apply/index.mjs connects via CDP, drives the automation — token-free,
    deterministic Playwright code, not an LLM call
  → resume PDF attached via CDP upload
  → essay answer injected from data/drafts/[job_id].json (already generated in
    Phase 2 — reading a file here costs $0)
  → HALTS at final review screen — TRIPWIRE, no auto-submit
  → you verify, solve CAPTCHA if present, click Submit yourself
```

---

## 3. Phase 1 — Discovery & Prefilter (Cloud, $0 LLM tokens)

**Trigger:** Claude Code Routine, cron `30 6 * * *`, cloud infra — runs independently
of the local WSL2/Ubuntu environment; the Routine clones the GitHub repo fresh on each
run, it does not touch your local machine.

**Command:** `node src/scan/index.mjs`

**Config — `config/portals.yml`:**
```yaml
companies:
  - name: ExampleCo
    ats: greenhouse
    board_token: exampleco
  - name: AnotherCo
    ats: lever
    org: anotherco
  - name: ThirdCo
    ats: ashby
    org_slug: thirdco

title_filter:
  excluded_any:
    - "Senior"
    - "Sr."
    - "Lead"
    - "Manager"
    - "Director"
    - "Staff"
    - "Principal"
    - "III"
    - "IV"
  required_any:
    - "Associate"
    - "Junior"
    - " I "
    - " II "
    - "Entry-level"
    - "Entry Level"
    - "New Grad"
    - "Data Scientist"
```

Note: `required_any` includes "Data Scientist" itself, or the role-level keywords
alone would pass through non-DS roles too. Use `/tune-filter` locally (inside the
Ubuntu environment) once to calibrate against `data/scan-history.tsv` before trusting
this unattended.

**Confirmed working (dry run):** `node src/scan/index.mjs --dry-run`, executed inside
the Ubuntu environment, ran successfully against the placeholder template companies —
connected to real Lever API endpoints, correctly wrote zero files (per `--dry-run`),
and correctly reported zero new postings since the template board slugs are placeholder
values, not errors in the pipeline logic itself.

**Output:** `data/pipeline.md` — new/undeduplicated postings only
(dedup source of truth: `data/scan-history.tsv`).

**Cost:** $0 in LLM tokens. Pure API polling + deterministic JS filtering.

---

## 4. Phase 2 — Combined Match Score + Conditional Essay Draft (Cloud)

This is the one Claude-billed step, and it runs as part of the same cloud Routine as
Phase 1 and Phase 3 — no local/Ubuntu involvement.

**Per-job call structure:**

- **System/cached block** (reused across every job in the batch — this is what
  prompt caching targets): full contents of `config/cv.md`, plus scoring
  instructions (score 1–100 on Python/SQL/Scikit-Learn/Pandas fit) and essay
  grounding rules ("draft strictly from facts in the CV above, no invention").
- **Per-job fresh input:** raw job posting text + any detected long-text/essay
  form field label (e.g. `custom_question_1`, "Describe a complex data project
  you completed").
- **Requested output (structured JSON):**
  ```json
  {
    "score": 91,
    "why_fit": ["...", "...", "..."],
    "essay_field_detected": "custom_question_1",
    "essay_answer": "..."   // null unless score >= 85
  }
  ```

**Model instruction for essay gating:** the model is told explicitly in the
cached system block: *"Only write a value for essay_answer if you have just
scored this job 85 or above. Otherwise set essay_answer to null."* This keeps
it a single round trip instead of a score-then-branch-then-draft pipeline,
while still not spending generation effort on essays for rejected jobs.

**Output:** `data/evaluations.jsonl` (score, why_fit, essay per job)
Essay text also persisted separately to `data/drafts/[job_id].json` for Phase 4
to consume without re-parsing the full evaluations log. Because the cloud Routine
commits/persists this repo state, Phase 4 (running locally in Ubuntu) can read
`data/drafts/[job_id].json` after pulling the latest repo state.

**Cost:** ~$0.03/job baseline per the repo's existing pricing, reduced further
by CV caching (the CV is the largest and most repetitive chunk of the prompt —
caching removes its cost from every job after the first in a given routine run).

---

## 5. Phase 3 — Digest Email (Cloud, Zapier MCP)

**Filter:** `evaluations.jsonl` entries where `score >= 85`.

**Delivery:** Zapier MCP Gmail connector, triggered at the end of the same
cloud routine run (no separate schedule needed, no local involvement).

**Per-job email block:**
```
### {Company} — {Job Title}
**Match Score:** {score}/100

**Why You Fit:**
- {why_fit[0]}
- {why_fit[1]}
- {why_fit[2]}

**Drafted Essay Answer (if applicable):**
> {essay_answer snippet}

Apply:
```
/apply {job_application_url}
```
```

---

## 6. Phase 4 — Local Apply (Human-in-the-Loop, WSL2/Ubuntu, TRIPWIRE)

**Precondition:** Claude Code running inside your **Ubuntu terminal** (WSL2), with the
`chrome-apply` alias available (defined in `~/.bashrc`, see Section 1). This launches
the dedicated, CDP-enabled Chrome profile, signed in and with `claude-in-chrome`
installed.

**Trigger:** you paste `/apply <url>` from the digest email into Claude Code, running
inside your Ubuntu terminal (not Windows PowerShell — the repo and its dependencies
live in the Linux filesystem, per Section 1).

**Division of labor:**
- **Claude Code's role is dispatch only.** `/apply <url>` is a slash command
  that reads the instruction and invokes `node src/apply/index.mjs`. Claude
  Code does not read the webpage, look at the DOM, or guide the cursor itself.
  The one exception: the TRIPWIRE stop-condition (step 4 below) lives in this
  dispatch layer — it's what prevents the script from proceeding to the
  auto-submit call after the script halts.
- **`src/apply/index.mjs` does the actual work, token-free.** Uses Playwright,
  connecting over CDP to the already-running `chrome-apply` Chrome instance
  (port 9222) — standard, deterministic browser automation, not an LLM. It finds
  fields by matching labels/names/ids (e.g. `<input id="email">`) and types into
  them directly. Zero AI tokens, $0.00, because this is classic code, not a model
  decision. This Chrome instance runs inside WSL2/Ubuntu but displays as a normal
  window on your Windows desktop via WSLg — you interact with it exactly as you
  would any other browser window.

**Steps:**

1. Opens the job URL in the `chrome-apply` Chrome window via CDP.
2. **Token-free** field classification and fill — deterministic label/name
   pattern matching, not an LLM call. Name, email, phone, social links filled.
   Resume PDF attached via CDP upload (bypasses page-level restrictions).
3. **Essay injection — also token-free at this stage.** The $0.03 Claude spend
   already happened once, overnight, in the cloud (Phase 2). By the time `/apply`
   runs locally, the essay text is just a string sitting in
   `data/drafts/[job_id].json`. The Playwright script reads that file and pastes
   the string into the matching custom question box — no model call involved at
   apply-time.
4. **TRIPWIRE — patched behavior, differs from upstream repo:**
   Halts unconditionally at the final review/submit screen. Does **not**
   detect a confirmation page and does **not** update the tracker automatically,
   because it never submits. This requires patching `src/apply/index.mjs` (or
   equivalent) to remove/guard the auto-submit call that ships in upstream
   `claude-apply`. **Not yet implemented — this is the current, active task.**
5. You review the pre-filled form, solve any CAPTCHA, and click Submit
   yourself. Tracker (`data/applications.md`, `data/apply-log.jsonl`) updates
   only after your manual submission is detected, or you update it by hand.

---

## 7. Open Items to Resolve

- [ ] **Code patch needed — not yet written.** `src/apply/index.mjs` still has
      its upstream auto-submit behavior. Generate the specific line-level diff
      that removes/guards the auto-submit call and replaces it with the
      halt-at-review-screen behavior described in Decision #1 / Phase 4 step 4.
      Do this with Claude Code running inside the Ubuntu environment, with the
      actual file open, so the diff matches the real code.
- [ ] **`config/cv.md` is currently a template, not your real CV.** Phase 2's
      scoring and essay-drafting quality is entirely dependent on this file
      being your actual, complete Associate Data Scientist profile — real
      projects, real tools used (Python/SQL/Scikit-Learn/Pandas specifics),
      real work history. This needs to be filled out before the first real
      routine run — either by hand or via `/apply-onboard` with your CV PDF.
- [ ] Calibrate `title_filter` with `/tune-filter` against real
      `scan-history.tsv` data before trusting Phase 1 unattended.
- [ ] **`config/` and `data/` are `.gitignore`'d by default in the repo
      template.** Since the cloud Routine only sees what's committed to
      GitHub, a gitignored `cv.md` will be invisible to Phase 2 at runtime.
      Decide explicitly: commit `cv.md` to the private fork (fine, since it's
      private), or find another way to make it available to the cloud
      session. Don't let this surface as a silent Phase 2 failure on the
      first real run.
- [ ] Decide fallback behavior if Phase 2 returns fewer than expected due to
      thin `required_any` matches.
- [ ] Verify current Routines daily-run cap (5/day Pro, shared with interactive
      usage) still fits your existing morning news briefing routine before
      going live.
- [ ] **Phase 1 dry-run output was in French** ("Entreprises scannées," etc.) —
      cause not yet identified (possibly a locale setting picked up by the
      Ubuntu install). Not blocking, but worth a quick look before relying on
      this unattended, in case it affects log parsing anywhere downstream.
- [ ] **Exact role of the `claude-in-chrome` extension is unconfirmed.** It was
      installed because the repo's own setup instructions call for it, but the
      Phase 4 design above has Playwright/CDP — not the extension — doing the
      actual field-filling, token-free. Need to check whether the extension is
      used elsewhere in the repo (e.g. `/apply-onboard`'s CV reading step, or
      as a manual fallback for unsupported job sites) before assuming it's
      load-bearing for the core `/apply` flow.

---

*This document reflects the agreed architecture as of this conversation, including
the WSL2/Ubuntu local environment now in use. Day-to-day setup progress and
troubleshooting history are tracked separately, not in this file. If anything
architectural changes, edit this file rather than relying on chat history.*
