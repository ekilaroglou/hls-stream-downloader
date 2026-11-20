// Isolated-world partner of hook.js: forwards playlists found in the page to
// the extension's background script.
document.addEventListener('hls-downloader:playlist', (event) => {
  try {
    const { url, text } = JSON.parse(event.detail);
    if (typeof url !== 'string' || typeof text !== 'string') return;
    chrome.runtime.sendMessage({ type: 'playlist-found', url, text }).catch(() => {});
  } catch {
    // Ignore malformed events.
  }
});
