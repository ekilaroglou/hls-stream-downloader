// How many videos a tab has, from the playlists it loaded. A video's master
// playlist lists its qualities, separate audio tracks, subtitles and
// fast-forward previews; those playlists belong to that video and aren't
// counted again. Used for the small count on the toolbar icon.
import { parsePlaylist } from './m3u8.js';

export function streamKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

const isMasterText = (text) => text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');

export const isMasterStream = (s) => typeof s.text === 'string' && isMasterText(s.text);

/** `streams`: [{ key, url, text? }] as the background script stores them for a tab. */
export function countVideos(streams) {
  const covered = new Set();
  for (const s of streams) {
    if (typeof s.text !== 'string') continue;
    if (s.text.includes('#EXT-X-I-FRAMES-ONLY')) {
      covered.add(s.key);
      continue;
    }
    if (!isMasterText(s.text)) continue;
    try {
      const master = parsePlaylist(s.text, s.url);
      if (master.type !== 'master') continue;
      for (const url of [...master.variants.map((v) => v.url), ...master.renditionUrls]) covered.add(streamKey(url));
    } catch {
      // Unreadable: count what's there.
    }
  }
  return streams.filter((s) => !covered.has(s.key)).length;
}
