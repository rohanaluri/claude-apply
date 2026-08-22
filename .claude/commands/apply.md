---
description: Fill a job application on the given URL via the code-driven Phase 4 pipeline (scan → classify → fill → 1 AI call → tripwire), then stop for human review before submission.
argument-hint: <job-url> [--dry-run]
---

## `--help` / `-h`

Si `$ARGUMENTS` commence par `--help` ou `-h`, imprime uniquement le bloc ci-dessous et arrête-toi. N'ouvre pas Chrome, ne lis aucun fichier de `config/` ou `data/`.

```
Usage: /apply <url> [--dry-run] [--port 9222] [--max-ai-calls 1]

Runs the code-driven Phase 4 pipeline against a live job posting:
  scan every form field -> classify from config/candidate-profile.yml ->
  fill deterministically -> ONE batched AI call for genuine free-text
  questions -> upload resume -> STOP at a review banner. Never submits.

  --dry-run          scan and print the fill plan only; touches nothing,
                      uploads nothing, makes zero AI calls
  --port <n>         CDP port (default 9222, matches the chrome-apply alias)
  --max-ai-calls <n> cap on AI calls per page (default 1)

Prerequisites:
  - chrome-apply alias launched (CDP port 9222 up)
  - config/candidate-profile.yml exists and is valid

Files:
  reads:  config/candidate-profile.yml, config/cv.md, the CV file at cv_path
  writes: data/apply-log.jsonl

See also: /scan, /score, /dashboard
          docs/project-notes/pipeline-architecture.md (Section 6, Decision #1)
```

# /apply $ARGUMENTS

**This command is a thin wrapper around `src/apply/index.mjs`.** As of 2026-08-22 that
script is a plain, deterministic program — not an AI agent reading the page live turn by
turn. Claude's job here is to invoke it and relay what it reports, not to decide what to
click or how to interpret the page. See architecture doc Decision #1 for why this
matters: every AI call in this pipeline should be one prompt in, one structured answer
out, never an agent making a sequence of live judgment calls.

## 1. First-run guard

Check that `config/candidate-profile.yml` exists:

```bash
test -f config/candidate-profile.yml
```

If it does not exist, **stop** and tell the user:

> "No config found. Create `config/candidate-profile.yml` from the repo's template
> before running `/apply` — see `config/candidate-profile.yml.example` if present."

Do not proceed with the example/template profile as if it were real.

## 2. Run the script

Run exactly one Bash command, passing `$ARGUMENTS` through unmodified:

```bash
node src/apply/index.mjs $ARGUMENTS
```

The script parses its own `--dry-run`, `--port`, and `--max-ai-calls` flags and the job
URL. Do not pre-process, reformat, or add flags of your own here.

## 3. Relay the result verbatim

Show the script's full stdout output to the user as-is. It already prints:

- role/company/language detected
- how many fields were filled vs. flagged for review (and which are required)
- the exact reason each flagged field couldn't be confidently resolved
- a step-by-step trace
- an explicit reminder that nothing was submitted

**Do not re-summarize, re-interpret, or add your own commentary on top of this.** The
entire reason Phase 4 is now code-driven instead of agent-driven is that Claude
shouldn't spend tokens re-deciding something the script has already determined
deterministically.

If the script exits with a non-zero status (Chrome unreachable, invalid profile, page
load failure, blocked by a login wall/captcha/closed posting), its printed error message
**is** the diagnosis — relay it directly. Do not guess at a different cause or attempt a
workaround.

## Absolute rules (carried over from the original playbook, unchanged)

- **Never click Submit, under any circumstance.** The script's own tripwire logic (it
  refuses to click anything that classifies as a submit button, and injects a review
  banner instead) is the enforcement mechanism. This command does not add to or bypass
  that in any way — it has no submit-capable code path at all.
- **Never invent form data.** Every filled value comes from
  `config/candidate-profile.yml`, or from the single batched AI call grounded in
  `config/cv.md` for genuine free-text questions — never from Claude's own assumptions
  about the candidate.
- **The browser tab stays open when the script finishes.** The user reviews every field
  and clicks Submit themselves, in their own time.

---

_Historical note: this file previously contained a ~440-line AI-agent playbook that read
the live page turn-by-turn via `claude-in-chrome` MCP tools, making its own decisions at
each step. That approach is retired as of 2026-08-22 — `src/apply/index.mjs` now performs
the same work deterministically via Playwright/CDP, at a fraction of the token cost per
application. See the architecture doc's Decisions #1 and #16, and Section 6, for the
full reasoning and what was verified in promoting it._
