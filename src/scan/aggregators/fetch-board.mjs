// Fetches one aggregator board with a hard timeout, real cancellation, and
// one retry. Shared by aggregators/{greenhouse,lever,ashby}.mjs.
//
// Why (measured 2026-09-29): the boards that timed out weren't hung, they
// were huge — Lever and Ashby always return full descriptions, so e.g.
// Veeva's Lever board is ~12.7 MB. With 18 downloads in flight across the
// three aggregators, those crossed the old 10s limit, and the old timeout
// only stopped *waiting*: the abandoned download kept eating bandwidth.
// Now a timeout aborts the request (fetchers forward `signal` to fetch()),
// and timeouts, network failures and HTTP 429/5xx get a second attempt.
// HTTP 4xx (e.g. 404 = company left this ATS) fails immediately.

export const BOARD_FETCH_TIMEOUT_MS = 30_000;
export const BOARD_FETCH_ATTEMPTS = 2;
export const BOARD_RETRY_DELAY_MS = 1_000;

export class BoardTimeoutError extends Error {
  constructor(slug, ms) {
    super(`timed out after ${ms}ms: ${slug}`);
    this.name = 'BoardTimeoutError';
  }
}

export function isRetryable(err) {
  if (err instanceof BoardTimeoutError) return true;
  const status = String(err?.message || '').match(/HTTP (\d{3})/);
  if (!status) return true; // network failure, not an HTTP response
  const code = Number(status[1]);
  return code === 429 || code >= 500;
}

async function attemptOnce(fetchFn, slug, company, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new BoardTimeoutError(slug, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(slug, company, { includeBody: false, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBoard(
  fetchFn,
  board,
  {
    timeoutMs = BOARD_FETCH_TIMEOUT_MS,
    attempts = BOARD_FETCH_ATTEMPTS,
    retryDelayMs = BOARD_RETRY_DELAY_MS,
    onRetry = null,
  } = {}
) {
  const company = board.company || board.slug;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(fetchFn, board.slug, company, timeoutMs);
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      if (typeof onRetry === 'function') onRetry(board, err);
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}
