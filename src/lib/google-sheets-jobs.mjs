// Reader/writer for the "Jobs" tab of the Daily Application Digest Google
// Sheet — the ONE piece of state that survives between cloud Routine runs.
// Everything under data/ (scan-history.tsv, pipeline.md, evaluations.jsonl)
// lives inside the Routine's container and is gone by the next day's fresh
// checkout, so cross-day dedupe can't rely on it. The Jobs tab's `url`
// column is the durable record instead.
//
// Column order (A:J) — confirmed with the user 2026-09-18, do not reorder
// without also updating the one-time sheet setup (header row + the
// `capply_command` formula column):
//   date_found | company | title | location | url | platform | apply_url |
//   status | notes | capply_command
//
// `status`, `notes` and `capply_command` are left blank on every row this
// module appends. `status`/`notes` are for the user to fill in by hand;
// `capply_command` is a formula column (see docs/project-notes/
// pipeline-architecture.md) — writing a value into it would overwrite the
// formula, so appended rows leave it empty and rely on the formula being
// set up to auto-fill down the column (e.g. an ARRAYFORMULA in the header
// row), which the user sets up once, manually.

export const JOBS_TAB_COLUMNS = [
  'date_found',
  'company',
  'title',
  'location',
  'url',
  'platform',
  'apply_url',
  'status',
  'notes',
  'capply_command',
];

const URL_COLUMN_INDEX = JOBS_TAB_COLUMNS.indexOf('url'); // 4 (0-based)

export class JobsTabReadError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'JobsTabReadError';
    if (cause) this.cause = cause;
  }
}

// Reads every existing `url` value from the Jobs tab, so the caller can
// treat "already in the sheet" as "already sent, don't re-send". Throws
// JobsTabReadError on ANY failure (auth, network, missing tab, bad range) —
// callers MUST treat that as fatal for the run rather than falling back to
// an empty set, otherwise a transient Sheets hiccup would silently
// re-send every job that was ever found. See Decision (2026-09-18) in
// pipeline-architecture.md.
export async function readJobsUrls({ sheetsClient, sheetId, sheetName }) {
  let res;
  try {
    res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:J`,
    });
  } catch (err) {
    throw new JobsTabReadError(`Could not read the "${sheetName}" tab: ${err.message}`, {
      cause: err,
    });
  }

  const rows = res?.data?.values || [];
  const seen = new Set();
  // Skip row 1 (header) unconditionally — even if the sheet is somehow
  // headerless, treating row 1 as data would only ever cost one false
  // "already seen" URL, never a false negative.
  for (const row of rows.slice(1)) {
    const url = row?.[URL_COLUMN_INDEX];
    if (typeof url === 'string' && url.trim()) {
      seen.add(url.trim());
    }
  }
  return seen;
}

// offer -> a full A:J row, in JOBS_TAB_COLUMNS order. `dateFound` is the
// scan date (YYYY-MM-DD), not "today" at digest-run time, so a Routine that
// runs past midnight still logs the date the job was actually found.
function offerToRow(offer, dateFound) {
  return [
    dateFound,
    offer.company || '',
    offer.title || '',
    offer.location || '',
    offer.url || '',
    offer.platform || '',
    offer.apply_url || '',
    '', // status — user-filled
    '', // notes — user-filled
    '', // capply_command — formula column, left blank
  ];
}

// Appends all given offers to the Jobs tab in ONE batch call (never one
// append per job) — see Decision (2026-09-18): the Jobs tab write must
// complete before the Digest row is written, so an email is never sent
// for jobs that didn't actually make it into the sheet.
export async function appendJobsRows({ sheetsClient, sheetId, sheetName, offers, dateFound }) {
  if (!offers || offers.length === 0) return { appended: 0 };

  const values = offers.map((offer) => offerToRow(offer, dateFound));
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { appended: values.length };
}
