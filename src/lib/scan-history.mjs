// Scan history reader/writer and applications.md URL extractor.
// scan-history.tsv format:
//   url\tfirst_seen\tportal\ttitle\tcompany\tstatus

import fs from 'node:fs';
import path from 'node:path';

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus';
const URL_RE = /https?:\/\/[^\s|)<>]+/g;

// TEMPORARY (2026-09-05): role-level dedup, added alongside the existing
// URL-only dedup. Some companies post the same role once per location as
// separate Lever postings — same title, same company, different hostedUrl —
// which the URL-only check treats as distinct and lets through as
// "new" every time. This collapses those to one by comparing
// company + title with trailing location-like text stripped, e.g.
// "Software Engineer (Remote - EU)" -> "software engineer".
// Only applied to 'added' rows — errors/skips aren't real roles.
const TRAILING_LOCATION_RE =
  /\s*[-–—(]\s*(remote|hybrid|onsite|on-site|[a-z][a-z .]*(?:,\s*[a-z][a-z .]*)?)\s*\)?\s*$/i;

export function stripLocationSuffix(title) {
  let t = String(title ?? '').trim();
  // Repeat once in case of a trailing " - City (Remote - EU)" style double
  // suffix; a single extra pass covers the realistic cases without looping
  // indefinitely on odd titles.
  for (let i = 0; i < 2; i++) {
    const next = t.replace(TRAILING_LOCATION_RE, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

export function normalizeRoleKey(company, title) {
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  return `${norm(company)}|${norm(stripLocationSuffix(title))}`;
}

function sanitize(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
}

export function loadSeenUrls(historyPath, applicationsPath) {
  const seen = new Set();

  if (fs.existsSync(historyPath)) {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines.slice(1)) {
      // skip header
      if (!line.trim()) continue;
      const url = line.split('\t')[0];
      if (url) seen.add(url.trim());
    }
  }

  if (applicationsPath && fs.existsSync(applicationsPath)) {
    const raw = fs.readFileSync(applicationsPath, 'utf8');
    const matches = raw.match(URL_RE) || [];
    for (const u of matches) seen.add(u);
  }

  return seen;
}

// Builds the role-level dedup set from scan-history.tsv's existing
// company/title columns. Only 'added' rows count as a real prior
// application-worthy role — skipped/error rows never represented an actual
// offer we acted on.
export function loadSeenRoles(historyPath) {
  const seen = new Set();
  if (!fs.existsSync(historyPath)) return seen;

  const raw = fs.readFileSync(historyPath, 'utf8');
  const lines = raw.split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const [, , , title, company, status] = cols;
    if (status !== 'added') continue;
    seen.add(normalizeRoleKey(company, title));
  }
  return seen;
}

export function appendHistoryRow(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const exists = fs.existsSync(filePath);
  const cols = [row.url, row.first_seen, row.portal, row.title, row.company, row.status]
    .map(sanitize)
    .join('\t');
  const chunk = exists ? `${cols}\n` : `${HEADER}\n${cols}\n`;
  fs.appendFileSync(filePath, chunk, 'utf8');
}
