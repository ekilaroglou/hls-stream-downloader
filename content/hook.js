// Runs in the page's own JavaScript world (every frame, before the page's
// scripts). It watches responses the player receives and reports any HLS
// playlist, recognised by its content ("#EXTM3U"), no matter what the URL or
// content type is: plain .m3u8 files, API endpoints, service-worker responses,
// or blob: URLs built by the player itself.
// Read-only: the page gets exactly the same responses and timing as before.
(() => {
  const EVENT = 'hls-downloader:playlist';
  const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
  const MAGIC = '#EXTM3U';
  const reported = new Set();

  const isPlaylistStart = (text) => text.replace(/^﻿/, '').trimStart().startsWith(MAGIC);

  function report(url, text) {
    if (!url || typeof text !== 'string' || !isPlaylistStart(text)) return;
    const key = `${url}\n${text.length}`;
    if (reported.has(key)) return;
    reported.add(key);
    document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ url, text }) }));
  }

  function urlOf(input) {
    try {
      return new URL(input instanceof Request ? input.url : String(input), location.href).href;
    } catch {
      return '';
    }
  }

  const SKIP_TYPES = /^(video|audio|image|font)\/|text\/(html|css|javascript)|json|javascript|wasm/i;

  // Reads only the first chunk of a cloned response; continues only for playlists.
  async function inspect(res, url) {
    if (res.type === 'opaque' || SKIP_TYPES.test(res.headers.get('content-type') || '')) return;
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_PLAYLIST_BYTES) return;
    const reader = res.clone().body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (text.length >= 16 && !isPlaylistStart(text)) return reader.cancel();
        if (total > MAX_PLAYLIST_BYTES) return reader.cancel();
      }
      report(res.url || url, text + decoder.decode());
    } catch {
      // Ignore; the page's own copy of the response is unaffected.
    }
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function fetch(input, init) {
      const promise = originalFetch.apply(this, arguments);
      const url = urlOf(input);
      promise.then((res) => inspect(res, url), () => {});
      return promise;
    };
  }

  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const xhrUrls = new WeakMap();

  function onXhrLoad() {
    try {
      const url = this.responseURL || xhrUrls.get(this);
      const type = this.responseType;
      if (type === '' || type === 'text') {
        const text = this.responseText;
        if (text.length <= MAX_PLAYLIST_BYTES) report(url, text);
      } else if (type === 'arraybuffer' && this.response && this.response.byteLength <= MAX_PLAYLIST_BYTES) {
        const head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(16, this.response.byteLength)));
        if (isPlaylistStart(head)) report(url, new TextDecoder().decode(this.response));
      } else if (type === 'blob' && this.response && this.response.size <= MAX_PLAYLIST_BYTES) {
        this.response.text().then((text) => report(url, text), () => {});
      }
    } catch {
      // Ignore.
    }
  }

  XHR.open = function open(method, url) {
    try {
      xhrUrls.set(this, new URL(String(url), location.href).href);
    } catch {
      // Ignore.
    }
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function send() {
    this.addEventListener('load', onXhrLoad);
    return originalSend.apply(this, arguments);
  };
})();
