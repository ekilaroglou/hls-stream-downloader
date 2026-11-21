// HLS (.m3u8) playlist parser: master playlists (list of qualities and
// audio tracks) and media playlists (list of segments).

export function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let value = m[2];
    if (value.startsWith('"')) value = value.slice(1, -1);
    attrs[m[1]] = value;
  }
  return attrs;
}

function resolve(uri, baseUrl) {
  return new URL(uri, baseUrl).href;
}

function parseByteRange(spec, defaultOffset) {
  const [length, offset] = spec.split('@');
  return {
    length: Number(length),
    offset: offset !== undefined ? Number(offset) : defaultOffset,
  };
}

const VIDEO_CODECS = /\b(avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09|vp9|vp8|mp4v)\b/i;

export function parsePlaylist(text, baseUrl) {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Not an HLS playlist (missing #EXTM3U header).');
  }
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audio = [];
  const renditionUrls = []; // separate audio / subtitle playlists
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const url = resolve(lines[j], baseUrl);
      i = j;
      if (seen.has(url)) continue;
      seen.add(url);
      const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
      const codecs = a.CODECS || '';
      variants.push({
        url,
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: width || 0,
        height: height || 0,
        codecs,
        audioGroup: a.AUDIO || null,
        // Without RESOLUTION or CODECS, assume video (that's what most such playlists are).
        hasVideo: Boolean(height) || VIDEO_CODECS.test(codecs) || !codecs,
      });
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      // Fast-forward previews (key frames only): part of this video, not one of its own.
      const a = parseAttributes(line.slice('#EXT-X-I-FRAME-STREAM-INF:'.length));
      if (a.URI) renditionUrls.push(resolve(a.URI, baseUrl));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (a.URI) renditionUrls.push(resolve(a.URI, baseUrl));
      if (a.TYPE === 'AUDIO') {
        audio.push({
          groupId: a['GROUP-ID'],
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          url: a.URI ? resolve(a.URI, baseUrl) : null,
          isDefault: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
        });
      }
    }
  }
  // Best first: video before audio-only, then resolution, then bitrate.
  variants.sort((x, y) => y.hasVideo - x.hasVideo || y.height - x.height || y.bandwidth - x.bandwidth);
  return { type: 'master', url: baseUrl, variants, audio, renditionUrls };
}

function parseMedia(lines, baseUrl) {
  let mediaSequence = 0;
  let hasSequence = false;
  let targetDuration = 0;
  let endList = false;
  let playlistType = null;
  let iframesOnly = false;
  let encryption = 'none';

  let key = null;
  let map = null;
  let duration = null;
  let byteRangeSpec = null;
  let discontinuity = false;
  let gap = false;
  let afterGap = false;
  let count = 0;
  const nextRangeOffset = new Map();
  const segments = [];

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice('#EXTINF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      hasSequence = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length);
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line === '#EXT-X-I-FRAMES-ONLY') {
      iframesOnly = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRangeSpec = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = a.METHOD || 'NONE';
      const keyFormat = a.KEYFORMAT || 'identity';
      if (method === 'NONE') {
        key = null;
      } else if (method === 'AES-128' && keyFormat === 'identity' && a.URI) {
        key = { method, url: resolve(a.URI, baseUrl), iv: a.IV || null };
        if (encryption === 'none') encryption = 'aes-128';
      } else {
        // SAMPLE-AES, Widevine, PlayReady, FairPlay, ...: protected content.
        key = { method, keyFormat, url: null, iv: null };
        encryption = 'drm';
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      // The key in effect at this tag also encrypts the header (HLS: its IV is then given explicitly).
      map = a.URI
        ? { url: resolve(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null, key: key?.method === 'AES-128' ? key : null }
        : null;
    } else if (!line.startsWith('#')) {
      const url = resolve(line, baseUrl);
      const sequence = mediaSequence + count++;
      let range = null;
      if (byteRangeSpec) {
        range = parseByteRange(byteRangeSpec, nextRangeOffset.get(url) ?? 0);
        nextRangeOffset.set(url, range.offset + range.length);
      }
      if (gap) {
        // Marked as unavailable: skip it; the timeline continues after it.
        afterGap = true;
      } else {
        segments.push({
          url,
          duration: duration ?? 0,
          sequence,
          key,
          map,
          range,
          discontinuity: discontinuity || afterGap,
        });
        afterGap = false;
      }
      duration = null;
      byteRangeSpec = null;
      discontinuity = false;
      gap = false;
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  return {
    type: 'media',
    url: baseUrl,
    segments,
    totalDuration,
    targetDuration,
    hasSequence,
    endList,
    live: !endList && playlistType !== 'VOD',
    iframesOnly, // a fast-forward preview, not a playable video
    encryption,
    fmp4: segments.some((s) => s.map),
  };
}
