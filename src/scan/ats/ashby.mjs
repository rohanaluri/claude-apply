// Fetcher for Ashby-hosted job boards.
// Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false

// `includeBody` (default true, unchanged for every existing caller): Ashby's
// API always sends descriptionPlain regardless of any request param, so
// this can't reduce the network payload — but passing `{ includeBody:
// false }` still drops the text from the returned offer object, so it
// isn't retained across a long-running scan. Added 2026-09-20 for the
// aggregator, same reasoning as fetchGreenhouse's includeBody.
export async function fetchAshby(slug, companyName, { includeBody = true } = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-apply-scan/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Ashby API ${slug}: HTTP ${res.status}`);
  }
  const data = await res.json();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((j) => ({
    url: j.jobUrl || '',
    title: j.title || '',
    company: companyName,
    location: j.location || '',
    body: includeBody ? j.descriptionPlain || '' : '',
    platform: 'ashby',
  }));
}

export async function verifySlug(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-apply-verify/1.0' },
  });
  if (res.ok) {
    const data = await res.json();
    const count = Array.isArray(data?.jobs) ? data.jobs.length : 0;
    return { ok: true, count };
  }
  return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
}
