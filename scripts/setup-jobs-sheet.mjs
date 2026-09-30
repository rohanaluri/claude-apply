#!/usr/bin/env node
// One-time (re-runnable) formatting for the Jobs tab's `status` column:
//   - a dropdown: apply / applied / needs attention / skip
//   - colors: apply = yellow (queued for `capply --queue`),
//             applied = green, needs attention = red
// Safe to re-run: the dropdown is simply re-set, and a color rule is only
// added if an identical one isn't already there. Touches formatting only —
// no cell values.
//
// Usage: node scripts/setup-jobs-sheet.mjs [--dry-run]
// Reads digest_sheet_id / jobs_sheet_name from config/candidate-profile.yml;
// credentials as in src/lib/google-sheets-client.mjs.

import fs from 'node:fs';
import yaml from 'js-yaml';
import { buildSheetsClient } from '../src/lib/google-sheets-client.mjs';
import { JOBS_TAB_COLUMNS, JOB_STATUS } from '../src/lib/google-sheets-jobs.mjs';

const STATUS_COLUMN = JOBS_TAB_COLUMNS.indexOf('status');

export const STATUS_COLORS = [
  { text: JOB_STATUS.queued, color: { red: 0.99, green: 0.91, blue: 0.7 } },
  { text: JOB_STATUS.done, color: { red: 0.72, green: 0.88, blue: 0.8 } },
  { text: JOB_STATUS.attention, color: { red: 0.96, green: 0.78, blue: 0.76 } },
];

// Row 2 downward (row 1 is the header), status column only.
function statusRange(sheetId) {
  return {
    sheetId,
    startRowIndex: 1,
    startColumnIndex: STATUS_COLUMN,
    endColumnIndex: STATUS_COLUMN + 1,
  };
}

function isSameTextRule(rule, text) {
  const cond = rule?.booleanRule?.condition;
  const ranges = rule?.ranges || [];
  return (
    cond?.type === 'TEXT_EQ' &&
    cond.values?.[0]?.userEnteredValue === text &&
    ranges.some(
      (r) =>
        r.startColumnIndex === STATUS_COLUMN &&
        r.endColumnIndex === STATUS_COLUMN + 1 &&
        (r.startRowIndex ?? 0) === 1
    )
  );
}

export function buildJobsSheetSetupRequests({ sheetId, existingRules = [] }) {
  const requests = [
    {
      setDataValidation: {
        range: statusRange(sheetId),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [JOB_STATUS.queued, JOB_STATUS.done, JOB_STATUS.attention, JOB_STATUS.skip].map(
              (v) => ({ userEnteredValue: v })
            ),
          },
          showCustomUi: true,
          // Not strict: anything typed by hand is kept (just flagged).
          strict: false,
        },
      },
    },
  ];
  for (const { text, color } of STATUS_COLORS) {
    if (existingRules.some((rule) => isSameTextRule(rule, text))) continue;
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [statusRange(sheetId)],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
            format: { backgroundColor: color },
          },
        },
      },
    });
  }
  return requests;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const profile = yaml.load(fs.readFileSync('config/candidate-profile.yml', 'utf8')) || {};
  const spreadsheetId = process.env.GOOGLE_SHEETS_DIGEST_ID || profile.digest_sheet_id;
  const tabName = profile.jobs_sheet_name || 'Jobs';
  if (!spreadsheetId) {
    console.error('✖ No Google Sheet ID: set digest_sheet_id in config/candidate-profile.yml.');
    process.exit(2);
  }

  const sheets = await buildSheetsClient({ keyFile: 'config/google-service-account.json' });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title),conditionalFormats)',
  });
  const tab = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!tab) {
    console.error(`✖ No "${tabName}" tab in the spreadsheet.`);
    process.exit(1);
  }

  const requests = buildJobsSheetSetupRequests({
    sheetId: tab.properties.sheetId,
    existingRules: tab.conditionalFormats || [],
  });
  const colorRules = requests.length - 1;
  console.error(
    `"${tabName}" tab: set the status dropdown` +
      (colorRules ? `, add ${colorRules} color rule(s)` : ', color rules already present')
  );
  if (dryRun) {
    console.log(JSON.stringify(requests, null, 2));
    console.error('(dry run — nothing changed)');
    return;
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.error('✓ done');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
}
