// Which video segments has the page already loaded? The background script
// records a short hash of every media request a tab completes (never the
// address itself); this module computes the same hash for playlist segments.
import { parsePlaylist } from './m3u8.js';

// cyrb53: fast 53-bit string hash.
export function hash53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The Range request header a player sends for a byte-range segment. */
export const rangeHeader = (range) => (range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : '');

/** Identifier of a request: URL plus byte range (if any). */
export const requestId = (url, range = '') => hash53(range ? `${url}|${range}` : url);

export const segmentId = (seg) => requestId(seg.url, rangeHeader(seg.range));

export const loadedKey = (tabId) => `loaded:${tabId}`;

export async function readLoaded(tabId) {
  const key = loadedKey(tabId);
  return new Set((await chrome.storage.session.get(key))[key] || []);
}

/** How much of a media playlist the browser has loaded. */
export function loadedStats(media, loaded) {
  let count = 0;
  let seconds = 0;
  for (const seg of media.segments) {
    if (loaded.has(segmentId(seg))) {
      count++;
      seconds += seg.duration;
    }
  }
  const total = media.totalDuration || 0;
  return { count, seconds, total, fraction: total ? Math.min(1, seconds / total) : 0 };
}

/**
 * For "Save loaded part": the quality the page loaded the most of (players
 * often switch quality). Only playlists the page itself loaded are looked at,
 * so this makes no requests. `info` is the result of loadMediaPlaylist().
 */
export function chooseLoadedVariant(info, streams, loaded) {
  const candidates = [{ media: info.media, variant: info.variant }];
  for (const v of info.master?.variants || []) {
    if (!info.variant || v.url === info.variant.url) continue;
    const captured = streams.find((s) => s.url === v.url && typeof s.text === 'string');
    if (!captured) continue;
    try {
      const media = parsePlaylist(captured.text, v.url);
      if (media.type === 'media') candidates.push({ media, variant: v });
    } catch {
      // Ignore unreadable playlists.
    }
  }
  return candidates
    .map((c) => ({ ...c, stats: loadedStats(c.media, loaded) }))
    .sort((a, b) => b.stats.seconds - a.stats.seconds || (b.variant?.bandwidth || 0) - (a.variant?.bandwidth || 0))[0];
}
