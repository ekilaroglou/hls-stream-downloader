import { loadMediaPlaylist, StreamDownload, pathKey, DrmError, SPEEDS, speedKey, speedSetting, speedText } from './lib/download.js';
import { parsePlaylist } from './lib/m3u8.js';
import { connectToFrame, PageClosedError, withCapturedPlaylists } from './lib/page-fetch.js';
import { segmentId, readLoaded, loadedKey, chooseLoadedVariant } from './lib/loaded.js';
import { formatBytes, formatDuration, sanitizeFilename, tokenExpiry } from './lib/util.js';
import { icon } from './lib/icons.js';
import { workerConverter } from './lib/converter.js';
import { saveToSetting, savedFolder, hasAccess, askAccess, writeToFolder, folderError } from './lib/save-location.js';

const JOB_LIFETIME_MS = 30 * 60 * 1000; // download links (#id) work for 30 minutes

class StopRequest extends Error {
  constructor() {
    super('Stopped by user');
    this.name = 'StopRequest';
  }
}

const $ = (id) => document.getElementById(id);
$('logo').append(icon('logo', 18));
$('thumb').append(icon('film', 28));

const jobKey = `job:${location.hash.slice(1)}`;
let src = '';
let tabId;
let frameId = 0;
let pageTitle = '';
let mode = 'all'; // 'loaded': only what the page loaded; 'all': everything
let variantUrl = null;
let quality = '';
let speed = SPEEDS.normal;

let job = null;
const convert = workerConverter(); // MPEG-TS -> MP4 on background threads, while downloading
// Waits for the last conversions, then builds the file.
const buildAll = async () => {
  await job.settle();
  return job.finish();
};
let page = null; // connection to the video's frame; all requests go through it
let controller = null;
let state = 'loading'; // loading | running | collecting | paused | saving | done | stopped
let cancelled = false;
let resuming = false;
let pausedAt = 0;
let expiry = null;
let warnedExpiry = false;
let runStart = { time: 0, done: 0 };
let loadedIds = new Set();
const samples = [];

// ------------------------------------------------------------- small helpers

function notice(text, kind = 'warn') {
  const div = document.createElement('div');
  div.className = `notice ${kind}`;
  div.textContent = text;
  $('notices').append(div);
}

let logCount = 0;
function log(text) {
  $('log').textContent += `[${new Date().toLocaleTimeString()}] ${text}\n`;
  $('log-summary').textContent = `Details (${++logCount})`;
}

function setStatus(kind, text) {
  $('status').className = `status ${kind}`;
  $('status').textContent = text;
  renderPace();
}

const setPhase = (text) => ($('phase').textContent = text);

function setButton(el, spec) {
  if (!spec) {
    el.hidden = true;
    el.onclick = null;
    return;
  }
  el.hidden = false;
  el.disabled = Boolean(spec.disabled);
  el.replaceChildren(...(spec.icon ? [icon(spec.icon, 16)] : []), spec.label);
  el.onclick = spec.onClick;
}

function setActions({ primary = null, secondary = null, hint = '' } = {}) {
  setButton($('primary'), primary);
  setButton($('secondary'), secondary);
  $('hint').textContent = hint;
}

const guardUnload = (e) => {
  e.preventDefault();
  e.returnValue = '';
};

function remaining(ms) {
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes >= 1 ? `${minutes}m` : `${Math.ceil(ms / 1000)}s`;
}

function linkExpiry(m) {
  return tokenExpiry(m.segments[0]?.url ?? '') ?? tokenExpiry(m.url) ?? tokenExpiry(src);
}

const chip = (text, kind = '') => Object.assign(document.createElement('span'), { className: `chip ${kind}`.trim(), textContent: text });

const segIds = new WeakMap();
function isLoaded(seg) {
  let id = segIds.get(seg);
  if (!id) segIds.set(seg, (id = segmentId(seg)));
  return loadedIds.has(id);
}

async function tabStreams(id) {
  const key = `tab:${id}`;
  return ((await chrome.storage.session.get(key))[key]?.streams || []).filter((s) => s.kind === 'playlist');
}

async function loadSpeed() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return SPEEDS[speedSetting(settings?.speed)];
  } catch {
    return SPEEDS[speedSetting()];
  }
}

// ------------------------------------------------------------- speed switch

const speedPhrase = (value) => (Number.isFinite(value) ? `at up to ${value}× playback speed` : 'as fast as possible');
const runningPhase = () => `Downloading ${speedPhrase(job.pace.speed)}…`;

function buildPaceOptions() {
  const group = $('pace-options');
  for (const [key, s] of Object.entries(SPEEDS)) {
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'pace', value: key, id: `pace-${key}` });
    const label = Object.assign(document.createElement('label'), { htmlFor: input.id, title: Number.isFinite(s.speed) ? `Up to ${s.speed}× playback speed` : 'As fast as your connection allows' });
    label.append(s.label);
    if (speedText(s.speed)) label.append(Object.assign(document.createElement('span'), { className: 'x', textContent: speedText(s.speed) }));
    group.append(input, label);
  }
  group.addEventListener('change', (e) => choosePace(e.target.value));
}
buildPaceOptions();

// Shown while "Download full video" runs or is paused (a live recording follows the stream in real time).
function renderPace() {
  const show = Boolean(job) && mode === 'all' && !job.live && (state === 'running' || state === 'paused');
  $('pace').hidden = !show;
  if (!show) return;
  const current = speedKey(job.pace.speed);
  for (const input of $('pace-options').querySelectorAll('input')) input.checked = input.value === current;
}

async function choosePace(key) {
  const s = SPEEDS[key];
  if (!s || !job) return;
  job.setPace(s);
  runStart = { time: Date.now(), done: job.done };
  log(`Speed: ${s.label}, ${speedPhrase(s.speed)}.`);
  if (state === 'running') setPhase(runningPhase());
  renderProgress();
  try {
    // Also the setting for the next downloads.
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), speed: key } });
  } catch {
    // Applies to this download only.
  }
}

// The site answered "too many requests": the engine lowered the speed for this download.
function onPaceChange({ speed: lowered }) {
  runStart = { time: Date.now(), done: job.done };
  renderPace();
  if (state === 'running') setPhase(runningPhase());
  const s = SPEEDS[speedKey(lowered)];
  notice(`The site asked for fewer requests, so this download slowed down to ${s ? `${s.label} (${lowered}×)` : `${lowered}×`}.`, 'info');
}

// ------------------------------------------------------------- rendering

let expiryChip = null;
function renderChips(media, variant) {
  const chips = [];
  try {
    chips.push(chip(new URL(src).hostname)); // only the site's name, never the full link
  } catch {
    // No host.
  }
  chips.push(media.live ? chip('LIVE', 'live') : chip(formatDuration(media.totalDuration)));
  if (variant?.height) chips.push(chip(`${variant.height}p`, 'accent'));
  if (mode === 'loaded') chips.push(chip('from your browser'));
  if (expiry) chips.push((expiryChip = chip('')));
  $('chips').replaceChildren(...chips);
  tickExpiry();
}

function tickExpiry() {
  if (!expiryChip || !expiry) return;
  const ms = expiry - Date.now();
  expiryChip.textContent = ms > 0 ? `link ${remaining(ms)}` : 'link expired';
  expiryChip.className = `chip ${ms < 15 * 60000 ? 'warn' : ''}`.trim();
}
setInterval(tickExpiry, 30000);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawCoverage() {
  const canvas = $('coverage');
  canvas.hidden = !job || job.live;
  if (canvas.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, height / 2);
  ctx.clip();
  ctx.fillStyle = cssVar('--track');
  ctx.fillRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#2563eb');
  gradient.addColorStop(0.55, '#4f46e5');
  gradient.addColorStop(1, '#7c3aed');
  const pending = cssVar('--accent-soft-2');
  const main = job.main;
  const total = main.media.segments.reduce((n, s) => n + s.duration, 0) || 1;
  let time = 0;
  main.media.segments.forEach((seg, i) => {
    const x = (time / total) * width;
    const w = (seg.duration / total) * width + 0.6;
    const done = mode === 'loaded' ? main.collected.has(i) : i < main.next;
    const fill = done ? gradient : mode === 'loaded' && isLoaded(seg) ? pending : null;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, 0, w, height);
    }
    time += seg.duration;
  });
  ctx.restore();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    renderProgress();
  }, 120);
}

function renderProgress() {
  if (!job) return;
  const now = Date.now();
  const collecting = mode === 'loaded';
  const seconds = collecting ? job.main.collectedSeconds : job.main.seconds;
  const bytes = collecting ? job.collectedBytes : job.bytes;
  samples.push([now, bytes]);
  while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
  const [t0, b0] = samples[0];
  const rate = now > t0 ? (bytes - b0) / ((now - t0) / 1000) : 0;

  $('s-size').textContent = formatBytes(bytes);
  $('s-speed-label').textContent = collecting ? 'Source' : 'Rate';
  $('s-speed').textContent = collecting ? 'Your browser' : rate > 0 && state === 'running' ? `${formatBytes(rate)}/s` : '–';

  if (job.live) {
    $('percent').textContent = '';
    $('s-media').textContent = `${formatDuration(seconds)} recorded`;
    $('s-eta').textContent = 'until you stop';
    if (state === 'running' || state === 'collecting') document.title = `● ${formatDuration(seconds)} · ${pageTitle || 'Recording'}`;
    return;
  }
  const total = job.main.media.totalDuration || 1;
  const pct = Math.min(100, Math.floor((seconds / total) * 100));
  $('percent').textContent = `${pct}%`;
  $('s-media').textContent = `${formatDuration(seconds)} / ${formatDuration(total)}`;
  if (collecting) {
    $('s-eta').textContent = job.collectComplete ? 'done' : 'while it plays';
  } else {
    const done = job.done;
    // The pace sets the time; a slow network can make it longer (measured since the last start or speed change).
    const counted = done - runStart.done;
    const measured = counted >= 3 ? ((now - runStart.time) / counted) * (job.total - done) / 1000 : 0;
    const eta = Math.max(job.pacedSecondsLeft(), measured);
    $('s-eta').textContent = done < job.total && state === 'running' ? formatDuration(eta) : '–';
    if (expiry && !warnedExpiry && state === 'running' && done < job.total && now + eta * 1000 > expiry) {
      warnedExpiry = true;
      notice('The video link expires before the download finishes. If it does, reload the video page and press play; the download continues by itself.');
    }
  }
  if (state === 'running' || state === 'collecting') document.title = `${pct}% · ${pageTitle || 'Download'}`;
  drawCoverage();
}

window.addEventListener('resize', () => job && drawCoverage());

// ------------------------------------------------------------- start

async function init() {
  const record = (await chrome.storage.session.get(jobKey))[jobKey];
  if (!record) throw new Error('This download link is not valid any more. Download links work for 30 minutes: start again from the extension.');
  if (!(Date.now() - record.created < JOB_LIFETIME_MS)) {
    await chrome.storage.session.remove(jobKey);
    throw new Error('This download link has expired: download links work for 30 minutes. Start again from the extension.');
  }
  ({ src, tab: tabId, frame: frameId, mode } = record);
  pageTitle = record.title || '';
  document.title = pageTitle ? `Download: ${pageTitle}` : 'Download video';
  $('title').textContent = pageTitle || 'Video';
  speed = await loadSpeed();
  loadedIds = await readLoaded(tabId);

  // The player's frame can change when the video page reloads.
  const streams = await tabStreams(tabId);
  frameId = streams.find((s) => s.url === src)?.frameId ?? frameId;
  page = await connectToFrame(tabId, frameId);
  const loaded = await loadMediaPlaylist(src, { fetchImpl: withCapturedPlaylists(page.fetch, streams) });
  let { media, variant } = loaded;
  const { audioMedia } = loaded;
  // "Save loaded part" uses the quality the page actually loaded the most of.
  if (mode === 'loaded' && !media.live) ({ media, variant } = chooseLoadedVariant(loaded, streams, loadedIds));
  variantUrl = variant?.url || null;
  quality = variant?.height ? `${variant.height}p` : '';
  expiry = linkExpiry(media);
  renderChips(media, variant);

  if (media.encryption === 'drm' || audioMedia?.encryption === 'drm') return showFailed(new DrmError().message);
  if (expiry && expiry <= Date.now() && mode !== 'loaded') {
    return showFailed('The video link has expired. Reload the video page, press play, and start again.');
  }
  if (!media.segments.length && !media.live) return showFailed('The playlist contains no segments.');
  if (media.encryption === 'aes-128') log('Stream uses standard HLS AES-128 encryption; segments will be decrypted.');
  if (audioMedia) log('The audio is a separate stream; it will be combined with the video.');

  job = new StreamDownload(
    { media, audioMedia },
    { speed: speed.speed, connections: speed.connections, onProgress: scheduleRender, onLog: log, isLoaded, onPaceChange, convert }
  );
  window.addEventListener('beforeunload', guardUnload);
  renderProgress();
  if (mode === 'loaded') {
    log('Saving the parts the page has loaded, from the browser. Nothing new is requested from the site.');
    await runCollect();
  } else {
    log(media.live ? 'Recording the live stream through the video page.' : `Downloading ${job.total} segments ${speedPhrase(job.pace.speed)}.`);
    await runJob();
  }
}

// ------------------------------------------------------------- "Download full video"

async function runJob() {
  controller = new AbortController();
  const current = controller;
  page.onDisconnect(() => current.abort(new PageClosedError()));
  state = 'running';
  runStart = { time: Date.now(), done: job.done };
  samples.length = 0;
  if (job.live) {
    setStatus('rec', 'Recording');
    setPhase('Recording the live stream…');
    setActions({
      primary: { label: 'Stop and save', icon: 'stop', onClick: stopAndSave },
      secondary: { label: 'Discard', onClick: cancel },
      hint: 'Keep this tab and the video tab open.',
    });
  } else {
    setStatus('run', 'Downloading');
    setPhase(runningPhase());
    setActions({ secondary: { label: 'Cancel', onClick: cancel }, hint: 'Keep this tab and the video tab open until the file is saved.' });
  }

  try {
    await job.run({ fetchImpl: page.fetch, signal: current.signal });
  } catch (e) {
    if (cancelled) return showCancelled();
    if (e?.name === 'StopRequest') return finishAndSave(buildAll);
    if (job.live) {
      // A live stream moves on; save what was recorded instead of pausing.
      notice(`Recording ended early: ${e?.message || e}`);
      return finishAndSave(buildAll);
    }
    return showPaused(e);
  }
  await finishAndSave(buildAll);
}

// ------------------------------------------------------------- "Save loaded part"

let changeWaiters = [];
function waitForChange(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    changeWaiters.push(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

// Live streams: follow the playlist the player reloads (captured), so no request is added.
async function applyCapturedPlaylists() {
  if (!job.live) return;
  const streams = await tabStreams(tabId);
  for (const s of job.sources) {
    const captured = streams.find((x) => x.key === pathKey(s.media.url) && typeof x.text === 'string');
    if (!captured) continue;
    try {
      job.applyPlaylistUpdate(s, parsePlaylist(captured.text, captured.url));
    } catch (e) {
      log(`Couldn't read the updated playlist: ${e.message}`);
    }
  }
}

async function runCollect() {
  controller = new AbortController();
  const current = controller;
  page.onDisconnect(() => current.abort(new PageClosedError()));
  state = 'collecting';
  samples.length = 0;
  setStatus('collect', job.live ? 'Recording' : 'Collecting');
  setActions({
    primary: { label: 'Save now', icon: 'download', onClick: stopAndSave, disabled: !job.collectedCount },
    secondary: { label: 'Back to video', icon: 'back', onClick: () => chrome.tabs.update(tabId, { active: true }) },
  });

  try {
    for (;;) {
      setPhase('Taking the loaded parts from your browser…');
      await job.collect({ fetchImpl: page.fetch, signal: current.signal, isLoaded });
      renderProgress();
      if (job.collectComplete) break;
      $('primary').disabled = !job.collectedCount;
      setPhase(job.collectedCount ? 'Waiting for more of the video to load…' : 'Waiting for the video to load: press play in the video tab.');
      $('hint').textContent = 'Parts are added while the video plays. Save now keeps what you have.';
      await waitForChange(current.signal);
      await applyCapturedPlaylists();
    }
  } catch (e) {
    if (cancelled) return showCancelled();
    if (e?.name === 'StopRequest') return finishAndSave(() => job.buildCollected());
    if (job.broken) return showFailed(e.message);
    return showCollectPaused(e);
  }
  await finishAndSave(() => job.buildCollected());
}

function showCollectPaused(error) {
  state = 'paused';
  pausedAt = Date.now();
  setStatus('paused', 'Paused');
  const lost = error?.name === 'PageClosedError' || page?.closed;
  log(`Paused: ${error?.message || error}`);
  setPhase(lost ? 'The video page was closed or reloaded.' : `Stopped: ${error?.message || error}`);
  setActions({
    primary: { label: 'Save what was collected', icon: 'download', onClick: () => finishAndSave(() => job.buildCollected()), disabled: !job.collectedCount },
    secondary: { label: 'Discard', onClick: cancel },
    hint: 'Open or reload the video page and press play to keep collecting; it continues by itself.',
  });
  document.title = `Paused · ${pageTitle || 'Download'}`;
}

// ------------------------------------------------------------- pause / resume

function showPaused(error) {
  if (job.broken) return showFailed(error.message);
  state = 'paused';
  pausedAt = Date.now();
  const kept = `${job.done.toLocaleString()} of ${job.total.toLocaleString()} segments kept`;
  let hint;
  if (error?.name === 'PageClosedError' || page?.closed) {
    hint = 'The video page was closed or reloaded. Open or reload it and press play; the download continues by itself.';
  } else if (error?.name === 'TokenExpiredError') {
    hint = 'The video link expired. Reload the video page and press play; the download continues by itself.';
  } else {
    hint = `${error?.message || error} Try again, or reload the video page.`;
  }
  log(`Paused (${kept}): ${error?.message || error}`);
  setStatus('paused', 'Paused');
  setPhase(`Paused · ${kept}`);
  setActions({
    primary: { label: 'Resume', icon: 'retry', onClick: () => resume() },
    secondary: { label: 'Discard', onClick: cancel },
    hint,
  });
  renderProgress();
  document.title = `Paused · ${pageTitle || 'Download'}`;
}

const sameVideo = (m) =>
  m.segments.length === job.main.media.segments.length && Math.abs(m.totalDuration - job.main.media.totalDuration) < 1;

// Finds the video again after a reload. The playlist may now have a fresh link
// or even a new address, so candidates are checked by their content.
async function findStream({ newerThan = 0 } = {}) {
  const all = await chrome.storage.session.get(null);
  const candidates = [];
  for (const [k, data] of Object.entries(all)) {
    if (!k.startsWith('tab:')) continue;
    const id = Number(k.slice(4));
    const streams = (data?.streams || []).filter((s) => s.kind === 'playlist');
    for (const stream of streams) if (stream.time > newerThan) candidates.push({ stream, tabId: id, streams });
  }
  const key = pathKey(src);
  const exact = candidates
    .filter((c) => c.stream.key === key)
    .sort((a, b) => (b.tabId === tabId) - (a.tabId === tabId) || b.stream.time - a.stream.time);
  const others = candidates
    .filter((c) => c.stream.key !== key && c.tabId === tabId)
    .sort((a, b) => b.stream.time - a.stream.time)
    .slice(0, 6);

  for (const c of [...exact, ...others]) {
    let connection;
    try {
      connection = await connectToFrame(c.tabId, c.stream.frameId ?? 0);
      const loaded = await loadMediaPlaylist(c.stream.url, {
        variantUrl: c.stream.key === key ? variantUrl : undefined,
        fetchImpl: withCapturedPlaylists(connection.fetch, c.streams),
      });
      if (sameVideo(loaded.media)) return { ...c, connection, loaded };
    } catch {
      // Try the next candidate.
    }
    connection?.close();
  }
  return null;
}

async function resume({ automatic = false } = {}) {
  if (state !== 'paused' || resuming) return;
  resuming = true;
  $('primary').disabled = true;
  if (!automatic) setPhase('Looking for the video…');
  let found = null;
  try {
    found = await findStream({ newerThan: automatic ? pausedAt : 0 });
  } catch {
    found = null;
  }
  resuming = false;
  if (state !== 'paused') return found?.connection.close();
  if (!found) {
    $('primary').disabled = mode === 'loaded' && !job.collectedCount;
    if (!automatic) setPhase('The video was not found. Open or reload the video page and press play; it continues by itself.');
    return;
  }
  try {
    job.replaceMedia({ media: found.loaded.media, audioMedia: found.loaded.audioMedia });
  } catch (e) {
    found.connection.close();
    $('primary').disabled = false;
    return setPhase(e.message);
  }
  page?.close();
  page = found.connection;
  tabId = found.tabId;
  frameId = found.stream.frameId ?? 0;
  src = found.stream.url;
  if (found.loaded.variant) variantUrl = found.loaded.variant.url;
  expiry = linkExpiry(found.loaded.media);
  warnedExpiry = false;
  loadedIds = await readLoaded(tabId);
  log(mode === 'loaded' ? 'The video page is back; collecting again.' : `Resuming at segment ${job.done + 1}.`);
  await (mode === 'loaded' ? runCollect() : runJob());
}

let autoTimer = null;
let wakeTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || tabId === undefined) return;
  const loadedChange = changes[loadedKey(tabId)];
  if (loadedChange) {
    loadedIds = new Set(loadedChange.newValue || []);
    if (job) scheduleRender();
  }
  if (!loadedChange && !Object.keys(changes).some((k) => k.startsWith('tab:'))) return;
  // Something new was loaded: let the collector look again.
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    const waiting = changeWaiters;
    changeWaiters = [];
    waiting.forEach((fn) => fn());
  }, 300);
  // Paused: continue automatically when the video shows up again (e.g. after a reload).
  if (state === 'paused' && !resuming) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => resume({ automatic: true }), 1500);
  }
});

// ------------------------------------------------------------- finishing

function stopAndSave() {
  if (state !== 'running' && state !== 'collecting') return;
  $('primary').disabled = true;
  setPhase('Finishing…');
  controller.abort(new StopRequest());
}

function cancel() {
  if (state === 'running' || state === 'collecting') {
    cancelled = true;
    controller.abort();
  } else if (state === 'paused') {
    cancelled = true;
    showCancelled();
  }
}

function endSession() {
  window.removeEventListener('beforeunload', guardUnload);
  page?.close();
  chrome.storage.session.remove(jobKey); // the stored link details are no longer needed
  convert.close();
}

function showCancelled() {
  state = 'stopped';
  endSession();
  log('Cancelled by user.');
  setStatus('', 'Cancelled');
  setPhase('Cancelled. Nothing was saved.');
  setActions({ secondary: { label: 'Back to video', icon: 'back', onClick: () => chrome.tabs.update(tabId, { active: true }) } });
  document.title = pageTitle || 'Download video';
}

function showFailed(message) {
  state = 'stopped';
  endSession();
  setStatus('error', 'Failed');
  setPhase("The video couldn't be saved.");
  notice(message, 'danger');
  log(`Error: ${message}`);
  setActions({ hint: 'Start again from the extension: press play on the video page and open the extension.' });
  document.title = pageTitle || 'Download video';
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      chrome.downloads.onChanged.removeListener(listener);
      fn(arg);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish(resolve);
      if (delta.state.current === 'interrupted') {
        const reason = delta.error?.current || 'interrupted';
        finish(reject, new Error(reason === 'USER_CANCELED' ? 'The Save As window was closed, so the video was not saved yet.' : `Saving the file did not finish (${reason}).`));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // It may have ended before the listener was added.
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') finish(resolve);
      if (item?.state === 'interrupted') listener({ id, state: { current: 'interrupted' }, error: { current: item.error } });
    });
  });
}

// Settings → Save to. A chosen folder that's gone falls back to Downloads.
async function loadSaveTarget() {
  let settings = {};
  try {
    settings = (await chrome.storage.local.get('settings')).settings || {};
  } catch {
    // Defaults.
  }
  const kind = saveToSetting(settings.saveTo);
  if (kind !== 'folder') return { kind };
  const handle = await savedFolder();
  return handle ? { kind, handle } : { kind: 'downloads', missingFolder: true };
}

const baseName = (path) => path.split(/[\\/]/).pop();

// Returns the download id (null for a chosen folder) and the name the file got.
async function saveFile(file, target) {
  if (target.kind === 'folder') return { id: null, name: await writeToFolder(target.handle, file.name, file.blob) };
  const url = URL.createObjectURL(file.blob);
  try {
    const id = await chrome.downloads.download({ url, filename: file.name, conflictAction: 'uniquify', saveAs: target.kind === 'ask' });
    await waitForDownload(id);
    const [item] = await chrome.downloads.search({ id });
    return { id, name: item?.filename ? baseName(item.filename) : file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function finishAndSave(build) {
  state = 'saving';
  page?.close();
  setStatus('run', 'Saving');
  setPhase('Building the file…');
  setActions({});
  let result;
  try {
    result = await build();
  } catch (e) {
    return showFailed(e.message);
  }
  renderProgress();
  log(`Saved ${result.segments} segments (${formatBytes(result.bytes)}).`);
  const files = result.files;
  if (files.length > 1) {
    notice("The video and its separate audio use formats that can't be combined in the browser, so they were saved as two files.");
  } else if (!['mp4', 'm4a'].includes(files[0].extension)) {
    notice(`Saved as .${files[0].extension}: this stream's format can't be converted to MP4 in the browser. Players such as VLC can play it.`);
  }
  if (mode === 'loaded' && !job.live && !job.collectComplete) {
    notice(
      `Saved ${formatDuration(job.main.collectedSeconds)} of ${formatDuration(job.main.media.totalDuration)}: the parts your browser had loaded, joined together.`,
      'info'
    );
  }
  const base = `${sanitizeFilename(pageTitle)}${quality ? ` (${quality})` : ''}`;
  files.forEach((f) => (f.name = `${base}${files.length > 1 && f.role === 'audio' ? ' (audio)' : ''}.${f.extension}`));

  let target = await loadSaveTarget();
  if (target.missingFolder) notice("The folder chosen in Settings can't be found, so the video goes to your Downloads folder.", 'info');
  const pending = [...files];
  const saved = [];
  const toDownloads = { label: 'Save to Downloads instead', icon: 'download', onClick: () => ((target = { kind: 'downloads' }), saveRemaining()) };
  const back = { label: 'Back to video', icon: 'back', onClick: () => chrome.tabs.update(tabId, { active: true }) };

  // Chrome gives access to a chosen folder for a while; after that it needs a click to ask again.
  const askForFolder = () => {
    const name = target.handle.name;
    setStatus('paused', 'Ready to save');
    setPhase(`Chrome needs your OK to save in “${name}”.`);
    setActions({
      primary: {
        label: `Save to “${name}”`,
        icon: 'folder',
        onClick: async () => {
          let ok = false;
          try {
            ok = await askAccess(target.handle);
          } catch {
            // Treated as not allowed.
          }
          if (ok) return saveRemaining();
          setPhase(`Chrome didn't allow saving to “${name}”. Try again, or save to your Downloads folder.`);
        },
      },
      secondary: toDownloads,
      hint: 'The video is ready. Nothing is lost while this tab stays open.',
    });
    document.title = `Ready to save · ${pageTitle || 'video'}`;
  };

  let saving = false; // one save at a time, even after a quick double click
  const saveRemaining = async () => {
    if (saving) return;
    saving = true;
    try {
      await saveAll();
    } finally {
      saving = false;
    }
  };

  const saveAll = async () => {
    if (target.kind === 'folder' && !(await hasAccess(target.handle))) return askForFolder();
    setStatus('run', 'Saving');
    setActions({});
    try {
      while (pending.length) {
        setPhase(`Saving ${pending[0].name}…`);
        saved.push({ ...(await saveFile(pending[0], target)), file: pending[0] });
        pending.shift();
      }
    } catch (e) {
      // Keep the data so saving can be retried (e.g. after closing a Save As window).
      setStatus('paused', 'Not saved');
      setPhase(target.kind === 'folder' ? folderError(e, target.handle.name) : e.message);
      setActions({ primary: { label: 'Save again', icon: 'download', onClick: saveRemaining }, secondary: target.kind === 'downloads' ? null : toDownloads });
      return;
    }
    state = 'done';
    endSession();
    $('s-eta').textContent = 'done';
    $('s-speed').textContent = mode === 'loaded' ? 'Your browser' : '–';
    const total = saved.reduce((n, s) => n + s.file.blob.size, 0);
    const where = { downloads: 'to your Downloads folder', folder: `to “${target.handle?.name}”`, ask: '' }[target.kind];
    setStatus('done', 'Saved');
    setPhase(`Saved${where ? ` ${where}` : ''} · ${formatBytes(total)}`);
    const shown = saved.find((s) => s.id !== null);
    setActions({
      primary: shown ? { label: 'Show in folder', icon: 'folder', onClick: () => chrome.downloads.show(shown.id) } : back,
      secondary: shown ? back : null,
      hint: saved.map((s) => s.name).join(', '),
    });
    document.title = `✓ ${pageTitle || 'Download complete'}`;
  };
  await saveRemaining();
}

init().catch((e) => {
  if (state === 'loading') showFailed(e.message);
});
