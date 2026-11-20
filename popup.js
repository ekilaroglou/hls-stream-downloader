import { loadPlaylist, loadMediaPlaylist, pathKey } from './lib/download.js';
import { connectToFrame, withCapturedPlaylists } from './lib/page-fetch.js';
import { readLoaded, chooseLoadedVariant } from './lib/loaded.js';
import { formatDuration, tokenExpiry } from './lib/util.js';
import { icon } from './lib/icons.js';

const list = document.getElementById('list');
document.getElementById('logo').append(icon('logo', 18));
document.getElementById('settings').append(icon('settings', 18));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false && child !== '') node.append(child);
  }
  return node;
}

const chip = (text, kind = '', title = '') => el('span', { class: `chip ${kind}`.trim(), textContent: text, title });

function expiryChip(url) {
  const expiry = tokenExpiry(url);
  if (!expiry) return null;
  const minutes = Math.floor((expiry - Date.now()) / 60000);
  if (minutes <= 0) return chip('link expired', 'danger', 'Reload the page and press play to get a fresh link');
  const text = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return chip(`link ${text}`, minutes < 15 ? 'warn' : '', "The site's link for this video stops working after this time");
}

function showEmpty(title, text) {
  list.replaceChildren(
    el('div', { class: 'card empty' }, el('div', { class: 'thumb' }, icon('play', 20)), el('strong', { textContent: title }), el('p', { class: 'muted', textContent: text }))
  );
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
document.getElementById('page').textContent = tab?.title || '';

// The download tab gets a short link (#id); the details stay in the
// extension's private session storage and expire after 30 minutes.
async function openDownloader(stream, mode) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
  await chrome.storage.session.set({
    [`job:${id}`]: { src: stream.url, tab: tab.id, frame: stream.frameId ?? 0, title: tab.title || '', mode, created: Date.now() },
  });
  await chrome.tabs.create({ url: `downloader.html#${id}`, index: tab.index + 1 });
  window.close();
}

function videoCard({ stream, media, variant, audioMedia, loadedPick }) {
  const drm = media.encryption === 'drm' || audioMedia?.encryption === 'drm';
  const audioOnly = variant && !variant.hasVideo;
  const name = media.live ? `Live ${audioOnly ? 'audio' : 'video'}` : `${audioOnly ? 'Audio' : 'Video'} · ${formatDuration(media.totalDuration)}`;
  const quality = variant?.height ? `${variant.height}p` : '';
  const chips = el(
    'div',
    { class: 'chips' },
    media.live && chip('LIVE', 'live'),
    quality && chip(quality, 'accent'),
    media.encryption === 'aes-128' && chip('AES-128'),
    drm && chip('protected', 'danger', 'Protected with DRM; cannot be saved'),
    expiryChip(stream.url)
  );
  const head = el(
    'div',
    { class: 'video-head' },
    el('div', { class: 'thumb' }, icon('play', 18)),
    el('div', {}, el('div', { class: 'video-title', textContent: name }), chips)
  );

  if (drm) {
    return el('section', { class: 'card video' }, head, el('p', { class: 'hint', textContent: "This video is protected with DRM and can't be saved." }));
  }
  if (media.live) {
    return el(
      'section',
      { class: 'card video' },
      head,
      el('div', { class: 'actions single' }, el('button', { class: 'btn primary', onclick: () => openDownloader(stream, 'all') }, icon('stop', 14), 'Record')),
      el('p', { class: 'hint', textContent: 'Records from now until you press Stop and save, or the stream ends.' })
    );
  }

  const stats = loadedPick.stats;
  const pct = Math.round(stats.fraction * 100);
  const pickQuality = loadedPick.variant?.height && loadedPick.variant !== variant ? ` (${loadedPick.variant.height}p)` : '';
  return el(
    'section',
    { class: 'card video' },
    head,
    el(
      'div',
      {},
      el(
        'div',
        { class: 'loaded-row' },
        el('span', { textContent: 'Loaded in your browser' }),
        el('strong', { textContent: `${formatDuration(stats.seconds)} · ${pct}%${pickQuality}` })
      ),
      el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` }))
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'btn primary', onclick: () => openDownloader(stream, 'loaded') }, icon('download', 16), pct >= 100 ? 'Save video' : 'Save loaded part'),
      el('button', { class: 'btn', disabled: pct >= 100, onclick: () => openDownloader(stream, 'all') }, icon('layers', 16), 'Download full video')
    ),
    el('p', {
      class: 'hint',
      textContent:
        pct >= 100
          ? 'The whole video is already in your browser: it is saved right away, with no new requests.'
          : 'Save loaded part makes no new requests and keeps adding parts while the video plays. Download full video also loads the rest from the site.',
    })
  );
}

function errorCard({ error }) {
  return el('section', { class: 'card video' }, el('div', { class: 'notice danger', textContent: error.message }));
}

async function main() {
  if (!tab?.id) return showEmpty('No active tab', '');
  const key = `tab:${tab.id}`;
  const { [key]: data } = await chrome.storage.session.get(key);
  const streams = (data?.streams || []).filter((s) => s.kind === 'playlist').reverse(); // newest first
  if (!streams.length) return showEmpty('No video found', 'Reload the page and press play. The video shows up here once it starts.');
  showEmpty('Looking at the video…', '');
  const loaded = await readLoaded(tab.id);

  // Playlists come from the player's own copy when captured; anything else is
  // loaded from inside the frame that plays the video.
  const connections = new Map();
  const frame = (frameId) => {
    if (!connections.has(frameId)) {
      connections.set(frameId, connectToFrame(tab.id, frameId).then((page) => ({ fetch: withCapturedPlaylists(page.fetch, streams) })));
    }
    return connections.get(frameId);
  };

  const first = await Promise.all(
    streams.map(async (stream) => {
      try {
        const page = await frame(stream.frameId ?? 0);
        return { stream, page, playlist: await loadPlaylist(stream.url, { fetchImpl: page.fetch }) };
      } catch (error) {
        return { stream, error };
      }
    })
  );

  // Quality and audio playlists already listed in a master aren't separate videos.
  const covered = new Set();
  for (const r of first) {
    if (r.playlist?.type !== 'master') continue;
    r.playlist.variants.forEach((v) => covered.add(pathKey(v.url)));
    r.playlist.renditionUrls.forEach((u) => covered.add(pathKey(u)));
  }

  const videos = await Promise.all(
    first
      .filter((r) => r.playlist && (r.playlist.type === 'master' || !covered.has(pathKey(r.stream.url))))
      .map(async ({ stream, page }) => {
        try {
          const info = await loadMediaPlaylist(stream.url, { fetchImpl: page.fetch });
          return { stream, ...info, loadedPick: chooseLoadedVariant(info, streams, loaded) };
        } catch (error) {
          return { stream, error };
        }
      })
  );

  // Live streams first, then the longest video (trailers and previews come later).
  const ok = videos.filter((v) => v?.media).sort((a, b) => b.media.live - a.media.live || b.media.totalDuration - a.media.totalDuration);
  const cards = ok.map(videoCard);
  if (!cards.length) cards.push(...[...videos, ...first].filter((r) => r?.error).slice(0, 2).map(errorCard));
  if (!cards.length) return showEmpty('No video found', 'Reload the page and press play. The video shows up here once it starts.');
  list.replaceChildren(...cards);
}

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

main().catch((e) => showEmpty('Something went wrong', e.message));
