// Extension side of content/page-fetch.js: a fetch() that runs inside the
// video's frame, so requests look exactly like the player's own.

export class PageClosedError extends Error {
  constructor() {
    super('The video page was closed, reloaded or left.');
    this.name = 'PageClosedError';
    this.fatal = true; // don't retry: the connection is gone
  }
}

function fromBase64(str) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(str);
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

// The answer from the page, shaped like the parts of Response that the
// fetcher uses. The body is decoded once, when read, and handed over without
// further copies (video segments are large and come in quickly).
class PageResponse {
  constructor(msg) {
    this.status = msg.status;
    this.ok = msg.status >= 200 && msg.status < 300;
    this.url = msg.url;
    this.finalUrl = msg.url; // after redirects
    this.fromCache = msg.fromCache === true;
    this.headers = new Headers(msg.headers || {});
    this.body = null; // already complete: nothing to cancel
    this.encoded = NULL_BODY_STATUS.has(msg.status) ? '' : msg.body || '';
    this.timing = msg.timing || null; // { firstByte, total, protocol } measured in the page
    const pad = this.encoded.endsWith('==') ? 2 : this.encoded.endsWith('=') ? 1 : 0;
    this.size = Math.max(0, Math.floor((this.encoded.length * 3) / 4) - pad); // body bytes
  }

  bytes() {
    const bytes = fromBase64(this.encoded);
    this.encoded = '';
    return bytes;
  }

  async arrayBuffer() {
    const bytes = this.bytes();
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  }

  async text() {
    return new TextDecoder().decode(this.bytes());
  }
}

/**
 * Wraps a fetch so playlists the player already loaded (captured by
 * content/hook.js) are answered from that copy instead of being requested
 * again. Exact URL match only; everything else goes to `fetchImpl`.
 */
export function withCapturedPlaylists(fetchImpl, streams = []) {
  const texts = new Map();
  for (const s of [...streams].sort((a, b) => a.time - b.time)) {
    if (typeof s.text === 'string') texts.set(s.url, s.text);
  }
  const wrapped = (url, init) => {
    const text = texts.get(url);
    if (text !== undefined && !init?.headers?.Range) {
      const response = new Response(text, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      response.finalUrl = url;
      response.fromCache = true;
      return Promise.resolve(response);
    }
    return fetchImpl(url, init);
  };
  wrapped.capturedCount = texts.size;
  return wrapped;
}

export async function connectToFrame(tabId, frameId = 0) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content/page-fetch.js'],
    });
  } catch (e) {
    throw new Error(
      /no tab|no frame|closed/i.test(e.message)
        ? "The video page isn't open any more. Open it, press play, and start again from the extension."
        : `Couldn't reach the video page: ${e.message}`
    );
  }
  const port = chrome.tabs.connect(tabId, { name: 'page-fetch', frameId });
  const pending = new Map();
  const disconnectListeners = [];
  let closed = false;
  let seq = 0;

  port.onMessage.addListener((msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (!msg.ok) return entry.reject(new TypeError(msg.error || 'Network error'));
    entry.resolve(new PageResponse(msg));
  });

  port.onDisconnect.addListener(() => {
    closed = true;
    pending.forEach((entry) => entry.reject(new PageClosedError()));
    pending.clear();
    disconnectListeners.forEach((fn) => fn());
  });

  function pageFetch(url, { signal, headers, credentials, cache, expectCached } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new PageClosedError());
      if (signal?.aborted) return reject(signal.reason);
      const id = ++seq;
      const onAbort = () => {
        pending.delete(id);
        if (!closed) port.postMessage({ type: 'abort', id });
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (fn) => (value) => {
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      port.postMessage({ type: 'fetch', id, url, headers, credentials, cache, expectCached });
    });
  }

  return {
    fetch: pageFetch,
    onDisconnect: (fn) => disconnectListeners.push(fn),
    get closed() {
      return closed;
    },
    close() {
      if (!closed) port.disconnect();
      closed = true;
    },
  };
}
