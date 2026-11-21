// Finds HLS playlists per tab, together with the frame (page or embedded
// player iframe) that loaded them:
//  - by network request: URLs ending in .m3u8, or responses with an HLS content type
//  - by content: content/hook.js reports any response that starts with #EXTM3U
// It also notes which media segments each tab has loaded (as short hashes),
// so the parts already in the browser can be saved without new requests.
// It only observes what the page loads anyway; it never sends requests itself.
import { requestId, loadedKey } from './lib/loaded.js';
import { iconWithCount, PLAIN_ICON } from './lib/toolbar-icon.js';
import { streamKey, countVideos, isMasterStream } from './lib/streams.js';

const PLAYLIST_URL = /\.m3u8(?:$|[?#])/i;
const MAX_STREAMS_PER_TAB = 40;
const MAX_TEXT_PER_TAB = 2 * 1024 * 1024; // captured playlist texts per tab
const MAX_LOADED_PER_TAB = 20000; // segment hashes per tab
const JOB_LIFETIME_MS = 30 * 60 * 1000;

const storageKey = (tabId) => `tab:${tabId}`;
const ownOrigin = `chrome-extension://${chrome.runtime.id}`;

// In-memory "already seen" cache so repeated requests don't hit storage every time.
const known = new Map(); // tabId -> Map(streamKey -> fingerprint)

// Serialize storage updates so concurrent events don't overwrite each other.
let queue = Promise.resolve();
function updateTab(tabId, mutate) {
  queue = queue
    .then(async () => {
      if (closedTabs.has(tabId)) return;
      const key = storageKey(tabId);
      const { [key]: stored } = await chrome.storage.session.get(key);
      const data = stored || { streams: [] };
      data.streams = data.streams.filter((s) => s.kind === 'playlist'); // drop entries from older versions
      if (mutate(data) === false) return;
      await chrome.storage.session.set({ [key]: data });
      await updateBadge(tabId, data);
    })
    .catch((e) => console.warn('Stream detection:', e));
  return queue;
}

// Toolbar icon: a small count when the page has videos.
async function updateBadge(tabId, data) {
  const count = countVideos(data.streams);
  try {
    await chrome.action.setIcon(count ? { tabId, imageData: await iconWithCount(count) } : { tabId, path: PLAIN_ICON });
  } catch {
    // Tab already closed.
  }
}

// Over the size limit: drop the oldest quality playlists' texts first. Master
// playlists are small and are what group a video's playlists together.
function trimTexts(streams) {
  let size = streams.reduce((n, s) => n + (s.text?.length || 0), 0);
  for (const s of [...streams].sort((a, b) => isMasterStream(a) - isMasterStream(b) || a.time - b.time)) {
    if (size <= MAX_TEXT_PER_TAB) break;
    if (s.text) {
      size -= s.text.length;
      delete s.text;
    }
  }
}

function addStream({ tabId, frameId }, url, text) {
  let key;
  try {
    key = streamKey(url);
  } catch {
    return;
  }
  if (!known.has(tabId)) known.set(tabId, new Map());
  const seen = known.get(tabId);
  const fingerprint = `${frameId}|${url}|${text?.length ?? ''}`;
  if (seen.get(key) === fingerprint) return;
  seen.set(key, fingerprint);

  updateTab(tabId, (data) => {
    let stream = data.streams.find((s) => s.key === key);
    if (stream) {
      const sameUrl = stream.url === url;
      if (sameUrl && stream.frameId === frameId && (text === undefined || stream.text === text)) return false;
      // Same playlist with a fresher token, or captured content for a known URL.
      Object.assign(stream, { url, frameId, time: Date.now() });
      if (text !== undefined) stream.text = text;
      else if (!sameUrl) delete stream.text; // text belongs to the old URL
    } else {
      stream = { key, url, kind: 'playlist', frameId, time: Date.now() };
      if (text !== undefined) stream.text = text;
      data.streams.push(stream);
      if (data.streams.length > MAX_STREAMS_PER_TAB) data.streams.shift();
    }
    trimTexts(data.streams);
  });
}

function resetTab(tabId) {
  known.delete(tabId);
  updateTab(tabId, (data) => {
    if (!data.streams.length) return false;
    data.streams = [];
  });
}

// ---------------------------------------------------------------- loaded segments

const loaded = new Map(); // tabId -> { ids: Set, ready: Promise, timer }
const closedTabs = new Set(); // tab IDs aren't reused while the browser runs

function loadedFor(tabId) {
  let entry = loaded.get(tabId);
  if (!entry) {
    entry = { ids: new Set(), timer: null };
    const key = loadedKey(tabId);
    entry.ready = chrome.storage.session.get(key).then((r) => (r[key] || []).forEach((id) => entry.ids.add(id)));
    loaded.set(tabId, entry);
  }
  return entry;
}

async function markLoaded(tabId, ids) {
  if (closedTabs.has(tabId)) return;
  const entry = loadedFor(tabId);
  await entry.ready;
  let changed = false;
  for (const id of ids) {
    if (!entry.ids.has(id)) {
      entry.ids.add(id);
      changed = true;
    }
  }
  if (!changed || entry.timer) return;
  // Write at most twice a second.
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (closedTabs.has(tabId)) return; // closed in the meantime: don't store its list again
    let ids = [...entry.ids];
    if (ids.length > MAX_LOADED_PER_TAB) {
      ids = ids.slice(-MAX_LOADED_PER_TAB);
      entry.ids = new Set(ids);
    }
    chrome.storage.session.set({ [loadedKey(tabId)]: ids }).catch((e) => console.warn('Loaded segments:', e));
  }, 500);
}

const MEDIA_TYPE = /^(video|audio)\/|octet-stream|mp2t/i;
const MEDIA_PATH = /\.(ts|m4s|mp4|m4v|m4a|aac|mp3|ac3|ec3|cmfv|cmfa|mpg|mpeg|fmp4|key)(?:$|[?#])/i;
const requestInfo = new Map(); // requestId -> { url, range }

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const range = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'range')?.value || '';
    requestInfo.set(d.requestId, { url: d.url, range });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['requestHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    const info = requestInfo.get(d.requestId);
    requestInfo.delete(d.requestId);
    if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
    const type = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
    if (/mpegurl/i.test(type) || !(MEDIA_TYPE.test(type) || MEDIA_PATH.test(d.url) || d.type === 'media')) return;
    const range = info?.range || '';
    const ids = [requestId(d.url, range)];
    if (info && info.url !== d.url) ids.push(requestId(info.url, range)); // address before a redirect
    markLoaded(d.tabId, ids);
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener((d) => requestInfo.delete(d.requestId), { urls: ['<all_urls>'] });

// ---------------------------------------------------------------- detection

const isOwnRequest = (d) => d.initiator === ownOrigin;

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.type === 'main_frame') return resetTab(d.tabId);
    if (isOwnRequest(d)) return;
    if (PLAYLIST_URL.test(d.url)) addStream(d, d.url);
  },
  { urls: ['<all_urls>'] }
);

// Some sites serve playlists from URLs without ".m3u8"; recognize them by content type.
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || isOwnRequest(d) || PLAYLIST_URL.test(d.url)) return;
    const type = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
    if (/mpegurl/i.test(type)) addStream(d, d.url);
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['responseHeaders']
);

// Playlists recognised by content inside the page (content/hook.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'playlist-found' || !sender.tab) return;
  if (typeof msg.url !== 'string' || typeof msg.text !== 'string') return;
  addStream({ tabId: sender.tab.id, frameId: sender.frameId ?? 0 }, msg.url, msg.text);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closedTabs.add(tabId);
  known.delete(tabId);
  loaded.delete(tabId);
  chrome.storage.session.remove([storageKey(tabId), loadedKey(tabId)]);
});

// Download links (job:<id>) are valid for 30 minutes; remove older ones.
async function removeExpiredJobs() {
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all)
    .filter(([k, v]) => k.startsWith('job:') && !(Date.now() - (v?.created || 0) < JOB_LIFETIME_MS))
    .map(([k]) => k);
  if (old.length) await chrome.storage.session.remove(old);
}
removeExpiredJobs();
chrome.tabs.onCreated.addListener(() => removeExpiredJobs());
