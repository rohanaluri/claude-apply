// Fetcher for Greenhouse-hosted job boards.
// Endpoint: GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
// Returns Offer[] conforming to the Offer contract.

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  // Decode HTML entities first so we can strip the resulting tags
  let out = html.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] || m);
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // Then strip real HTML tags
  out = out.replace(/<[^>]+>/g, '');
  return out;
}

// `includeBody` (default true, unchanged for every existing caller):
// pass `{ includeBody: false }` to skip `?content=true` entirely — no full
// HTML job description is downloaded or stripped, `body` comes back ''.
// Added 2026-09-20 for the aggregators: at thousands of boards, downloading
// and HTML-stripping every posting's full description before any keyword
// filter has run is what caused an out-of-memory crash, and the description
// text isn't used again until Phase 2 re-fetches it independently anyway
// (fetchOfferBody) — so fetching it here was pure waste for that path.
export async function fetchGreenhouse(slug, companyName, { includeBody = true } = {}) {
  const url = includeBody
    ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
    : `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-apply-scan/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Greenhouse API ${slug}: HTTP ${res.status}`);
  }
  const data = await res.json();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((j) => ({
    url: j.absolute_url || '',
    title: j.title || '',
    company: companyName,
    location: j.location?.name || '',
    body: includeBody ? stripHtml(j.content || '') : '',
    platform: 'greenhouse',
  }));
}

export async function verifySlug(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
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
