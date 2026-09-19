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
// `status` and `notes` are left blank on every row this module appends —
// they're for the user to fill in by hand. `capply_command` (col J) is a
// formula column (see docs/project-notes/pipeline-architecture.md) and is
// NOT included in the rows this module writes at all — an ARRAYFORMULA
// lives in J1 and spills down the column on its own. Writing so much as an
// empty string into J blocks that spill (Google Sheets throws #REF! —
// "array result was not expanded because it would overwrite data in J_").
// Fixed 2026-09-18 after a real #REF! was hit in production: appendJobsRows
// used to write a 10th blank value into col J and used INSERT_ROWS, which
// inserts new rows above any that follow and shifts formula references
// downward (observed: J1's `E2:E`/`G2:G` becoming `E4:E`/`G4:G` after one
// append). Both are fixed below — writes stop at column I, and OVERWRITE
// is used instead of INSERT_ROWS so existing rows (and the formula's
// references) never shift.

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
      range: `${sheetName}!A:I`,
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

// offer -> an A:I row, in JOBS_TAB_COLUMNS order minus `capply_command`
// (col J, never written — see the header comment). `dateFound` is the scan
// date (YYYY-MM-DD), not "today" at digest-run time, so a Routine that runs
// past midnight still logs the date the job was actually found.
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
  ];
}

// Appends all given offers to the Jobs tab in ONE batch call (never one
// append per job) — see Decision (2026-09-18): the Jobs tab write must
// complete before the Digest row is written, so an email is never sent
// for jobs that didn't actually make it into the sheet.
//
// Range is A:I (not A:J) and insertDataOption is OVERWRITE (not
// INSERT_ROWS) — both fixed 2026-09-18, see the header comment for why.
export async function appendJobsRows({ sheetsClient, sheetId, sheetName, offers, dateFound }) {
  if (!offers || offers.length === 0) return { appended: 0 };

  const values = offers.map((offer) => offerToRow(offer, dateFound));
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'OVERWRITE',
    requestBody: { values },
  });
  return { appended: values.length };
}
