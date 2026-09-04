#!/usr/bin/env node
// PHASE 3 — Digest Email. Deterministic, $0 AI.
//
// Reads data/evaluations.jsonl, keeps entries at/above the score threshold,
// formats a markdown digest, and appends ONE row per run to a Google Sheet
// (which Zapier watches: "New Spreadsheet Row" trigger -> Send Gmail action).
//
// Why Google Sheets and not a Zapier webhook: "Webhooks by Zapier" is a
// Premium app, gated behind Zapier's paid plans. Google Sheets is a standard
// (non-premium) app, so Trigger: Google Sheets -> Action: Gmail fits inside
// Zapier's Free plan's 2-step Zap limit, and Zapier's own docs/pricing page
// confirm polling triggers never consume tasks — only the Gmail send does
// (~1 task/day). This doesn't change Decision #13 (no Zapier MCP): the
// reasoning there — deterministic code can't invoke an MCP tool outside a
// Claude turn — still holds. This only changes *how the data reaches
// Zapier*, not whether AI is involved (it still isn't, anywhere in Phase 3).
//
// Usage:
//   node src/digest/index.mjs [--min-score 7] [--dry-run] [--sheet-id <id>] [--sheet-name <name>]
//
// Sheet ID resolution order:
//   1. --sheet-id <id>
//   2. $GOOGLE_SHEETS_DIGEST_ID
//   3. config/candidate-profile.yml -> digest_sheet_id
//
// Sheet tab name resolution order:
//   1. --sheet-name <name>
//   2. config/candidate-profile.yml -> digest_sheet_name
//   3. 'Digest' (default)
//
// Google credentials: uses a service account (no interactive login, works
// headless from a cloud Routine). Point $GOOGLE_APPLICATION_CREDENTIALS at
// the service account's JSON key file (this is the Google-standard env var
// name — the googleapis library picks it up automatically). The service
// account's email (found inside that JSON key file) must be shared on the
// target Sheet as an Editor, or the append call will fail with a permission
// error.
//
// --dry-run prints the payload and the row that WOULD be appended; writes
// nothing to the Sheet. Use this for all testing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = { minScore: null, dryRun: false, sheetId: null, sheetName: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-score') flags.minScore = parseFloat(argv[++i]);
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--sheet-id') flags.sheetId = argv[++i];
    else if (a === '--sheet-name') flags.sheetName = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node src/digest/index.mjs [options]

Builds a markdown digest of qualifying offers and appends one row to a Google
Sheet. Zapier watches that Sheet (New Spreadsheet Row trigger) and sends the
digest via Gmail.

Flags:
  --min-score <n>     Score threshold, 0-10 scale (default: profile's
                       digest_min_score, else auto_apply_min_score, else 7)
  --dry-run           Print the payload/row; write nothing. Use for testing.
  --sheet-id <id>     Override the target Google Sheet ID for this run.
  --sheet-name <name> Override the target sheet/tab name for this run.
  --help, -h          Show this help.

Reads:  data/evaluations.jsonl, config/candidate-profile.yml
Writes: one row [date, subject, job_count, body] to the configured Google Sheet`);
}

export function readEvaluations(evalPath) {
  if (!fs.existsSync(evalPath)) return [];
  return fs
    .readFileSync(evalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Keeps only offers scored today at/above the threshold, so a daily run doesn't
// re-send jobs that were already in yesterday's digest.
export function selectForDigest(evaluations, minScore, today) {
  return evaluations
    .filter((e) => typeof e.score === 'number' && e.score >= minScore)
    .filter((e) => !today || e.date === today)
    .sort((a, b) => b.score - a.score);
}

// `reason` is stored as a single string, with bullets joined by " | "
// (see normalizeReason in src/score/index.mjs). Split it back out for display.
function reasonBullets(reason) {
  if (!reason) return [];
  return String(reason)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildDigestMarkdown(jobs, today) {
  if (jobs.length === 0) return null;

  const header = `# Job Digest — ${today}\n\n${jobs.length} role${jobs.length === 1 ? '' : 's'} scored at or above your threshold.\n`;

  const blocks = jobs.map((j) => {
    const bullets = reasonBullets(j.reason)
      .map((b) => `- ${b}`)
      .join('\n');
    return `---

### ${j.company} — ${j.role}
**Match score:** ${j.score}/10${j.location ? `  ·  **Location:** ${j.location}` : ''}

${bullets || '- (no reason returned)'}

Apply:
\`\`\`
capply "${j.url}"
\`\`\`
`;
  });

  return header + '\n' + blocks.join('\n');
}

// Escapes a string for safe interpolation into HTML text content.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// HTML version of the digest — this is what actually gets sent as the email
// body (added 2026-09-03). Mirrors the styling of the separate daily-news
// Routine (dark title bar, light card, real <h2>/<ul>/<li>) so it renders
// properly instead of showing raw Markdown characters. Requires the Gmail
// Zap action's Body type to be set to HTML, not Plain — see Open Items.
export function buildDigestHtml(jobs, today) {
  if (jobs.length === 0) return null;

  const jobBlocks = jobs
    .map((j) => {
      const bullets = reasonBullets(j.reason)
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join('\n        ');
      const locationLine = j.location
        ? ` &middot; <strong>Location:</strong> ${escapeHtml(j.location)}`
        : '';
      return `
      <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #e0e0e0;">
        <h2 style="margin: 0 0 4px; font-size: 18px; color: #1a1a1a;">${escapeHtml(j.company)} &mdash; ${escapeHtml(j.role)}</h2>
        <div style="font-size: 14px; color: #555; margin-bottom: 10px;">
          <strong>Match score:</strong> ${escapeHtml(String(j.score))}/10${locationLine}
        </div>
        <ul style="margin: 0 0 10px; padding-left: 20px;">
        ${bullets || '<li>(no reason returned)</li>'}
        </ul>
        <div style="font-family: monospace; background: #f4f4f4; padding: 8px 12px; border-radius: 4px; font-size: 13px; color: #333;">
          capply "${escapeHtml(j.url)}"
        </div>
      </div>`;
    })
    .join('\n');

  return `
<div style="max-width: 600px; margin: auto; font-family: sans-serif; font-size: 16px; color: #333; background: #ffffff; padding: 24px;">
  <div style="background: #1a1a1a; color: #ffffff; padding: 12px 20px; font-size: 18px; font-weight: bold; border-radius: 6px; margin-bottom: 20px;">
    Job Digest &mdash; ${escapeHtml(today)}
  </div>
  <p style="margin: 0 0 20px; font-size: 15px; color: #555;">
    ${jobs.length} role${jobs.length === 1 ? '' : 's'} scored at or above your threshold today.
  </p>
  ${jobBlocks}
</div>`;
}

// Appends one row to the configured Google Sheet. `sheetsClient` is injected
// so this stays unit-testable with a fake client (no real Google API needed).
// Row shape: [date, subject, job_count, body] — matches columns A:D.
export async function appendDigestRow({ sheetsClient, sheetId, sheetName, row }) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const CONFIG_DIR =
    process.env.CLAUDE_APPLY_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
  const DATA_DIR = process.env.CLAUDE_APPLY_DATA_DIR || path.join(__dirname, '..', '..', 'data');

  // Load profile for threshold + sheet fallback. Missing file is not fatal here.
  let profile = {};
  const profilePath = path.join(CONFIG_DIR, 'candidate-profile.yml');
  if (fs.existsSync(profilePath)) {
    try {
      profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};
    } catch (err) {
      console.error(`[digest] warning: could not parse ${profilePath}: ${err.message}`);
    }
  }

  const minScore = flags.minScore ?? profile.digest_min_score ?? profile.auto_apply_min_score ?? 7;

  const today = new Date().toISOString().slice(0, 10);
  const evalPath = path.join(DATA_DIR, 'evaluations.jsonl');
  const evaluations = readEvaluations(evalPath);

  if (evaluations.length === 0) {
    console.error(`[digest] No evaluations found at ${evalPath}. Nothing to send.`);
    return;
  }

  const jobs = selectForDigest(evaluations, minScore, today);
  console.error(
    `[digest] ${evaluations.length} total evaluations, ${jobs.length} scored >= ${minScore} today (${today}).`
  );

  if (jobs.length === 0) {
    console.error('[digest] Nothing qualifies today — no email sent.');
    return;
  }

  const markdown = buildDigestMarkdown(jobs, today);
  const html = buildDigestHtml(jobs, today);
  const subject = `Job Digest — ${today} — ${jobs.length} match${jobs.length === 1 ? '' : 'es'}`;
  // Sheet's `body` column now holds real HTML, not Markdown (2026-09-03).
  // The Gmail Zap action's Body type must be set to HTML, not Plain, for
  // this to render correctly — see Open Items if that hasn't been done yet.
  const row = [today, subject, jobs.length, html];

  if (flags.dryRun) {
    console.error('[digest] --dry-run: nothing written. Row that would be appended:\n');
    console.log(
      JSON.stringify({ date: today, subject, job_count: jobs.length, body: html }, null, 2)
    );
    console.error('\n[digest] --- rendered markdown (readable preview) ---\n');
    console.error(markdown);
    console.error('\n[digest] --- rendered HTML (what actually gets sent) ---\n');
    console.error(html);
    return;
  }

  const sheetId = flags.sheetId || process.env.GOOGLE_SHEETS_DIGEST_ID || profile.digest_sheet_id;
  const sheetName = flags.sheetName || profile.digest_sheet_name || 'Digest';

  if (!sheetId) {
    console.error(
      '[digest] No Google Sheet ID. Set one via --sheet-id, $GOOGLE_SHEETS_DIGEST_ID, or\n' +
        '         digest_sheet_id in config/candidate-profile.yml.\n' +
        '         (Use --dry-run to test formatting without writing.)'
    );
    process.exit(2);
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

  try {
    await appendDigestRow({ sheetsClient, sheetId, sheetName, row });
  } catch (err) {
    console.error(`[digest] Sheets append failed: ${err.message}`);
    process.exit(3);
  }

  console.error(
    `[digest] Appended ${jobs.length} job${jobs.length === 1 ? '' : 's'} as one row to "${sheetName}" (sheet ${sheetId}).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[digest] ERROR:', err.message);
    process.exit(1);
  });
}
