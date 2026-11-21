// How many videos a tab has, from the playlists it loaded. A video's master
// playlist lists its qualities, separate audio tracks, subtitles and
// fast-forward previews; those playlists belong to that video and aren't
// counted again. Used for the small count on the toolbar icon.
import { parsePlaylist } from './m3u8.js';

// Ignore known signing fields. Preserve ambiguous names such as "e" (episode),
// "t" (track) and "hash" (content ID), even if their values resemble timestamps.
const LINK_PARAM =
  /^(?:token|tok|__token__|access_?token|auth_?token|auth|authorization|jwt|sig|signature|hmac|policy|key-?pair-?id|hdnts|hdnea|__gda__|wmsauthsign|exp|expires?|expiry|valid_?from|valid_?to|nonce|_|cb|cache_?bust(?:er)?|x-(?:amz|goog)-(?:algorithm|credential|date|expires|signedheaders|signature|security-token))$/i;

/** A playlist's identity: address without the parts that change with every fresh link. */
export function streamKey(url) {
  const u = new URL(url);
  const kept = [...u.searchParams].filter(([name]) => !LINK_PARAM.test(name));
  if (!kept.length) return u.origin + u.pathname;
  kept.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return `${u.origin}${u.pathname}?${new URLSearchParams(kept)}`;
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
