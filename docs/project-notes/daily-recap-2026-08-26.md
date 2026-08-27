# Daily Recap — 2026-08-26

## Headline

**First fully successful end-to-end cloud Routine run with real data, all four phases.**
19 real postings found → 17 scored in one batch call → 0 crossed the digest threshold
(expected — placeholder CV vs. real senior/principal roles). This resolves three Open
Items that had been blocking since 2026-08-24: `portals.yml` staleness, unproven
multi-offer batching, and `cv.md` never being exercised by a cloud run.

Getting here required diagnosing and fixing a genuine multi-layered environment problem
in Phase 2's job-fetching mechanism — documented in detail below since the debugging
path itself (not just the final fix) is worth remembering for any future
browser-in-cloud-sandbox issue.

---

## What we set out to do

Three items, understood from the start as one dependency chain, not three separate
tasks:
1. Fix `portals.yml`'s stale/wrong company slugs (blocking Phase 1)
2. Prove `cv.md` actually gets read by a cloud run (blocked on #1 — no postings meant
   nothing for Phase 2 to score)
3. Prove Phase 2's multi-offer batching in production (same blocker)

---

## Part 1 — Getting real postings into the pipeline

**`portals.yml` fix.** Since this is POC stage, real company identity didn't matter —
just needed genuine live Lever postings. Verified via direct `web_fetch` against real
Lever boards (not just search snippets) before committing to anything:
- **PointClickCare** (`jobs.lever.co/pointclickcare`) — confirmed live, 80+ real postings
- **Analytic Partners** (`jobs.lever.co/analyticpartners`) — confirmed live, includes an
  actual "Data Science Analyst" posting (Miami, FL)

Dropped Anthropic/Photoroom/ElevenLabs (all 404ing — wrong platform or stale slugs, per
2026-08-24's diagnosis).

**`title_filter` fix.** Discovered the filter was still the original repo's
`Intern/Internship/Stage/Stagiaire` list — would have silently rejected every real
Associate/entry-level posting even with correct companies. Broadened to
`Data/Analyst/Scientist/Engineer`.

**`target_locations` fix — a second, separate blocker found by checking ahead rather
than waiting for it to fail.** `candidate-profile.yml`'s `target_locations` was
commented out, silently deriving from the placeholder `city: Paris` / `country: France`
fields to `["France", "Paris", "Remote"]`. Real US postings (e.g. Analytic Partners'
Miami listing) would have been silently filtered out — same failure category as the
title filter, different file. Added an explicit override:
```yaml
target_locations:
  - Remote
  - United States
  - USA
```
Confirmed this is the correct fix location (global default in `candidate-profile.yml`,
not a per-company override in `portals.yml`) since both companies need the same US/Remote
targeting — no duplication between the two files.

**Schema validator bug this introduced.** First Routine run after these changes failed
immediately: `ProfileInvalidError: unknown field: target_locations`. Root cause:
`candidate-profile.schema.mjs`'s `OPTIONAL_FIELDS` allowlist didn't include the new key —
exact same failure pattern as the `digest_sheet_id` bug from 2026-08-23 (Decision #21).
Fixed by adding `target_locations` to `OPTIONAL_FIELDS`. Verified `fs` import style
(`import fs from 'node:fs'`, not destructured) before trusting a suggested `sed` command
that assumed `fs.existsSync` would work.

**Result:** next Routine run found **19 real postings** (15 PointClickCare, 4 Analytic
Partners; Mistral AI still 0, flagged as possibly a bad slug, not blocking).

---

## Part 2 — The Playwright-in-cloud-sandbox saga

With real postings flowing, Phase 2 (`--batch`) immediately hit a new wall: every single
fetch failed. This took four sequential fixes to fully resolve, each one revealing the
next real blocker underneath — worth recording the full path, not just the ending.

### Attempt 1: `cv.md` missing
First failure was actually unrelated to Playwright — `config/cv.md` was `.gitignore`'d
and had never been committed (grouped with the real secret, the service-account key, by
mistake — it holds only placeholder Alice Martin data, no real PII, same category as
`portals.yml`/`candidate-profile.yml` which were already force-committed per Decision
#22). Force-committed it the same way. This unblocked Phase 2 far enough to reach the
actual browser-fetch code.

### Attempt 2: browser version mismatch
`browserType.launch: Executable doesn't exist at .../chromium_headless_shell-1217/...`
— the cloud sandbox's pre-installed Chromium was version `-1194`; the `playwright` npm
package expected `-1217`. Researched real GitHub issues (not guessed): this is a common,
documented pattern — sandboxes/CI images ship a pre-baked browser that drifts from
whatever version the npm package resolves to.

Tried the standard fix (`npx playwright install chromium` as an explicit Routine step) —
failed with a 403: `cdn.playwright.dev` isn't on the custom network allowlist. The
Routine's own error output was actually useful here: it noted the sandbox ships a
pre-installed browser at `/opt/pw-browsers` specifically because this download path is
blocked. Set `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` as an Environment variable
instead of trying to download anything.

### Attempt 3: wrong binary variant
Still `Executable doesn't exist`, now for `chromium_headless_shell-1217` specifically —
confirmed via research that Playwright defaults headless launches to a separate,
smaller "headless shell" binary since v1.49, distinct from the full `chromium` binary.
The sandbox only has the full binary. Fixed by adding `channel: 'chromium'` to the
`launch()` call in `src/score/index.mjs`.

### Attempt 4: hardcoded version path
Browser found the right *type* of binary but still guessed a version-numbered path
(`chromium-1217/...`) that didn't match the actual `-1194` install. Diagnosed via a
temporary read-only diagnostic swapped into the Routine's Instructions
(`find /opt/pw-browsers -maxdepth 4`, then `ls -la` on the suspected symlink) rather than
guessing blind. Confirmed `/opt/pw-browsers/chromium` is a symlink that always points at
whatever version is actually installed, regardless of number. Fixed by pointing
`executablePath` at that symlink directly, conditional on `fs.existsSync(...)` so local
WSL2 runs (no `/opt/pw-browsers`) are unaffected:
```js
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  ...(fs.existsSync('/opt/pw-browsers/chromium') && { executablePath: '/opt/pw-browsers/chromium' }),
});
```

### The real wall: browser navigation itself is blocked
With the browser now launching correctly, every fetch still failed — this time with
`net::ERR_TUNNEL_CONNECTION_FAILED`. Researched this specifically (not assumed): a real,
current GitHub issue (`anthropics/claude-code#11791`) confirms this is architectural —
"Browser automation tools (Playwright, Puppeteer, Selenium) are not supported in the web
sandbox environment. The security proxy does not support HTTPS CONNECT tunneling
required by browsers." No further browser/version config would fix this — a genuinely
different approach was needed for fetching job text in the cloud.

### Actual fix: stop using a browser for Lever
Key insight: Phase 1 already fetches successfully from `api.lever.co` in this exact
sandbox via plain `fetch()` — that's how the 19 postings were found. Plain HTTPS
requests aren't affected by the CONNECT-tunnel block; only real browser navigation is.
Confirmed (via `fetchLever` in `src/scan/ats/lever.mjs`) that Lever's API response
already includes the full plain-text job description (`descriptionPlain`) — no HTML
parsing needed.

Rewrote `fetchOfferBody()` in `src/score/index.mjs`: for Lever URLs, call the same
public board API Phase 1 uses (`api.lever.co/v0/postings/{slug}?mode=json`), find the
matching posting by `hostedUrl`, and return `descriptionPlain` directly — no browser
involved. Verified this endpoint's shape via Lever's own public docs before writing
code (no single-posting-by-ID endpoint is documented, so this fetches the whole board
and matches by URL, same pattern `fetchLever` already uses — not a new unverified
endpoint). Non-Lever platforms still fall back to the original Playwright path,
unchanged, untested in the cloud sandbox.

**Full file replacement** (not a `sed` patch) since this was the largest single code
change of the day — read the complete real file first via upload rather than
reconstructing from fragments, then edited and handed back in full for download → `cp`
→ `md5sum` verify, same discipline as every other file today.

**Test suite:** 695/700 passing before and after — the 5 failures are pre-existing and
unrelated (3 `cover-letter.mjs` date-formatting off-by-ones, 1 stale French-prompt test
in `prompt-builder.mjs` predating Decision #15's English rewrite, 1 mock-shape issue in
a `--re-score` test). No regressions introduced by today's changes.

---

## Final result

Routine run, 2026-08-26, real 4-step Instructions, exit code 0 throughout:
- **Phase 1:** 3 companies scanned, 112 raw postings, 19 new → `pipeline.md`
- **Phase 2:** 19 offers → 2 filtered (empty JD body) → 17 scored in one batch call.
  All 17 verdict `skip`. Scores 0.3–7.5 (highest: two duplicate "Marketing Science
  Analyst" postings at Analytic Partners, 7.5 each; lowest: Principal-level
  PointClickCare eng/PM roles, 0.3–1)
- **Phase 3:** 17 evaluations reviewed, 0 ≥ 8 (the configured `auto_apply_min_score`) →
  no digest row written, no email sent

Scores read as correct, not broken — Alice Martin's placeholder profile (French
ML-research student) genuinely doesn't match Principal/Senior US Data Scientist roles.
This is the expected outcome for today's POC-stage test data, not a scoring bug.

---

## Documentation updated today

- **`pipeline-architecture.md`:** Decision #23 added; Section 3 (Phase 1) and Section 4
  (Phase 2) rewritten to reflect confirmed production status; Section 7's inventory
  table updated for `score/index.mjs`'s new Lever-fetch behavior; Section 8's env var
  list updated with `PLAYWRIGHT_BROWSERS_PATH`; three Open Items marked resolved, one
  new Open Item added (non-Lever platforms still untested against the cloud sandbox
  wall).

---

## Carried forward to next session

- **Non-Lever platforms (Greenhouse, Ashby, Workday) are unproven in the cloud
  sandbox.** Same `ERR_TUNNEL_CONNECTION_FAILED` wall will likely apply if/when those
  platforms get added to `portals.yml`. Greenhouse and Ashby already expose body text
  via their own APIs (confirmed: `fetchGreenhouse`, `fetchAshby` both map a `body`
  field) — same fix pattern as today's Lever fix would apply directly. Workday has no
  equivalent (`fetchOfferBody` for Workday is explicitly unimplemented) — separate,
  harder problem.
- **Dashboard not yet reviewed.** `src/dashboard/` exists and was referenced today (as
  a way to review low-scoring evaluations beyond raw `evaluations.jsonl`) but its actual
  output/format hasn't been inspected this session.
- **Real batch-call cost for 17 offers** not yet pulled from the Routine's logged
  `[usage]` line — worth checking next session alongside the still-outstanding
  same-day-repeat cache-read cost data point.
- **`cv.md`/`candidate-profile.yml` still hold placeholder data.** Real personal data
  entry remains explicitly deferred (Infrastructure First) until the pipeline mechanism
  is fully trusted — today's run is a strong step toward that, but not the trigger by
  itself.
- Location-autocomplete fix (Phase 4, Lever) still open — needs real widget HTML.
- Everything else in `pipeline-architecture.md`'s Open Items list (Section 9) not
  touched today remains open as previously stated.
