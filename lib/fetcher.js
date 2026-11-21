import { sleep, tokenExpiry } from './util.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`Server answered HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super('The video link has expired. Reload the video page and press play.');
    this.name = 'TokenExpiredError';
  }
}

const AUTH_STATUSES = new Set([401, 403, 410]);
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// "Too many requests" (429, and 503 which rate limiters also use): sites often
// count requests per time window, so keep waiting, longer each time (up to
// 5 minutes per wait, about half an hour in all), instead of giving up.
const BUSY_STATUSES = new Set([429, 503]);
const BUSY_RETRIES = 14;
const MAX_BUSY_WAIT_MS = 5 * 60_000;

// Servers (origins) whose files only load together with the site's cookies,
// like players configured to send credentials with every request.
const credentialOrigins = new Set();

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(10 * 60_000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(10 * 60_000, Math.max(0, date - Date.now())) : null;
}

/**
 * Fetches a URL as bytes (Uint8Array) or text, retrying network errors and
 * temporary server errors with exponential backoff (like a video player does).
 * `fetchImpl` lets the request run inside the video page (see page-fetch.js).
 * `meta`, if given, receives the final URL (after redirects) and whether the
 * response came from the browser cache. `cached: true` (for parts the page
 * already loaded) prefers the browser's cached copy over a new request.
 */
export async function fetchResource(url, { signal, range, as = 'bytes', retries = 5, onRetry, fetchImpl = fetch, meta, cached = false } = {}) {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    // Leave empty.
  }
  let withCredentials = credentialOrigins.has(origin);
  let authError = null;

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let error;
    let retryAfterMs = null;
    let busy = false;
    let res;
    try {
      const init = { signal };
      if (range) init.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
      if (withCredentials) init.credentials = 'include';
      if (cached) {
        init.cache = 'force-cache';
        init.expectCached = true;
      }
      res = await fetchImpl(url, init);
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      if (e?.fatal) throw e;
      // The retry with cookies was blocked (the server doesn't accept them): report the original refusal.
      if (authError) throw authError;
      error = e;
    }

    if (res?.ok) {
      try {
        let body;
        if (as === 'text') {
          body = await res.text();
        } else {
          body = new Uint8Array(await res.arrayBuffer());
          // Server ignored the Range header and sent the whole file.
          if (range && res.status === 200 && body.byteLength > range.length) {
            body = body.slice(range.offset, range.offset + range.length);
          }
          // An empty or cut-off answer is never a valid video part: try again rather than save a gap.
          if (!body.byteLength) throw new Error('the site sent an empty answer');
          if (range && body.byteLength < range.length) throw new Error(`the site sent ${body.byteLength} of ${range.length} bytes`);
        }
        if (withCredentials) credentialOrigins.add(origin);
        if (meta) {
          meta.url = res.finalUrl || res.url || url;
          meta.fromCache = res.fromCache === true;
        }
        return body;
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (e?.fatal) throw e;
        error = e;
      }
    } else if (res) {
      res.body?.cancel().catch(() => {});
      error = new HttpError(res.status, url);
      if (AUTH_STATUSES.has(res.status)) {
        const expiry = tokenExpiry(url);
        if (expiry !== null && expiry <= Date.now()) throw new TokenExpiredError();
        if (!withCredentials && !authError) {
          // Try once more with the site's cookies, right away.
          withCredentials = true;
          authError = error;
          attempt--;
          continue;
        }
        if (attempt >= 1) throw authError ?? error;
      } else if (!RETRY_STATUSES.has(res.status)) {
        throw error;
      }
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      busy = BUSY_STATUSES.has(res.status);
    }

    const allowed = busy ? Math.max(retries, BUSY_RETRIES) : retries;
    if (attempt >= allowed) throw error;
    const delay = retryAfterMs ?? Math.min(busy ? MAX_BUSY_WAIT_MS : 30_000, 1000 * 2 ** attempt) + Math.random() * 500;
    onRetry?.({ attempt: attempt + 1, retries: allowed, error, delay, retryAfter: retryAfterMs, url });
    await sleep(delay, signal);
  }
}
