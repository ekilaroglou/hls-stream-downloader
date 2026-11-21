import { parsePlaylist } from './m3u8.js';
import { fetchResource } from './fetcher.js';
import { parseInit, parseFragments, buildMp4 } from './mp4.js';
import { sniffSegment } from './formats.js';
import { sleep } from './util.js';

// Download pace as a multiple of playback speed. Like a video player, it
// first loads BUFFER_AHEAD seconds, then keeps that buffer topped up at this
// speed. Segments that come from Chrome's cache don't count.
// "Max" has no pace: up to 16 requests at a time (sites on HTTP/1.1 get at most
// 6, Chrome's own limit per server). If the site says that's too many, Max
// sends fewer at a time instead of switching to a pace.
export const SPEEDS = {
  normal: { label: 'Normal', speed: 4, connections: 2 },
  fast: { label: 'Fast', speed: 16, connections: 4 },
  max: { label: 'Max', speed: Infinity, connections: 16 },
};
export const DEFAULT_SPEED = 'normal';
export const BUFFER_AHEAD = 30;
// For the paced speeds, new requests start at most this often (it only
// matters for streams with very short segments).
export const MAX_REQUESTS_PER_SECOND = 6;
// Settings saved by earlier versions.
const RENAMED = { gentle: 'normal', fastest: 'fast' };

/** A saved speed setting as a SPEEDS key (older names mapped, unknown -> default). */
export function speedSetting(key) {
  if (SPEEDS[key]) return key;
  return SPEEDS[RENAMED[key]] ? RENAMED[key] : DEFAULT_SPEED;
}

/** "4×", or "" for Max. */
export const speedText = (speed) => (Number.isFinite(speed) ? `${speed}×` : '');
const MAX_CONNECTIONS = Math.max(...Object.values(SPEEDS).map((s) => s.connections));
// Answers that mean "too many requests": 429, and 503, which rate limiters also use.
const BUSY_STATUSES = new Set([429, 503]);
const SLOW_DOWN_INTERVAL_MS = 15_000; // one step slower per burst of such answers
// Max: after the site said "too many", try one more at a time again only after
// this long without such answers, and after a run of answered requests.
const CALM_BEFORE_MORE_MS = 10_000;

/** The SPEEDS key of a speed, or null if it isn't one of the settings. */
export const speedKey = (speed) => Object.keys(SPEEDS).find((k) => SPEEDS[k].speed === speed) ?? null;

/** The setting one step slower than `speed`, or null at the slowest. */
export function slowerSpeed(speed) {
  return Object.values(SPEEDS).filter((s) => s.speed < speed).sort((a, b) => b.speed - a.speed)[0] ?? null;
}

export class DrmError extends Error {
  constructor() {
    super('This video is protected with DRM or encryption that can\'t be saved.');
    this.name = 'DrmError';
  }
}

export const pathKey = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

export async function loadPlaylist(url, { fetchImpl, signal, onRetry } = {}) {
  const meta = {};
  const text = await fetchResource(url, { as: 'text', signal, retries: 2, onRetry, fetchImpl, meta });
  // Relative addresses are resolved against the final URL (after redirects), like players do.
  return parsePlaylist(text, meta.url || url);
}

function pickAudio(master, variant) {
  if (!master || !variant?.audioGroup) return null;
  const group = master.audio.filter((a) => a.groupId === variant.audioGroup && a.url && a.url !== variant.url);
  return group.find((a) => a.isDefault) || group.find((a) => a.autoselect) || group[0] || null;
}

/**
 * Loads a playlist URL and returns what to download: the media playlist of the
 * chosen quality (default: best) and, if that quality keeps its audio in a
 * separate playlist, that audio playlist.
 * Variants are matched by exact URL first, then by path (links get new tokens after a reload).
 */
export async function loadMediaPlaylist(url, { variantUrl, fetchImpl, signal } = {}) {
  const first = await loadPlaylist(url, { fetchImpl, signal });
  if (first.type === 'media') return { media: first, master: null, variant: null, audio: null, audioMedia: null };

  const variant =
    first.variants.find((v) => v.url === variantUrl) ||
    (variantUrl && first.variants.find((v) => pathKey(v.url) === pathKey(variantUrl))) ||
    first.variants[0];
  if (!variant) throw new Error('This playlist lists no video qualities.');
  const media = await loadPlaylist(variant.url, { fetchImpl, signal });
  if (media.type !== 'media') throw new Error('Unexpected nested master playlist.');

  const audio = pickAudio(first, variant);
  let audioMedia = null;
  if (audio) {
    audioMedia = await loadPlaylist(audio.url, { fetchImpl, signal });
    if (audioMedia.type !== 'media') throw new Error('The audio playlist is not a media playlist.');
  }
  return { media, master: first, variant, audio, audioMedia };
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let n = BigInt(sequence);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

function hexIv(hex) {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(clean.substr(i * 2, 2), 16);
  return iv;
}

// Identifies an init segment independent of its (expiring) token.
const mapKey = (map) => `${pathKey(map.url)}|${map.range ? `${map.range.offset}:${map.range.length}` : ''}`;

const nowSeconds = () => performance.now() / 1000;

/**
 * Paces requests like a player: buffer ahead, then follow a virtual playhead
 * that moves at `speed` times playback speed. New requests also start at
 * least 1/maxRate seconds apart, and none start while the server asked to wait.
 */
class Pacer {
  constructor(speed, bufferAhead, maxRate) {
    this.speed = speed;
    this.bufferAhead = bufferAhead;
    this.gap = maxRate > 0 ? 1 / maxRate : 0;
    this.reset();
  }

  // Max (unlimited speed) has no pace and no request limit; it still waits when the server asks.
  get limited() {
    return this.speed > 0 && Number.isFinite(this.speed);
  }

  reset() {
    this.loaded = 0;
    this.playhead = 0;
    this.clock = null;
    this.nextRequest = 0;
    this.holdUntil = 0;
  }

  advance() {
    if (this.clock === null) return;
    const now = nowSeconds();
    // The playhead stands still while the server asked to wait, so the pace
    // afterwards is the same as before (no catching up in a burst).
    const from = Math.max(this.clock, this.holdUntil);
    if (now > from) this.playhead = Math.min(this.loaded, this.playhead + (now - from) * this.speed);
    this.clock = now;
  }

  waitMs() {
    const now = nowSeconds();
    let wait = this.holdUntil - now;
    if (this.limited) {
      this.advance();
      const lead = this.loaded - this.playhead;
      wait = Math.max(wait, this.nextRequest - now, (lead - this.bufferAhead) / this.speed);
    }
    return Math.max(0, wait) * 1000;
  }

  // Reserve a segment when its request starts, so requests go out evenly
  // spaced instead of in bursts.
  add(seconds) {
    this.advance();
    this.loaded += seconds;
    if (this.clock === null) this.clock = nowSeconds();
  }

  // Give the reservation back (the segment came from the browser cache).
  refund(seconds) {
    this.advance();
    this.loaded = Math.max(0, this.loaded - seconds);
    this.playhead = Math.min(this.playhead, this.loaded);
  }

  // A new request starts: the next one waits at least `gap` seconds.
  request() {
    this.nextRequest = Math.max(nowSeconds(), this.nextRequest) + this.gap;
  }

  // The request was answered from the browser cache: it doesn't count.
  refundRequest() {
    this.nextRequest -= this.gap;
  }

  setSpeed(speed) {
    this.advance(); // the time so far counts at the old speed
    this.speed = speed;
  }

  // The server asked to wait: no new requests for `ms`.
  hold(ms) {
    this.advance();
    this.holdUntil = Math.max(this.holdUntil, nowSeconds() + ms / 1000);
  }
}

/** One playlist being downloaded (the video, or a separate audio track). */
class Source {
  constructor(media, role) {
    this.media = media;
    this.role = role; // 'main' | 'audio'
    this.next = 0; // next segment to write; everything before it is saved
    this.requested = 0; // next segment to request (only while run() is running)
    this.bytes = 0;
    this.seconds = 0;
    this.inits = new Map(); // map key -> Promise<bytes>
    this.initBytes = new Map(); // map key -> bytes
    this.parsedInits = new Map(); // map key -> parsed init
    this.keys = new Map();
    this.lastMap = null;
    this.format = null; // result of sniffSegment for the first segment
    this.init = null; // parsed init used for the output header
    this.fragments = [];
    this.parts = []; // raw output
    this.transmuxer = null;
    this.started = false;
    this.chunkDiscontinuity = false;
    this.ready = new Map();
    this.converting = Promise.resolve(); // segments still being converted on a background thread
    this.waitingForConversion = 0;
    this.finished = 0; // segments completely in the file (converted, if they needed it)
    this.finishedSeconds = 0;
    this.collected = new Map(); // "Save loaded part": segment index -> Blob
    this.collectedBytes = 0;
    this.collectedSeconds = 0;
    this.ended = !media.live;
    this.lastSequence = media.segments.length ? media.segments[media.segments.length - 1].sequence : -1;
    this.seen = new Set(media.segments.map((s) => s.url));
  }
}

/**
 * Downloads a media playlist (plus a separate audio playlist, if any) and
 * builds the file. VOD downloads are resumable: if run() stops (page closed,
 * link expired, network down), call replaceMedia() with the reloaded
 * playlists and run() again. Live streams are recorded until they end or
 * run() is stopped; finish() then saves what was recorded.
 */
export class StreamDownload {
  constructor({ media, audioMedia = null }, options = {}) {
    const {
      muxjs = globalThis.muxjs,
      onProgress = () => {},
      onLog = () => {},
      speed = SPEEDS[DEFAULT_SPEED].speed,
      connections = SPEEDS[DEFAULT_SPEED].connections,
      bufferAhead = BUFFER_AHEAD,
      keepOriginal = false, // join segments as they are (no MP4 conversion)
      isLoaded = null, // (segment) => true if the page already loaded it (it's in the browser cache)
      maxRequestsPerSecond = MAX_REQUESTS_PER_SECOND,
      convert = null, // optional MPEG-TS -> MP4 conversion on a background thread (see converter.js)
      onPaceChange = () => {}, // the speed was lowered because the server asked for fewer requests
      onRetryWait = () => {}, // a request is retried after `delay` ms ({ delay, status })
    } = options;
    for (const m of [media, audioMedia]) if (m?.encryption === 'drm') throw new DrmError();
    if (!media.segments.length && !media.live) throw new Error('The playlist contains no segments.');

    this.sources = [new Source(media, 'main')];
    if (audioMedia) this.sources.push(new Source(audioMedia, 'audio'));
    this.muxjs = muxjs;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.connections = Math.max(1, connections);
    this.connectionLimit = this.connections; // Max: the most at a time the site has accepted so far
    this.lastFewer = -Infinity;
    this.answeredInARow = 0;
    this.keepOriginal = keepOriginal;
    this.pacer = new Pacer(speed, bufferAhead, maxRequestsPerSecond);
    this.onPaceChange = onPaceChange;
    this.onRetryWait = onRetryWait;
    this.convert = convert;
    this.convertError = null;
    this.lastSlowDown = -Infinity;
    this.wake = null; // while run() is running: lets idle connections check the speed again
    this.isLoaded = isLoaded;
    this.cacheWorks = true; // false once parts the page loaded keep coming from the network
    this.networkStreak = 0;
    this.live = Boolean(media.live);
    this.ended = !this.live;
    this.broken = false;
    this.partial = false;
  }

  get main() {
    return this.sources[0];
  }

  get done() {
    return this.sources.reduce((n, s) => n + s.next, 0);
  }

  get total() {
    return this.sources.reduce((n, s) => n + s.media.segments.length, 0);
  }

  get bytes() {
    return this.sources.reduce((n, s) => n + s.bytes, 0);
  }

  get finished() {
    return this.ended && this.sources.every((s) => s.next >= s.media.segments.length);
  }

  /**
   * A part the page already loaded was fetched again: did it come from the
   * browser cache? After three network answers in a row, this site's parts
   * evidently aren't kept in the cache, so they are paced like new ones.
   */
  noteLoadedFetch(fromCache) {
    if (fromCache) {
      this.networkStreak = 0;
      return;
    }
    if (++this.networkStreak >= 3 && this.cacheWorks) {
      this.cacheWorks = false;
      this.onLog("This site doesn't let the browser keep video parts, so they are loaded again at the normal pace.");
    }
  }

  /** Current speed (multiple of playback speed) and number of connections. */
  get pace() {
    return { speed: this.pacer.speed, connections: this.connections };
  }

  /** Changes the speed; a running download uses it right away. */
  setPace({ speed, connections }) {
    this.pacer.setSpeed(speed);
    this.connections = Math.max(1, connections);
    this.connectionLimit = this.connections;
    this.answeredInARow = 0;
    this.wake?.();
  }

  /**
   * The server answered 429 or 503 ("too many requests"): no new requests
   * until the wait it asked for is over. Max then sends half as many requests
   * at a time (still without a pace); the paced speeds, and Max once it is
   * down to one at a time, go one speed slower for the rest of the download.
   */
  serverBusy(waitMs, status) {
    this.pacer.hold(waitMs);
    const now = performance.now();
    if (!this.pacer.limited && this.connections > 1) {
      // Answers to requests sent before the last change don't count again.
      if (now - this.lastFewer < Math.max(1000, waitMs)) return;
      this.lastFewer = now;
      this.connectionLimit = this.connections - 1;
      this.connections = Math.max(1, Math.floor(this.connections / 2));
      this.answeredInARow = 0;
      this.onLog(`The site asked for fewer requests (HTTP ${status}); continuing with ${this.connections} at a time.`);
      return;
    }
    if (now - this.lastFewer < Math.max(1000, waitMs)) return;
    if (now - this.lastSlowDown < SLOW_DOWN_INTERVAL_MS) return;
    this.lastSlowDown = now;
    const slower = this.pacer.speed > 0 ? slowerSpeed(this.pacer.speed) : null;
    if (!slower) {
      this.onLog(`The site asked for fewer requests (HTTP ${status}); waiting before continuing.`);
      return;
    }
    this.setPace(slower);
    this.onLog(`The site asked for fewer requests (HTTP ${status}), so the download continues at up to ${slower.speed}× playback speed.`);
    this.onPaceChange({ speed: slower.speed, connections: slower.connections, status });
  }

  // Max: a request was answered from the site. After a calm stretch, try one
  // more at a time again, up to one less than the number the site turned down.
  noteAnswered() {
    if (this.pacer.limited || this.connections >= this.connectionLimit) return;
    if (performance.now() - this.lastFewer < CALM_BEFORE_MORE_MS) return;
    if (++this.answeredInARow < this.connections * 2) return;
    this.answeredInARow = 0;
    this.connections++;
    this.wake?.();
  }

  noteRetry({ attempt, retries, error, delay, retryAfter = null }) {
    this.onLog(`${error.message}; retry ${attempt}/${retries} in ${(delay / 1000).toFixed(1)}s`);
    this.onRetryWait({ delay, status: error?.status ?? null });
    // Everything waits as long as the site asks (Retry-After). If it doesn't
    // say, a short pause: the request itself is retried later, with a growing wait.
    if (BUSY_STATUSES.has(error?.status)) this.serverBusy(retryAfter ?? Math.min(delay, 1000), error.status);
  }

  /**
   * About how many seconds the rest of the download needs at the current
   * speed. Parts expected from the browser cache are free; a slow network can
   * make it take longer (the caller measures that).
   */
  pacedSecondsLeft() {
    const p = this.pacer;
    if (!p.limited) return 0;
    let content = 0;
    let requests = 0;
    for (const src of this.sources) {
      const segments = src.media.segments;
      for (let i = Math.max(src.requested, src.next); i < segments.length; i++) {
        if (this.cacheWorks && this.isLoaded?.(segments[i])) continue;
        requests++;
        if (src.role === 'main') content += segments[i].duration;
      }
    }
    p.advance();
    const holding = Math.max(0, p.holdUntil - nowSeconds());
    const byPace = Math.max(0, p.loaded - p.playhead + content - p.bufferAhead) / p.speed;
    return holding + Math.max(byPace, requests * p.gap);
  }

  get collectedCount() {
    return this.sources.reduce((n, s) => n + s.collected.size, 0);
  }

  get collectedBytes() {
    return this.sources.reduce((n, s) => n + s.collectedBytes, 0);
  }

  /** "Save loaded part": everything has been loaded and collected. */
  get collectComplete() {
    return this.ended && this.sources.every((s) => s.collected.size >= s.media.segments.length);
  }

  /** Continue a VOD download with reloaded playlists (fresh links) for the same video. */
  replaceMedia({ media, audioMedia = null }) {
    const fresh = [media, audioMedia];
    this.sources.forEach((src, i) => {
      const m = fresh[i];
      if (!m) throw new Error('The reloaded video is missing its separate audio track.');
      if (m.encryption === 'drm') throw new DrmError();
      if (m.segments.length !== src.media.segments.length) {
        throw new Error(
          `The reloaded video has ${m.segments.length} segments instead of ${src.media.segments.length}. It may be a different video or quality.`
        );
      }
    });
    this.sources.forEach((src, i) => {
      src.media = fresh[i];
      src.keys.clear();
    });
  }

  report() {
    this.onProgress({
      done: this.done,
      total: this.total,
      bytes: this.bytes,
      seconds: this.main.seconds,
      totalSeconds: this.main.media.totalDuration,
      live: this.live,
    });
  }

  async loadInit(src, map, get) {
    const k = mapKey(map);
    if (!src.inits.has(k)) {
      const promise = get(map.url, map.range);
      src.inits.set(k, promise);
      promise.catch(() => src.inits.delete(k));
    }
    src.initBytes.set(k, await src.inits.get(k));
  }

  async decrypt(src, bytes, seg, get) {
    let keyPromise = src.keys.get(seg.key.url);
    if (!keyPromise) {
      keyPromise = get(seg.key.url).then((raw) => {
        if (raw.byteLength !== 16) throw new Error(`Decryption key has ${raw.byteLength} bytes, expected 16.`);
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      });
      src.keys.set(seg.key.url, keyPromise);
      keyPromise.catch(() => src.keys.delete(seg.key.url));
    }
    const iv = seg.key.iv ? hexIv(seg.key.iv) : sequenceIv(seg.sequence);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keyPromise, bytes));
  }

  // ------------------------------------------------------------- writing

  write(src, seg, data) {
    try {
      if (!src.format) {
        src.format = sniffSegment(data, Boolean(seg.map));
        if (this.keepOriginal || (src.format.kind === 'mux' && !this.muxjs)) src.format = { ...src.format, kind: 'raw' };
        if (src.format.kind === 'raw' && !this.keepOriginal) {
          this.onLog(`Saving the ${src.role === 'audio' ? 'audio' : 'video'} as .${src.format.ext}: its format can't be converted to MP4 in the browser.`);
        }
      }
      let later = false; // converted on a background thread: finished when that's done
      if (src.format.kind === 'raw') this.writeRaw(src, seg, data);
      else if (src.format.kind === 'fmp4') this.writeFmp4(src, seg, data);
      else later = this.writeMux(src, seg, data);
      if (!later) this.markFinished(src, seg);
    } catch (e) {
      this.broken = true;
      throw e;
    }
  }

  writeRaw(src, seg, data) {
    if (seg.map) {
      const k = mapKey(seg.map);
      if (k !== src.lastMap) {
        src.parts.push(new Blob([src.initBytes.get(k)]));
        src.lastMap = k;
      }
    }
    src.parts.push(new Blob([data]));
  }

  writeFmp4(src, seg, data) {
    let init = null;
    if (seg.map) {
      const k = mapKey(seg.map);
      if (!src.parsedInits.has(k)) src.parsedInits.set(k, parseInit(src.initBytes.get(k)));
      init = src.parsedInits.get(k);
    }
    // Self-initializing segments carry their own header.
    init = parseInit(data) || init || src.init;
    this.addChunk(src, init, data, seg.discontinuity && src.started);
    src.started = true;
  }

  writeMux(src, seg, data) {
    // A discontinuity can change timestamps and settings: start a fresh converter.
    const discontinuity = Boolean(seg.discontinuity && src.started);
    src.started = true;
    if (this.convert) {
      // Converted on a background thread, in order, while downloading goes on.
      const outputs = this.convert(src.role, data, discontinuity);
      src.waitingForConversion++;
      src.converting = src.converting.then(async () => {
        if (this.convertError) return;
        try {
          (await outputs).forEach((out, i) => this.addChunk(src, parseInit(out.initSegment), out.data, discontinuity && i === 0));
          src.waitingForConversion--;
          this.markFinished(src, seg);
          this.report();
        } catch (e) {
          this.broken = true;
          this.convertError = e;
        }
      });
      return true;
    }
    if (!src.transmuxer || discontinuity) src.transmuxer = this.createTransmuxer(src);
    src.chunkDiscontinuity = discontinuity;
    src.transmuxer.push(data);
    src.transmuxer.flush();
    return false;
  }

  markFinished(src, seg) {
    src.finished++;
    src.finishedSeconds += seg.duration;
  }

  /** Segments downloaded but still being converted to MP4. */
  get waitingForConversion() {
    return this.sources.reduce((n, s) => n + s.waitingForConversion, 0);
  }

  /** Waits until every segment handed to the background converter is in the file. */
  async settle() {
    await Promise.all(this.sources.map((s) => s.converting));
    if (this.convertError) throw this.convertError;
  }

  createTransmuxer(src) {
    const transmuxer = new this.muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
    transmuxer.on('data', (out) => {
      this.addChunk(src, parseInit(out.initSegment), out.data, src.chunkDiscontinuity);
      src.chunkDiscontinuity = false;
    });
    return transmuxer;
  }

  addChunk(src, init, data, discontinuity) {
    if (!init) throw new Error('The stream is missing its MP4 header (init segment).');
    if (!src.init) src.init = init;
    // Later headers (e.g. after an ad break) describe the same kinds of tracks.
    const remap = new Map(init.tracks.map((t) => [t.id, (src.init.tracks.find((x) => x.handler === t.handler) || t).id]));
    const defaults = new Map(init.tracks.map((t) => [t.id, t.defaultDuration]));
    const flagged = new Set();
    for (const f of parseFragments(data, defaults)) {
      for (const tf of f.trafs) {
        tf.trackId = remap.get(tf.trackId) ?? tf.trackId;
        tf.discontinuity = discontinuity && !flagged.has(tf.trackId);
        flagged.add(tf.trackId);
      }
      src.fragments.push({
        moof: data.slice(f.start, f.moofEnd),
        media: new Blob([data.subarray(f.moofEnd, f.end)]),
        mfhdPos: f.mfhdPos,
        trafs: f.trafs,
      });
    }
  }

  // ------------------------------------------------------------- downloading

  async run({ fetchImpl, signal } = {}) {
    if (this.broken) throw new Error('This download cannot continue. Start a new one.');
    this.pacer.reset(); // after a pause, buffer again like a reloaded player
    for (;;) {
      await this.fetchAvailable(fetchImpl, signal);
      if (this.ended) return this.settle();
      await this.waitForLive(fetchImpl, signal);
    }
  }

  async fetchAvailable(fetchImpl, outerSignal) {
    outerSignal?.throwIfAborted();
    // Internal controller so one failed segment stops all connections.
    const controller = new AbortController();
    const onAbort = () => controller.abort(outerSignal.reason);
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    const signal = controller.signal;

    // Every request, retries included, waits for a free spot: never more than
    // `this.connections` at a time, even right after that number was lowered.
    let inFlight = 0;
    const turns = [];
    const nextTurns = () => {
      while (turns.length && inFlight < this.connections) {
        inFlight++;
        turns.shift().go();
      }
    };
    const requestImpl = fetchImpl || fetch;
    const oneAtATimeFetch = async (url, init) => {
      if (inFlight < this.connections && !turns.length) {
        inFlight++;
      } else {
        await new Promise((resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            const i = turns.indexOf(turn);
            if (i >= 0) turns.splice(i, 1);
            reject(signal.reason);
          };
          const turn = {
            go: () => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            },
          };
          turns.push(turn);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      try {
        return await requestImpl(url, init);
      } finally {
        inFlight--;
        nextTurns();
      }
    };

    const onRetry = (info) => this.noteRetry(info);
    const get = (url, range, meta, cached = false) => fetchResource(url, { range, signal, onRetry, fetchImpl: oneAtATimeFetch, meta, cached });

    // Work list: the remaining segments of every source, in playback order.
    const items = [];
    this.sources.forEach((src, si) => {
      src.ready = new Map();
      src.requested = src.next;
      let time = 0;
      src.media.segments.forEach((seg, index) => {
        if (index >= src.next) items.push({ src, index, time, si });
        time += seg.duration;
      });
    });
    items.sort((a, b) => a.time - b.time || a.si - b.si);

    const windowSize = Math.max(8, MAX_CONNECTIONS * 4); // max segments buffered ahead of the writer
    let position = 0;
    let waiters = [];
    const notify = () => {
      nextTurns(); // the number at a time may have gone up
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
    };
    this.wake = notify;
    const waitForWriter = () =>
      new Promise((resolve, reject) => {
        const onStop = () => reject(signal.reason);
        signal.addEventListener('abort', onStop, { once: true });
        waiters.push(() => {
          signal.removeEventListener('abort', onStop);
          resolve();
        });
      });

    // Hands finished segments to the writer strictly in playback order.
    const writeReady = (src) => {
      while (src.ready.has(src.next)) {
        const data = src.ready.get(src.next);
        src.ready.delete(src.next);
        const seg = src.media.segments[src.next];
        const size = data.byteLength; // read first: a background converter takes over the bytes
        this.write(src, seg, data);
        if (this.convertError) throw this.convertError;
        src.next++;
        src.bytes += size;
        src.seconds += seg.duration;
        this.report();
      }
      notify();
    };

    // `slot`: connection number. Only as many connections work as the current
    // speed allows (it can change while running); the others wait.
    const worker = async (slot) => {
      while (position < items.length) {
        signal.throwIfAborted();
        const item = items[position];
        if (slot >= this.connections || item.index - item.src.next >= windowSize) {
          await waitForWriter();
          continue;
        }
        const { src, index } = item;
        const seg = src.media.segments[index];
        // Parts the page already loaded come from the browser cache: no pacing
        // (unless this site's segments turned out not to be cacheable).
        const loaded = Boolean(this.isLoaded?.(seg));
        const fromCacheExpected = loaded && this.cacheWorks;
        if (!fromCacheExpected) {
          const wait = this.pacer.waitMs();
          if (wait > 0) {
            await sleep(Math.min(wait, 1000), signal);
            continue;
          }
        }
        if (items[position] !== item) continue; // another connection took it
        position++;
        src.requested = index + 1;
        const paced = src.role === 'main';
        const reserved = paced && !fromCacheExpected;
        if (!fromCacheExpected) this.pacer.request();
        if (reserved) this.pacer.add(seg.duration);
        if (seg.map) await this.loadInit(src, seg.map, (u, r) => get(u, r, undefined, loaded));
        const meta = {};
        let data = await get(seg.url, seg.range, meta, loaded);
        if (!meta.fromCache) this.noteAnswered();
        if (!fromCacheExpected && meta.fromCache) this.pacer.refundRequest();
        if (reserved && meta.fromCache) this.pacer.refund(seg.duration);
        if (fromCacheExpected && !meta.fromCache) this.pacer.request();
        if (paced && !reserved) {
          if (!meta.fromCache) this.pacer.add(seg.duration);
          this.noteLoadedFetch(meta.fromCache);
        }
        if (seg.key) data = await this.decrypt(src, data, seg, get);
        src.ready.set(index, data);
        writeReady(src);
      }
    };

    try {
      const connections = Math.max(1, Math.min(Math.max(MAX_CONNECTIONS, this.connections), items.length));
      await Promise.all(
        Array.from({ length: connections }, (_, slot) =>
          worker(slot).catch((e) => {
            controller.abort(e);
            throw e;
          })
        )
      );
    } catch (e) {
      throw outerSignal?.aborted ? outerSignal.reason : e;
    } finally {
      this.wake = null;
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }

  /** Reloads live playlists until new segments appear or the stream ends. */
  async waitForLive(fetchImpl, signal) {
    const target = this.main.media.targetDuration || 6;
    const interval = Math.min(10, Math.max(1, target / 2)) * 1000;
    const idleLimit = Math.max(30, target * 3) * 1000;
    const since = Date.now();
    let failures = 0;
    for (;;) {
      await sleep(interval, signal);
      try {
        const added = await this.refreshLive(fetchImpl, signal);
        failures = 0;
        if (added || this.ended) return;
        if (Date.now() - since > idleLimit) {
          this.ended = true;
          this.onLog('The stream stopped updating; finishing the recording.');
          return;
        }
      } catch (e) {
        if (signal?.aborted || e?.fatal || e?.name === 'TokenExpiredError' || e?.name === 'DrmError') throw e;
        if (++failures >= 5) throw e;
        this.onLog(`Couldn't reload the live playlist (${e.message}); trying again.`);
      }
    }
  }

  async refreshLive(fetchImpl, signal) {
    let added = 0;
    for (const src of this.sources) {
      if (src.ended) continue;
      added += this.applyPlaylistUpdate(src, await loadPlaylist(src.media.url, { fetchImpl, signal }));
    }
    return added;
  }

  /** Adds the new segments of a reloaded live playlist (fetched, or captured from the page). */
  applyPlaylistUpdate(src, fresh) {
    if (fresh.type !== 'media') return 0;
    if (fresh.encryption === 'drm') throw new DrmError();
    const incoming = fresh.segments.filter((s) => (fresh.hasSequence ? s.sequence > src.lastSequence : !src.seen.has(s.url)));
    if (incoming.length && fresh.hasSequence && src.lastSequence >= 0 && incoming[0].sequence > src.lastSequence + 1) {
      incoming[0] = { ...incoming[0], discontinuity: true };
      this.onLog('Part of the live stream was missed: the playlist moved on before it could be loaded.');
    }
    for (const seg of incoming) {
      src.media.segments.push(seg);
      src.media.totalDuration += seg.duration;
      src.seen.add(seg.url);
      src.lastSequence = Math.max(src.lastSequence, seg.sequence);
    }
    if (fresh.targetDuration) src.media.targetDuration = fresh.targetDuration;
    if (fresh.endList) src.ended = true;
    if (this.sources.every((s) => s.ended)) this.ended = true;
    return incoming.length;
  }

  // ------------------------------------------------------------- "Save loaded part"

  /**
   * Takes every segment the page has already loaded (and that isn't collected
   * yet) from the browser cache. Nothing the page hasn't loaded is requested.
   * Can be called again whenever the page loads more.
   */
  async collect({ fetchImpl, signal, isLoaded }) {
    if (this.broken) throw new Error('This download cannot continue. Start a new one.');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const inner = controller.signal;
    const onRetry = (info) => this.noteRetry(info);
    const get = (url, range, meta) => fetchResource(url, { range, signal: inner, onRetry, fetchImpl, meta, cached: true });

    const items = [];
    this.sources.forEach((src, si) => {
      let time = 0;
      src.media.segments.forEach((seg, index) => {
        if (!src.collected.has(index) && isLoaded(seg)) items.push({ src, index, si, time });
        time += seg.duration;
      });
    });
    items.sort((a, b) => a.time - b.time || a.si - b.si);

    let position = 0;
    const worker = async () => {
      while (position < items.length) {
        inner.throwIfAborted();
        // If this site's segments aren't kept in the browser cache, the parts
        // are requested again; then keep to the normal pace.
        if (!this.cacheWorks) {
          const wait = this.pacer.waitMs();
          if (wait > 0) {
            await sleep(Math.min(wait, 1000), inner);
            continue;
          }
        }
        const { src, index } = items[position++];
        const seg = src.media.segments[index];
        if (seg.map) await this.loadInit(src, seg.map, get);
        const meta = {};
        let data = await get(seg.url, seg.range, meta);
        if (!meta.fromCache) this.pacer.request();
        if (src.role === 'main') {
          if (!meta.fromCache) this.pacer.add(seg.duration);
          this.noteLoadedFetch(meta.fromCache);
        }
        if (seg.key) data = await this.decrypt(src, data, seg, get);
        src.collected.set(index, new Blob([data]));
        src.collectedBytes += data.byteLength;
        src.collectedSeconds += seg.duration;
        this.onProgress({
          collect: true,
          done: this.collectedCount,
          total: this.total,
          bytes: this.collectedBytes,
          seconds: this.main.collectedSeconds,
          totalSeconds: this.main.media.totalDuration,
          live: this.live,
        });
      }
    };
    try {
      const connections = Math.max(1, Math.min(this.connections + 1, items.length));
      await Promise.all(
        Array.from({ length: connections }, () =>
          worker().catch((e) => {
            controller.abort(e);
            throw e;
          })
        )
      );
    } catch (e) {
      throw signal?.aborted ? signal.reason : e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return items.length;
  }

  /** Builds the file from the collected parts; gaps between them are joined. */
  async buildCollected() {
    if (!this.collectedCount) throw new Error('Nothing has been loaded yet. Play the video for a moment, then save.');
    for (const src of this.sources) {
      let previous = -1;
      for (const index of [...src.collected.keys()].sort((a, b) => a - b)) {
        const seg = src.media.segments[index];
        const data = new Uint8Array(await src.collected.get(index).arrayBuffer());
        const gap = previous >= 0 && index !== previous + 1;
        src.bytes += data.byteLength; // before writing: a background converter takes over the bytes
        this.write(src, gap ? { ...seg, discontinuity: true } : seg, data);
        src.seconds += seg.duration;
        src.next = index + 1;
        previous = index;
      }
    }
    this.partial = true;
    await this.settle();
    return this.finish();
  }

  // ------------------------------------------------------------- output

  /**
   * Builds the output file(s). Normally one MP4 (video and audio combined);
   * formats that can't be converted are saved as they are, and if the video
   * and a separate audio track can't be combined they become two files.
   */
  finish() {
    if (!this.finished && !this.live && !this.partial) throw new Error('Download is not complete.');
    const written = this.sources.filter((s) => s.next > 0 && s.format);
    if (!written.length) throw new Error('Nothing was downloaded.');
    const convertible = written.filter((s) => s.format.kind !== 'raw');
    const raw = written.filter((s) => s.format.kind === 'raw');
    const files = [];
    const mp4File = (sources, role) => {
      const out = buildMp4(sources);
      return { blob: out.blob, extension: out.hasVideo ? 'mp4' : 'm4a', role };
    };
    if (convertible.length && !raw.length) files.push(mp4File(convertible, 'main'));
    else convertible.forEach((s) => files.push(mp4File([s], s.role)));
    for (const s of raw) files.push({ blob: new Blob(s.parts, { type: s.format.mime }), extension: s.format.ext, role: s.role });
    files.sort((a, b) => (a.role === 'main' ? 0 : 1) - (b.role === 'main' ? 0 : 1));
    return { files, segments: this.done, bytes: this.bytes };
  }
}
