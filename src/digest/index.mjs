#!/usr/bin/env node
// PHASE 3 — Digest Email. Deterministic, $0 AI.
//
// Reads data/evaluations.jsonl, keeps entries at/above the score threshold,
// formats a markdown digest, and POSTs it to a Zapier webhook (which is
// configured in Zapier as: Webhook trigger -> Send Gmail).
//
// Why a webhook and not Zapier MCP: MCP tools can only be invoked by Claude
// during a conversation turn. This step has no AI in it — the content is fully
// determined by code — so routing it through an MCP call would mean spinning up
// a Claude turn purely to send an already-written email. A plain HTTPS POST is
// cheaper, simpler, and deterministic.
//
// Usage:
//   node src/digest/index.mjs [--min-score 7] [--dry-run] [--webhook <url>]
//
// Webhook URL resolution order:
//   1. --webhook <url>
//   2. $ZAPIER_DIGEST_WEBHOOK_URL
//   3. config/candidate-profile.yml -> digest_webhook_url
//
// --dry-run prints the payload and sends nothing. Use this for all testing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = { minScore: null, dryRun: false, webhook: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-score') flags.minScore = parseFloat(argv[++i]);
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--webhook') flags.webhook = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node src/digest/index.mjs [options]

Builds a markdown digest of qualifying offers and sends it via a Zapier webhook.

Flags:
  --min-score <n>    Score threshold, 0-10 scale (default: profile's
                     digest_min_score, else auto_apply_min_score, else 7)
  --dry-run          Print the payload; send nothing. Use for testing.
  --webhook <url>    Override the webhook URL for this run.
  --help, -h         Show this help.

Reads:  data/evaluations.jsonl, config/candidate-profile.yml
Sends:  POST {subject, body_markdown, job_count, jobs[]} to the Zapier webhook`);
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
/apply ${j.url}
\`\`\`
`;
  });

  return header + '\n' + blocks.join('\n');
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

  // Load profile for threshold + webhook fallback. Missing file is not fatal here.
  let profile = {};
  const profilePath = path.join(CONFIG_DIR, 'candidate-profile.yml');
  if (fs.existsSync(profilePath)) {
    try {
      profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};
    } catch (err) {
      console.error(`[digest] warning: could not parse ${profilePath}: ${err.message}`);
    }
  }

  const minScore =
    flags.minScore ?? profile.digest_min_score ?? profile.auto_apply_min_score ?? 7;

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
  const payload = {
    subject: `Job Digest — ${today} — ${jobs.length} match${jobs.length === 1 ? '' : 'es'}`,
    body_markdown: markdown,
    job_count: jobs.length,
    jobs: jobs.map((j) => ({
      company: j.company,
      role: j.role,
      score: j.score,
      location: j.location ?? null,
      url: j.url,
      reason: j.reason,
    })),
  };

  if (flags.dryRun) {
    console.error('[digest] --dry-run: nothing sent. Payload below.\n');
    console.log(JSON.stringify(payload, null, 2));
    console.error('\n[digest] --- rendered markdown ---\n');
    console.error(markdown);
    return;
  }

  const webhookUrl =
    flags.webhook || process.env.ZAPIER_DIGEST_WEBHOOK_URL || profile.digest_webhook_url;

  if (!webhookUrl) {
    console.error(
      '[digest] No webhook URL. Set one via --webhook, $ZAPIER_DIGEST_WEBHOOK_URL, or\n' +
        '         digest_webhook_url in config/candidate-profile.yml.\n' +
        '         (Use --dry-run to test formatting without sending.)'
    );
    process.exit(2);
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[digest] Webhook POST failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
    process.exit(3);
  }

  console.error(`[digest] Sent ${jobs.length} job${jobs.length === 1 ? '' : 's'} to the webhook (${res.status}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[digest] ERROR:', err.message);
    process.exit(1);
  });
}
