# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Greenhouse and Ashby offers now carry `apply_url` (previously Lever only), so the Jobs tab's `apply_url` and `capply_command` columns are filled for every platform: Ashby's own `applyUrl`, and Greenhouse's hosted form `job-boards.greenhouse.io/embed/job_app?for=<slug>&token=<id>`, which works even for companies whose `absolute_url` points to their own careers site.
- Removed dead code: the unused CV-embedding ranker (`src/lib/embed-ranker.mjs`, the `models/` directory and the `@xenova/transformers` dependency), the never-wired `maxBoardsPerRun` aggregator option, the `readJobsUrls()` wrapper (use `readJobsTab()`), and the unused `digest_min_score` profile field.
- Aggregator board fetches now time out after 30s (was 10s), actually cancel the request on timeout, and retry once on a timeout, network error or HTTP 429/5xx (`src/scan/aggregators/fetch-board.mjs`). Previously one or two large boards were silently skipped on most runs.
- The digest now applies a freshness window and per-company caps after the Jobs-tab dedupe: jobs first posted more than 14 days ago are skipped, the rest go newest first, at most 3 per company per day and 10 per company per rolling 30 days. Configurable via `digest_limits` in `candidate-profile.yml` (validated by the profile schema); the email notes how many jobs were held back.
- `title_filter.negative` in the bundled `portals.yml` gained terms for cleared/defense, data-center/facilities, above-new-grad, part-time/contract and consulting roles.
- The Greenhouse, Lever and Ashby aggregators now scan a curated top-250 company list per platform, minus companies no longer on that platform (464 boards: 172 Greenhouse, 81 Lever, 211 Ashby), instead of the full ~15,800-board Common Crawl import, which was producing thousands of offers per day. The bundled `src/scan/aggregators/known-*-boards.json` lists are stored in rank order with real company display names.
- **BREAKING**: the onboarding slash command is now `/apply-onboard` (previously `/onboard`), with sub-commands `/apply-onboard:profile`, `/apply-onboard:companies`, `/apply-onboard:setup`. The rename avoids a collision with the `onboard` skill shipped by the `frontend-design` Claude Code plugin, which was shadowing the project command and rendering the documented entry point unusable (issue #35). First-run guards in `/scan`, `/score`, and `/apply` now point at `/apply-onboard`.
- **BREAKING**: `portals.yml` `title_filter` terms now match whole words, case-insensitive (was: case-insensitive substring). `intern` no longer rejects `International`, but also no longer matches `Interns`/`Internship` — add explicit plural variants, or use the new `/regex/flags` escape hatch for full control.

### Added

- Greenhouse, Lever and Ashby offers now carry `posted_at`, the ISO date the job was first published (Greenhouse `first_published`, not `updated_at`), via `normalizePostedAt()` in `src/lib/posted-at.mjs`.
- `discoverCompany(name, options)` in `src/scan/discover-company.mjs` — smart slug discovery that walks platform-specific variations (`x`, `x-ai`, `xhq`, `xlabs`, `x-labs`, …) across Lever → Greenhouse → Ashby → Workday registry and returns the first hit. Resolutions are cached in `data/known-ats-slugs.json`. Closes #38: `/apply-onboard:companies` no longer drops the 17/37 companies (Doctolib, Cohere, Modal, Scale AI, Writer, OpenAI, …) that live under non-obvious slugs.
- `npm run explain -- "<title>" [--company "<co>"]` CLI traces why a title is accepted or filtered by the current `portals.yml` + `candidate-profile.yml`.
- `verifySlug(slug)` primitive on each ATS fetcher (`lever`, `greenhouse`, `ashby`), returning `{ ok, count }` or `{ ok: false, status, reason }`.
- `verifyCompany(careersUrl)` dispatcher and `getSupportedHosts()` helper in `src/scan/ats-detect.mjs`.
- `/onboard` step 7.4 documents the four `claude-in-chrome` host permissions the user must grant after installing the extension, with the host list derived from `getSupportedHosts()` (single source of truth).
- `/apply` step 0 now pre-flights the extension host permission and surfaces a clear remediation block on failure.
- Workday ATS support for `/scan` — new fetcher `src/scan/ats/workday.mjs` with `parseWorkdayUrl`, `fetchWorkday` (paginated), and `verifySlug`. Portals in `config/portals.yml` can now use `platform: workday` with the full career page URL (e.g. `https://totalenergies.wd3.myworkdayjobs.com/TotalEnergies_careers`). Unlocks scanning ~60% of CAC40 and a large share of Fortune 500 hiring. `/apply` support for Workday is not yet implemented.

### Changed (continued)

- `/onboard` step 5.2 now verifies candidate companies via the JSON API endpoint (`verifyCompany`) instead of `curl -sfI` on the public careers page. Fixes a silent-drop bug where Ashby returned `200` on the careers HTML but `404` on the JSON board (e.g. `dust-tt`).

## [0.1.0-alpha.0] — 2026-04-10

### Added

- Initial public alpha release.
- `src/scan` — ATS scanner for Lever, Greenhouse, and Ashby (zero-LLM public APIs).
- `src/score` — Lightweight offer evaluator using a stripped `claude -p` call.
- `src/apply` — Field classifier, language detector, confirmation detector, cover-letter generator, apply log, and a Playwright CDP file-upload helper.
- `src/dashboard` — Self-contained HTML dashboard generator.
- Claude Code slash commands: `/scan`, `/score`, `/apply`.
- `scripts/setup.sh` — Interactive first-time setup (Chrome CDP profile, shell alias, config templates).
- `scripts/check-no-pii.sh` — PII gate with path-regex exclusions.
- HTML fixtures and end-to-end integration tests for 4 ATS platforms.
- Documentation: README, CLAUDE.md, AGENTS.md, architecture, workflow guides, CDP setup, ATS support matrix, extension guide, agent guide, testing guide.
- Community files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.

[Unreleased]: https://github.com/LeoLaborie/claude-apply/compare/v0.1.0-alpha.0...HEAD
[0.1.0-alpha.0]: https://github.com/LeoLaborie/claude-apply/releases/tag/v0.1.0-alpha.0
