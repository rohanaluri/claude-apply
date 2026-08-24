# Daily Recap — 2026-08-23

**One-line summary:** Discovered Zapier's webhook trigger is Premium-only and replaced the
Phase 3 delivery mechanism with Google Sheets → Zapier → Gmail instead, proved it end-to-end
with a real received email, then built and debugged the actual cloud Routine until Phases
1-3 ran fully unattended with exit code 0 — closing out the POC's core end-to-end gate.

References the architecture doc: `docs/project-notes/pipeline-architecture.md`
(all section/decision numbers below refer to that document, now updated to match today).

---

## What We Accomplished

### 1. Found and evaluated live postings for the eventual Phase 2 multi-offer test
Before touching Zapier, searched for and verified (via direct `web_fetch`, not just
search snippets) 3 genuinely live job postings to use for a future multi-offer batch
test: Meds/BlueChew (Entry Level Data Analyst — a good title-vs-body mismatch test),
Jobgether (Senior Data Scientist — deliberate overqualified case), and Findigs (Data
Scientist — another realistic mismatch, 4+ yrs required). Also found and ruled out 3
postings that returned HTTP 200 but had expired content (Datalab USA, AbbVie, an Actian
internship) — a real edge case the current liveness filter (status/redirect-based) won't
catch, noted for later. This work was intentionally deferred in favor of finishing Phase
3/4 first, per your call — see Where We Left Off.

### 2. Hit and worked around Zapier's Premium paywall
Began building the Zap ("Webhook trigger → Send Gmail") per the original plan. Discovered
live in the Zapier editor that **"Webhooks by Zapier" is a Premium app**, requiring at
least a Starter paid plan — confirmed via Zapier's own pricing docs and community threads,
not just the UI's own gating message. Rather than pay or guess at a workaround, verified a
real alternative carefully (after last session's lesson about trusting unverified repo
assumptions): **Google Sheets is a standard, non-premium Zapier app**, confirmed directly
from Zapier's own help docs ("No paid Google Sheets plan required"), and a
Sheets-trigger-to-Gmail-action Zap is explicitly confirmed Free-plan-compatible in
Zapier's own community support answers. Also verified, directly from Zapier's pricing
page, that **trigger polling/checks never consume Zapier tasks — only the action step
does** — so running this 24/7 costs nothing extra.

### 3. Redesigned and rebuilt `src/digest/index.mjs` for Google Sheets
Replaced the webhook `fetch()` POST with a Google Sheets API write. Key design decisions
made along the way:
- **One row per day, never one row per job** — since Zapier's row trigger fires once per
  new row, one-row-per-job would mean N separate emails on a multi-job day, breaking the
  "single daily digest" design. `body` holds the entire multi-job markdown digest in one
  cell.
- **Dual authentication path**: checks `$GOOGLE_SERVICE_ACCOUNT_JSON` (raw key JSON, for
  the cloud Routine) first, falls back to the standard `$GOOGLE_APPLICATION_CREDENTIALS`
  file-path convention (for local WSL2) — same script works in both places without
  modification.
- Columns: `date | subject | job_count | body`, matching Zapier's field-mapping needs
  directly (Subject ← `subject`, Body ← `body`).

### 4. Set up Google Cloud service account and the real Google Sheet
- Created a Google Cloud project (`claude-apply`), enabled the Sheets API.
- Created a service account (`digest-writer@claude-apply.iam.gserviceaccount.com`),
  scoped to Sheets API only, generated its JSON key.
- Moved the key from Windows Downloads into `config/google-service-account.json`
  (confirmed `.gitignore`'d via `git check-ignore -v` before proceeding further).
- Created the real Google Sheet ("Daily Application Digest"), renamed its tab to
  "Digest," added the four column headers, and shared it with the service account's
  email as Editor.
- Confirmed via the Google Drive connector (read-only) at each step rather than trusting
  UI screenshots alone — caught a stale-metadata moment where the tab rename hadn't
  propagated yet before confirming it had.

### 5. Proved the Sheets write for real
Ran `node src/digest/index.mjs --dry-run` first (correct, expected "0 scored >= 8 today"
result, since the only real evaluation on file was below threshold and from a prior day).
Manually appended one fake high-scoring evaluation dated today, then ran the script for
real (no `--dry-run`) — confirmed a real row landed in the Sheet with correct date,
subject, job_count, and the full rendered markdown body, via direct Drive-connector read
of the actual cell content, not just the script's own stdout claiming success. Cleaned
the fake evaluation back out afterward.

### 6. Built the Zap and confirmed a real email
Built **Trigger: Google Sheets → "New Spreadsheet Row" (Instant)** → **Action: Gmail →
"Send Email"**, mapping Subject/Body directly from the row. Verified along the way that
the "Instant" label doesn't mean a premium/extra-setup feature — Zapier's own community
docs confirm it's a push-notification-plus-fetch hybrid Google sets up automatically,
~3 minutes end-to-end, still free. Published the Zap, and **confirmed a real digest email
actually arrived in Gmail** using the test row's data — not just a "Zap published"
success message. Flagged (openly, not silently) that the email body renders as literal
Markdown text (`##`, `**`, etc.) since Gmail's Body type is set to Plain — a known,
deliberate simplification for the POC.

### 7. Built the cloud Routine — and debugged it through three real failures
Created the Routine ("Job Pipeline — Scan, Score, Digest"), pointed at
`rohanaluri/claude-apply`, scheduled daily at 7:00 AM EDT. First real "Run now" failed
immediately and predictably: `config/portals.yml` and `config/candidate-profile.yml` are
both `.gitignore`'d and had never been committed, so the fresh cloud clone had no config
at all. Fixed by force-adding (`git add -f`) both files to the repo — confirmed safe
since neither holds real secrets (candidate-profile.yml is still placeholder Alice Martin
data). Also ran `npm audit` / `npm audit fix` at this point (2 high-severity transitive
vulnerabilities in `js-yaml`/`undici`, both from `googleapis`) — confirmed 0 vulnerabilities
after, and re-ran `digest/index.mjs --dry-run` locally to confirm the fix didn't break
anything before pushing.

Second real failure, after committing config: the routine's setup script (`npm install`)
failed with `ENOENT` on `package.json` — traced to the setup script running from
`/home/user`, not the cloned repo root, which only becomes the working directory once
Claude's actual session starts. Fixed by moving `npm install` into the Routine's own
Instructions as step 1, instead of the Environment's setup script.

Meanwhile, also built out a proper custom cloud Environment (`claude-apply`) for secrets,
since Rohan didn't want the service-account JSON committed to the repo even privately.
Verified from Anthropic's actual docs that environments support env vars +
setup scripts for exactly this purpose (correcting course after the environment-variables
UI's own warning contradicted an earlier assumption I'd made about how to deliver the
secret) — stored the service account's JSON key directly as
`GOOGLE_SERVICE_ACCOUNT_JSON`, a deliberate, knowing tradeoff given the account is
solo-user and the credential is narrow-scope (Sheets-only, one non-sensitive sheet).

Third real failure: `node src/scan/index.mjs` threw `ProfileInvalidError: unknown field:
digest_sheet_id` — `candidate-profile.schema.mjs` maintains a strict field allowlist that
`digest_sheet_id` was never added to, a real gap in yesterday's/today's earlier work that
local testing never caught (since local testing only ever ran `digest/index.mjs` directly,
never `scan/index.mjs` after the field was added). Fixed by adding `digest_sheet_id`,
`digest_sheet_name`, and `digest_min_score` to the schema's `OPTIONAL_FIELDS`, verified
via the real test suite (`node --test tests/apply/candidate-profile.test.mjs`, 12/12
pass) and a real local `node src/scan/index.mjs` run before pushing.

Fourth real failure: the routine ran clean but Phase 1 hit HTTP 403 on every Lever API
call. Traced to the Environment's Network access being left on the default "Trusted"
level, which — confirmed directly from Claude Code's own docs — only allows package
registries, not arbitrary APIs like `api.lever.co` or `sheets.googleapis.com`. Fixed by
switching to "Custom" network access and explicitly allow-listing `api.lever.co`,
`sheets.googleapis.com`, and `oauth2.googleapis.com`.

**Fifth run: all four steps (`npm install`, scan, score, digest) completed successfully,
exit code 0 on each.** The pipeline mechanism itself is now fully proven, unattended, on
a real schedule. The routine's own summary correctly identified that the "0 new postings"
result was a `portals.yml` data problem (3 of 4 companies 404ing, likely wrong ATS/slug
for at least one), not a pipeline failure — useful, accurate self-diagnosis.

### 8. Rewrote the architecture doc and this recap
Removed all webhook-specific content from `pipeline-architecture.md`, replaced with the
full Google Sheets → Zapier → Gmail mechanism (Section 5 rewritten), added six new
Decision Log entries (#17-22) documenting the one-row-per-day design, dual-path auth, the
network-access gotcha, the setup-script working-directory gotcha, and the schema-allowlist
gotcha — each with what broke, what the actual fix was, and why, matching the doc's
existing standard of citing real evidence over assumption. Added a new Section 8
documenting the Routine and Environment configuration in full (trigger, instructions,
allowed domains, env vars). Added a new "File paths reference" subsection to Section 1,
covering the WSL2-vs-PowerShell path mapping used throughout today's file-transfer steps.
Refreshed Open Items: resolved the webhook/routine items, added new ones surfaced today
(`portals.yml`'s stale slugs, `cv.md` still untested in the cloud, the pasted-into-chat
service-account key's recommended rotation, the plain-text email formatting tradeoff, the
still-incomplete network allowlist for future Ashby/Workday companies).

---

## What's Verified vs. Still Assumed

**Verified today, by direct testing or direct file/API reads:**
- Google Sheets is genuinely a non-premium, Free-plan-compatible Zapier app, and trigger
  polling never consumes Zapier tasks — confirmed from Zapier's own docs, not assumed.
- `digest/index.mjs`'s Sheets write works for real — confirmed via a direct Drive-connector
  read of the actual cell contents after a real (non-dry-run) script run.
- The Zap fires and sends a real Gmail email — confirmed by receiving it, not just by a
  "Zap published" UI message.
- The cloud Routine runs the full Phase 1-3 pipeline unattended, on schedule, with exit
  code 0 on all four steps — confirmed via a real "Run now" execution, not just
  configuration review.
- `npm audit fix` resolved both flagged high-severity vulnerabilities without breaking
  `digest/index.mjs` — confirmed via a clean `npm audit` re-run and a passing
  `--dry-run` afterward.
- The `candidate-profile.schema.mjs` allowlist gates Phase 1 (`scan/index.mjs`), not just
  whichever script directly reads a given field — confirmed via the real
  `ProfileInvalidError` stack trace, which pointed at `scan/index.mjs` even though
  `digest_sheet_id` is a Phase-3-only field.
- Claude Code Routines' daily run cap (5/day on Pro) is account-wide, not per-Routine, and
  manual "Run now" runs don't count against it — confirmed from Anthropic's own routines
  documentation, not assumed.

**Still assumed / not yet tested:**
- Phase 2's true multi-offer batching in production — today's cloud run found 0 postings
  (portals.yml issue), so score had nothing to batch. Still only proven with 1 real offer
  from the 2026-08-22 session, plus isolated unit tests.
- Whether `config/cv.md` (still uncommitted) actually works when read by a cloud Routine
  run — never exercised today, since score had nothing to process.
- The digest email's plain-text Markdown rendering is a known, accepted limitation, not
  yet addressed either way (HTML upgrade vs. leaving as-is).
- Whether the Google service-account key needs rotating given its full contents were
  pasted into this chat's history — not urgent, but not yet done either.
- Everything Lever-specific remains unverified on Greenhouse, Ashby, or Workday — no
  change from prior sessions, not attempted today.

---

## Files Created/Changed Today

- `docs/project-notes/pipeline-architecture.md` — Section 5 (Phase 3) rewritten in full
  for the Sheets-based mechanism; Decisions #13, #17-22 added/rewritten; new Section 8
  (Cloud Routine & Environment Configuration) added; new Section 1a (file paths
  reference) added; Open Items refreshed (2 items resolved, 6 new items added).
- `docs/project-notes/daily-recap-2026-08-23.md` — this file, new.
- `src/digest/index.mjs` — rewritten: Google Sheets API write via `appendDigestRow()`
  instead of a webhook `fetch()` POST; dual-path auth (`GOOGLE_SERVICE_ACCOUNT_JSON` env
  var or `GOOGLE_APPLICATION_CREDENTIALS` file); new `--sheet-id`/`--sheet-name` flags.
- `src/lib/candidate-profile.schema.mjs` — added `digest_sheet_id`, `digest_sheet_name`,
  `digest_min_score` to `OPTIONAL_FIELDS`.
- `config/candidate-profile.yml` — force-committed (`git add -f`) for the first time;
  gained `digest_sheet_id`.
- `config/portals.yml` — force-committed (`git add -f`) for the first time.
- `config/google-service-account.json` — created locally, deliberately never committed
  (`.gitignore`'d, confirmed via `git check-ignore -v`).
- `package.json` / `package-lock.json` — `googleapis` dependency added; later
  `npm audit fix` applied (2 high-severity transitive vulnerabilities resolved, 0
  remaining).
- Google Cloud: new project `claude-apply`, Sheets API enabled, service account
  `digest-writer@claude-apply.iam.gserviceaccount.com` created with a JSON key.
- Google Sheets: new spreadsheet "Daily Application Digest," tab "Digest," headers
  `date | subject | job_count | body`, shared with the service account as Editor.
- Zapier: new Zap "Google Sheets to Gmail Email Notification," published and live —
  Trigger: Google Sheets "New Spreadsheet Row" → Action: Gmail "Send Email."
- Claude Code Routines: new Routine "Job Pipeline — Scan, Score, Digest," scheduled
  daily at 7:00 AM EDT, pointed at `rohanaluri/claude-apply`; new custom cloud
  Environment `claude-apply` (Custom network access: `api.lever.co`,
  `sheets.googleapis.com`, `oauth2.googleapis.com`, plus default package managers;
  env var `GOOGLE_SERVICE_ACCOUNT_JSON`).

---

## Where We Left Off / Next Steps

**The POC's core end-to-end gate, set at the start of this session, is now met:** Phases
1-3 run unattended, on schedule, in the cloud, confirmed by a real execution — not just
designed. What's left splits cleanly into two kinds of work, same framing as before:

1. **Fix `config/portals.yml`'s stale/wrong company slugs.** 3 of 4 tracked companies
   404 against the Lever API; Anthropic is likely on the wrong ATS entirely. This blocks
   Phase 1 from finding any real postings, which in turn blocks a genuine multi-offer
   proof of Phase 2's batching — these are really one piece of work, not two.
2. **Prove `config/cv.md` works in a real cloud run.** Currently uncommitted and never
   exercised by a cloud Routine execution, since today's run had nothing to score. Needs
   either a real posting surviving Phase 1 (from item 1 above) or the 3 live postings
   already found in this session (Meds, Jobgether, Findigs — see item 1 of "What We
   Accomplished") manually seeded into `data/pipeline.md` as a faster path to testing.
3. Lower priority, explicitly deferred again today: location-autocomplete fix,
   cover-letter wiring, second-ATS testing, the digest email's plain-text-vs-HTML
   tradeoff, the leftover redundant `npm install` in the Environment's setup script, and
   rotating the Google service-account key as routine hygiene.

**Nothing was rushed past a real failure today** — every one of the four cloud-Routine
bugs (missing config, wrong setup-script cwd, schema allowlist gap, network access level)
was diagnosed from the routine's own real error output before being fixed, matching the
project's standing rule of reading the actual file/error rather than guessing.
