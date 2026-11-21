// Injected into the frame that plays the video (the page itself or the player
// iframe). It runs in the extension's isolated world, so the page's scripts
// can't see it, but its requests are made by that frame: same origin, referrer,
// cookies and CORS rules as the video player's own requests. Nothing is
// rewritten or spoofed.
(() => {
  if (globalThis.__hlsPageFetchInstalled) return;
  globalThis.__hlsPageFetchInstalled = true;

  // Was a response served from the browser's HTTP cache? Chrome says so in
  // Resource Timing (`deliveryType`) when the server allows timing details;
  // otherwise use timing: a cache hit starts within a few milliseconds and
  // arrives at memory/disk speed, while a server needs a network round trip.
  // When unsure, assume network: that only means the download is paced.
  // `expectCached`: the page already loaded this part and it was requested
  // with `force-cache`, so it only goes to the network if the site doesn't let
  // the browser keep it; large segments read from the disk cache, several at a
  // time, can take tens of milliseconds.
  function isCacheHit(url, started, firstByteMs, totalMs, bytes, expectCached) {
    // Only a timing entry of this request counts (not the player's earlier one).
    const entry = performance.getEntriesByName(url).filter((e) => e.startTime >= started - 5).at(-1);
    if (entry?.deliveryType === 'cache') return true;
    if (entry && entry.encodedBodySize > 0 && entry.transferSize > 0) return false; // detailed timing: came over the network
    if (expectCached) return firstByteMs < 150;
    return firstByteMs < 4 && bytes >= 64 * 1024 && bytes / Math.max(totalMs, 0.1) > 50_000;
  }

  function toBase64(bytes) {
    if (bytes.toBase64) return bytes.toBase64();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'page-fetch') return;
    const pending = new Map();

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'abort') {
        pending.get(msg.id)?.abort();
        return;
      }
      if (msg.type !== 'fetch') return;
      const controller = new AbortController();
      pending.set(msg.id, controller);
      try {
        const init = { headers: msg.headers, signal: controller.signal };
        if (msg.credentials) init.credentials = msg.credentials;
        if (msg.cache) init.cache = msg.cache;
        const started = performance.now();
        const res = await fetch(msg.url, init);
        const firstByte = performance.now() - started;
        const body = new Uint8Array(await res.arrayBuffer());
        const total = performance.now() - started;
        const fromCache = isCacheHit(res.url || msg.url, started, firstByte, total, body.length, msg.expectCached);
        const retryAfter = res.headers.get('retry-after');
        // For the developer log: timing in this page, and HTTP/1.1, HTTP/2 or HTTP/3 (if the site shares it).
        const entry = performance.getEntriesByName(res.url || msg.url).filter((e) => e.startTime >= started - 5).at(-1);
        port.postMessage({
          id: msg.id,
          ok: true,
          status: res.status,
          url: res.url,
          fromCache,
          headers: retryAfter ? { 'retry-after': retryAfter } : {},
          timing: { firstByte: Math.round(firstByte), total: Math.round(total), protocol: entry?.nextHopProtocol || '' },
          body: toBase64(body),
        });
      } catch (e) {
        if (!controller.signal.aborted) port.postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
      } finally {
        pending.delete(msg.id);
      }
    });

    port.onDisconnect.addListener(() => {
      pending.forEach((c) => c.abort());
      pending.clear();
    });
  });
})();
