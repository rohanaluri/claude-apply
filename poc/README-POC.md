# POC — Core Apply Loop Test

Tests only the core mechanic: scan fields → classify → fill known ones from a mock
profile → ask Claude once for free-text answers → fill those → STOP (never submits).

## Files
- `mock-profile.yml` — fake identity (matches field-classifier's expected keys)
- `mock-cv.md` — fake CV, used only for the free-text answer
- `test-form.html` — a local mock application form
- `poc-fill.mjs` — the orchestration script

## Setup (run these in Ubuntu)

1. Put this `poc/` folder **inside your repo** so it can import the real modules:
   ```bash
   # from wherever the poc folder landed, move it into the repo root:
   mv poc ~/claude-apply/poc
   cd ~/claude-apply/poc
   ```

2. Make sure deps exist (playwright + js-yaml are already in the repo):
   ```bash
   cd ~/claude-apply && npm ls playwright js-yaml
   ```

3. Launch the CDP Chrome if it isn't already running:
   ```bash
   chrome-apply
   ```

4. Open the test form in that Chrome window. Easiest: copy its file path and paste
   into the chrome-apply address bar:
   ```
   file:///home/rohan/claude-apply/poc/test-form.html
   ```

## Run

From `~/claude-apply/poc`:
```bash
node poc-fill.mjs --url test-form.html
```

(The `--url` value just needs to be a substring of the open tab's URL, so
`test-form.html` matches `file:///.../test-form.html`.)

## What to expect
- It prints every field it found + its detected label.
- It prints how each field was classified and whether it was filled from the
  profile or flagged for Claude.
- It makes ONE claude call for the essay question.
- It fills the form in the visible Chrome window and stops.
- **Verify by eye** that each box got the right value.

## If something breaks
Paste the full terminal output back. Common things:
- `No browser context` → chrome-apply isn't running.
- `Cannot find module field-classifier` → poc folder isn't inside the repo, or
  `src/apply/` path differs. Set `CLAUDE_APPLY_ROOT=~/claude-apply` when running.
- Claude parse failure → paste the printed stdout snippet.
