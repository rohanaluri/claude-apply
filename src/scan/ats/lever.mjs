// Fetcher for Lever-hosted job boards.
// Endpoint: GET https://api.lever.co/v0/postings/{slug}?mode=json
// Returns Offer[] conforming to the Offer contract.
//
// `url` stays Lever's `hostedUrl` (the posting overview page) — it's the
// dedupe key used everywhere else (scan-history.tsv, seenUrls, the Jobs
// tab's `url` column), so it must never change shape. Lever's API also
// returns `applyUrl`, the direct link to the application FORM (same page
// as hostedUrl + "/apply"). We surface that separately as `apply_url` for
// anything that needs the form directly (the Jobs tab, capply). Falls back
// to '' if Lever ever omits it, rather than guessing at hostedUrl + '/apply'
// here — src/apply/index.mjs has its own safety net for that.
export async function fetchLever(slug, companyName) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-apply-scan/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Lever API ${slug}: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Lever API ${slug}: expected array, got ${typeof data}`);
  }
  return data.map((p) => ({
    url: p.hostedUrl || '',
    apply_url: p.applyUrl || '',
    title: p.text || '',
    company: companyName,
    location: p.categories?.location || '',
    body: p.descriptionPlain || '',
    platform: 'lever',
  }));
}

export async function verifySlug(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-apply-verify/1.0' },
  });
  if (res.ok) {
    const data = await res.json();
    return { ok: true, count: Array.isArray(data) ? data.length : 0 };
  }
  return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
}
