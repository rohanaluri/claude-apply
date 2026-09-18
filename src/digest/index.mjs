#!/usr/bin/env node
// PHASE 3 — Digest Email. Deterministic, $0 AI.
//
// Rewritten 2026-09-18 to drop Phase 2 (LLM scoring) from the daily path.
// `scan` now hands every filtered survivor straight to `digest` via
// data/todays-offers.json (see src/lib/todays-offers.mjs) instead of
// `digest` reading data/evaluations.jsonl for entries scored today.
//
// Cross-day dedupe used to rely on scan-history.tsv, which doesn't survive
// between cloud Routine runs (fresh checkout each day). The Jobs tab of the
// Google Sheet is now that durable record: `digest` reads its `url` column
// first, drops anything already there, appends the rest in one batch call,
// THEN writes a summary row to the Digest tab (which Zapier watches:
// "New Spreadsheet Row" trigger -> Send Gmail action). If the Jobs tab read
// fails for any reason, the run stops WITHOUT sending an email — continuing
// with an empty "seen" set would re-send every job ever found. See
// src/lib/google-sheets-jobs.mjs.
//
// A digest row is written every run, even with 0 new jobs — a missing
// email should mean something broke, not "nothing new today".
//
// Usage:
//   node src/digest/index.mjs [--dry-run] [--sheet-id <id>] [--sheet-name <name>] [--jobs-sheet-name <name>]
//
// Sheet ID resolution order (same ID is used for both tabs):
//   1. --sheet-id <id>
//   2. $GOOGLE_SHEETS_DIGEST_ID
//   3. config/candidate-profile.yml -> digest_sheet_id
//
// Digest tab name resolution: --sheet-name -> digest_sheet_name -> 'Digest'
// Jobs tab name resolution:   --jobs-sheet-name -> jobs_sheet_name -> 'Jobs'
//
// Google credentials: uses a service account (no interactive login, works
// headless from a cloud Routine). Point $GOOGLE_APPLICATION_CREDENTIALS at
// the service account's JSON key file (this is the Google-standard env var
// name — the googleapis library picks it up automatically), or set
// $GOOGLE_SERVICE_ACCOUNT_JSON to the key's raw JSON content (cloud
// Routine). The service account's email (inside that JSON key) must be
// shared on the target Sheet as an Editor.
//
// --dry-run prints what WOULD be written to both tabs; writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { google } from 'googleapis';
import { readTodaysOffers } from '../lib/todays-offers.mjs';
import { readJobsUrls, appendJobsRows, JobsTabReadError } from '../lib/google-sheets-jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = { dryRun: false, sheetId: null, sheetName: null, jobsSheetName: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--sheet-id') flags.sheetId = argv[++i];
    else if (a === '--sheet-name') flags.sheetName = argv[++i];
    else if (a === '--jobs-sheet-name') flags.jobsSheetName = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node src/digest/index.mjs [options]

Reads today's scan output (data/todays-offers.json), drops anything already
in the Jobs tab, appends the rest there, and sends a summary email via a row
in the Digest tab (Zapier watches that tab: New Spreadsheet Row -> Gmail).

Flags:
  --dry-run             Print what would be written; write nothing.
  --sheet-id <id>       Override the target Google Sheet ID for this run.
  --sheet-name <name>   Override the Digest tab name (default 'Digest').
  --jobs-sheet-name <n> Override the Jobs tab name (default 'Jobs').
  --help, -h            Show this help.

Reads:  data/todays-offers.json, config/candidate-profile.yml
Writes: new rows to the Jobs tab, then one row to the Digest tab.`);
}

// Escapes a string for safe interpolation into HTML text content.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Groups offers by platform, sorted by count descending then name — used
// for the "platform breakdown" line in the email.
export function platformBreakdown(offers) {
  const counts = new Map();
  for (const o of offers) {
    const key = o.platform || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([platform, count]) => ({ platform, count }));
}

// Top N companies by number of new offers today, ties broken alphabetically.
export function topCompanies(offers, limit = 5) {
  const counts = new Map();
  for (const o of offers) {
    const key = o.company || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([company, count]) => ({ company, count }));
}

export function buildJobsTabUrl(sheetId, jobsSheetGid) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  return jobsSheetGid != null ? `${base}#gid=${jobsSheetGid}` : base;
}

// Summary-only HTML — no per-job cards (those live in the Jobs tab now).
// Mirrors the styling of the earlier score-based digest (dark title bar,
// light card) so it still renders cleanly; Gmail Zap action's Body type
// must stay set to HTML, not Plain.
export function buildDigestHtml({ today, newJobs, jobsTabUrl }) {
  const count = newJobs.length;
  const breakdown = platformBreakdown(newJobs);
  const companies = topCompanies(newJobs);

  const breakdownHtml =
    breakdown.length > 0
      ? `<ul style="margin: 0 0 16px; padding-left: 20px;">
        ${breakdown.map((b) => `<li>${escapeHtml(b.platform)}: ${b.count}</li>`).join('\n        ')}
        </ul>`
      : `<p style="margin: 0 0 16px; color: #555;">No new roles today.</p>`;

  const companiesHtml =
    companies.length > 0
      ? `<h2 style="margin: 20px 0 4px; font-size: 16px; color: #1a1a1a;">Top companies</h2>
      <ul style="margin: 0 0 16px; padding-left: 20px;">
        ${companies.map((c) => `<li>${escapeHtml(c.company)} (${c.count})</li>`).join('\n        ')}
      </ul>`
      : '';

  return `
<div style="max-width: 600px; margin: auto; font-family: sans-serif; font-size: 16px; color: #333; background: #ffffff; padding: 24px;">
  <div style="background: #1a1a1a; color: #ffffff; padding: 12px 20px; font-size: 18px; font-weight: bold; border-radius: 6px; margin-bottom: 20px;">
    Job Digest &mdash; ${escapeHtml(today)}
  </div>
  <p style="margin: 0 0 16px; font-size: 15px; color: #555;">
    ${count} new role${count === 1 ? '' : 's'} found today.
  </p>
  <h2 style="margin: 0 0 4px; font-size: 16px; color: #1a1a1a;">By platform</h2>
  ${breakdownHtml}
  ${companiesHtml}
  <a href="${jobsTabUrl}" style="display: inline-block; margin-top: 8px; padding: 10px 16px; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 14px;">
    Open the Jobs tab
  </a>
</div>`;
}

// Two ways to authenticate, so the same script works both locally (WSL2,
// via a key FILE) and in the cloud Routine (via the key CONTENT in an env
// var — no file-writing setup script needed, nothing touches disk):
//   1. $GOOGLE_SERVICE_ACCOUNT_JSON — raw JSON key content (cloud Routine)
//   2. $GOOGLE_APPLICATION_CREDENTIALS — path to a key file (local WSL2,
//      Google's own standard convention, picked up automatically)
async function buildSheetsClient() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({ credentials, scopes });
  } else {
    auth = new google.auth.GoogleAuth({ scopes });
  }
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Appends one row to the Digest tab. `sheetsClient` is injected so this
// stays unit-testable with a fake client (no real Google API needed).
// Row shape: [date, subject, job_count, body] — matches columns A:D,
// unchanged from before so the existing Zap keeps working as-is.
export async function appendDigestRow({ sheetsClient, sheetId, sheetName, row }) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const CONFIG_DIR =
    process.env.CLAUDE_APPLY_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
  const DATA_DIR = process.env.CLAUDE_APPLY_DATA_DIR || path.join(__dirname, '..', '..', 'data');

  // Load profile for sheet ID/name fallbacks. Missing file is not fatal here.
  let profile = {};
  const profilePath = path.join(CONFIG_DIR, 'candidate-profile.yml');
  if (fs.existsSync(profilePath)) {
    try {
      profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};
    } catch (err) {
      console.error(`[digest] warning: could not parse ${profilePath}: ${err.message}`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const todaysOffersPath = path.join(DATA_DIR, 'todays-offers.json');
  const { offers: candidateOffers } = readTodaysOffers(todaysOffersPath);
  console.error(
    `[digest] ${candidateOffers.length} offer(s) from today's scan (${todaysOffersPath}).`
  );

  const sheetId = flags.sheetId || process.env.GOOGLE_SHEETS_DIGEST_ID || profile.digest_sheet_id;
  const digestSheetName = flags.sheetName || profile.digest_sheet_name || 'Digest';
  const jobsSheetName = flags.jobsSheetName || profile.jobs_sheet_name || 'Jobs';

  if (!sheetId) {
    console.error(
      '[digest] No Google Sheet ID. Set one via --sheet-id, $GOOGLE_SHEETS_DIGEST_ID, or\n' +
        '         digest_sheet_id in config/candidate-profile.yml.\n' +
        '         (Use --dry-run to test formatting without writing.)'
    );
    process.exit(2);
  }

  const jobsTabUrl = buildJobsTabUrl(sheetId, profile.jobs_sheet_gid);

  if (flags.dryRun) {
    console.error(
      '[digest] --dry-run: reading the Jobs tab is skipped; assuming all offers are new.'
    );
    const html = buildDigestHtml({ today, newJobs: candidateOffers, jobsTabUrl });
    const subject = `Job Digest — ${today} — ${candidateOffers.length} new role${candidateOffers.length === 1 ? '' : 's'}`;
    console.error(
      `[digest] --- Jobs tab rows that WOULD be appended (${candidateOffers.length}) ---`
    );
    console.log(JSON.stringify(candidateOffers, null, 2));
    console.error('\n[digest] --- Digest row that WOULD be appended ---\n');
    console.log(
      JSON.stringify(
        { date: today, subject, job_count: candidateOffers.length, body: html },
        null,
        2
      )
    );
    return;
  }

  let sheetsClient;
  try {
    sheetsClient = await buildSheetsClient();
  } catch (err) {
    console.error(
      `[digest] Could not authenticate with Google Sheets: ${err.message}\n` +
        '         Check $GOOGLE_APPLICATION_CREDENTIALS points to a valid service\n' +
        '         account key file, and that the account has Editor access on the sheet.'
    );
    process.exit(3);
  }

  // Fail closed: if we can't confirm what's already in the Jobs tab, we
  // must not guess (an empty seen-set would re-send every job ever found).
  let seenUrls;
  try {
    seenUrls = await readJobsUrls({ sheetsClient, sheetId, sheetName: jobsSheetName });
  } catch (err) {
    if (err instanceof JobsTabReadError) {
      console.error(`[digest] ${err.message}`);
      console.error(
        '[digest] Stopping without sending an email — cross-day dedupe cannot be trusted right now.'
      );
      process.exit(3);
    }
    throw err;
  }

  const newJobs = candidateOffers.filter((o) => o.url && !seenUrls.has(o.url));
  console.error(
    `[digest] ${candidateOffers.length} candidate(s), ${newJobs.length} not already in the "${jobsSheetName}" tab.`
  );

  try {
    const { appended } = await appendJobsRows({
      sheetsClient,
      sheetId,
      sheetName: jobsSheetName,
      offers: newJobs,
      dateFound: today,
    });
    if (appended > 0) {
      console.error(`[digest] Appended ${appended} row(s) to "${jobsSheetName}".`);
    }
  } catch (err) {
    console.error(`[digest] Jobs tab append failed: ${err.message}`);
    console.error('[digest] Stopping without sending an email — jobs may not have been recorded.');
    process.exit(3);
  }

  const html = buildDigestHtml({ today, newJobs, jobsTabUrl });
  const subject = `Job Digest — ${today} — ${newJobs.length} new role${newJobs.length === 1 ? '' : 's'}`;
  const row = [today, subject, newJobs.length, html];

  try {
    await appendDigestRow({ sheetsClient, sheetId, sheetName: digestSheetName, row });
  } catch (err) {
    console.error(`[digest] Digest tab append failed: ${err.message}`);
    process.exit(3);
  }

  console.error(
    `[digest] Sent: ${newJobs.length} new job${newJobs.length === 1 ? '' : 's'} (row appended to "${digestSheetName}", sheet ${sheetId}).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[digest] ERROR:', err.message);
    process.exit(1);
  });
}
