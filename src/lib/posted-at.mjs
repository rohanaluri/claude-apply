// Normalizes an ATS "first posted" timestamp to an ISO-8601 UTC string, or
// '' when missing/unparseable. Accepts epoch milliseconds (Lever's
// createdAt) or any Date-parseable string (Greenhouse's first_published,
// Ashby's publishedAt).
export function normalizePostedAt(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
