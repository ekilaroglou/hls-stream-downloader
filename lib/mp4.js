// Small ISO-BMFF (MP4) toolkit. It reads initialization segments and media
// fragments, and writes one fragmented MP4 that combines the tracks of one or
// more sources (for example a video playlist and a separate audio playlist):
//  - track IDs are renumbered and all tracks get one header (moov),
//  - the timeline starts at 0 for all tracks together (keeps them in sync)
//    and stays continuous across discontinuities (ad breaks, restarts),
//  - fragments are interleaved by time and the real duration is written.

const text4 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const typeAt = (b, off) => String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
const payload = (box) => box.start + box.header;

export function readBoxes(bytes, start = 0, end = bytes.length) {
  const view = dv(bytes);
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    boxes.push({ type: typeAt(bytes, off), start: off, end: off + size, header });
    off += size;
  }
  return boxes;
}

const children = (bytes, box) => readBoxes(bytes, payload(box), box.end);
const child = (bytes, box, type) => children(bytes, box).find((b) => b.type === type);
const childrenOf = (bytes, box, type) => children(bytes, box).filter((b) => b.type === type);

const MP4_START = new Set(['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft', 'free']);
export const looksLikeMp4 = (bytes) => bytes.length >= 8 && MP4_START.has(typeAt(bytes, 0));

/** Reads the tracks of an initialization segment (or any file with a moov box). */
export function parseInit(bytes) {
  const view = dv(bytes);
  const moov = readBoxes(bytes).find((b) => b.type === 'moov');
  if (!moov) return null;
  const mvhd = child(bytes, moov, 'mvhd');
  const movieTimescale = mvhd ? view.getUint32(payload(mvhd) + (bytes[payload(mvhd)] === 1 ? 20 : 12)) : 1000;

  const trexById = new Map();
  const mvex = child(bytes, moov, 'mvex');
  if (mvex) {
    for (const trex of childrenOf(bytes, mvex, 'trex')) trexById.set(view.getUint32(payload(trex) + 4), trex);
  }

  const tracks = [];
  for (const trak of childrenOf(bytes, moov, 'trak')) {
    const tkhd = child(bytes, trak, 'tkhd');
    const mdia = child(bytes, trak, 'mdia');
    const mdhd = mdia && child(bytes, mdia, 'mdhd');
    const hdlr = mdia && child(bytes, mdia, 'hdlr');
    if (!tkhd || !mdhd || !hdlr) continue;
    const id = view.getUint32(payload(tkhd) + (bytes[payload(tkhd)] === 1 ? 20 : 12));
    const timescale = view.getUint32(payload(mdhd) + (bytes[payload(mdhd)] === 1 ? 20 : 12));
    const handler = String.fromCharCode(...bytes.subarray(payload(hdlr) + 8, payload(hdlr) + 12));
    const trex = trexById.get(id);
    tracks.push({
      id,
      timescale,
      handler, // 'vide', 'soun', ...
      trak: bytes.slice(trak.start, trak.end),
      trex: trex ? bytes.slice(trex.start, trex.end) : null,
      defaultDuration: trex ? view.getUint32(payload(trex) + 12) : 0,
      // Leading empty edits delay the track's start (in seconds).
      editDelay: editEntries(bytes, trak).reduce(
        (acc, e) => (acc.done || e.mediaTime !== -1 ? { ...acc, done: true } : { done: false, sum: acc.sum + e.duration }),
        { done: false, sum: 0 }
      ).sum / (movieTimescale || 1000),
    });
  }
  return { movieTimescale: movieTimescale || 1000, tracks };
}

/** Edit list entries of a trak box: [{ duration (movie timescale), mediaTime, pos, v1 }]. */
function editEntries(bytes, trak) {
  const view = dv(bytes);
  const edts = child(bytes, trak, 'edts');
  const elst = edts && child(bytes, edts, 'elst');
  if (!elst) return [];
  const p = payload(elst);
  const v1 = bytes[p] === 1;
  const size = v1 ? 20 : 12;
  const entries = [];
  const count = view.getUint32(p + 4);
  for (let k = 0, q = p + 8; k < count && q + size <= elst.end; k++, q += size) {
    entries.push({
      pos: q,
      v1,
      duration: v1 ? Number(view.getBigUint64(q)) : view.getUint32(q),
      mediaTime: v1 ? Number(view.getBigInt64(q + 8)) : view.getInt32(q + 4),
    });
  }
  return entries;
}

/**
 * Splits media data into fragments (a moof box and its mdat). Positions in
 * the result are relative to the start of each moof. `defaultDurations` maps
 * track ID to the default sample duration from the init segment.
 */
export function parseFragments(bytes, defaultDurations = new Map()) {
  const view = dv(bytes);
  const top = readBoxes(bytes);
  const fragments = [];
  for (let i = 0; i < top.length; i++) {
    const moof = top[i];
    if (moof.type !== 'moof') continue;
    let end = -1;
    for (let j = i + 1; j < top.length && top[j].type !== 'moof'; j++) {
      if (top[j].type === 'mdat') end = top[j].end;
    }
    if (end < 0) continue; // no media data
    const mfhd = child(bytes, moof, 'mfhd');
    const trafs = [];
    for (const traf of childrenOf(bytes, moof, 'traf')) {
      const tfhd = child(bytes, traf, 'tfhd');
      if (!tfhd) continue;
      const flags = view.getUint32(payload(tfhd)) & 0xffffff;
      const trackId = view.getUint32(payload(tfhd) + 4);
      let q = payload(tfhd) + 8;
      let baseOffsetPos = -1;
      let baseOffset = 0;
      if (flags & 0x01) {
        baseOffsetPos = q - moof.start;
        baseOffset = Number(view.getBigUint64(q));
        q += 8;
      }
      if (flags & 0x02) q += 4;
      const defaultDuration = flags & 0x08 ? view.getUint32(q) : defaultDurations.get(trackId) || 0;

      const tfdt = child(bytes, traf, 'tfdt');
      let time = null;
      let tfdtVersion = 0;
      if (tfdt) {
        tfdtVersion = bytes[payload(tfdt)];
        time = tfdtVersion === 1 ? Number(view.getBigUint64(payload(tfdt) + 4)) : view.getUint32(payload(tfdt) + 4);
      }

      let duration = 0;
      for (const trun of childrenOf(bytes, traf, 'trun')) {
        const tf = view.getUint32(payload(trun)) & 0xffffff;
        const count = view.getUint32(payload(trun) + 4);
        let s = payload(trun) + 8;
        if (tf & 0x01) s += 4;
        if (tf & 0x04) s += 4;
        const stride = (tf & 0x100 ? 4 : 0) + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
        if (tf & 0x100) {
          for (let k = 0; k < count; k++) duration += view.getUint32(s + k * stride);
        } else {
          duration += count * defaultDuration;
        }
      }

      trafs.push({
        trackId,
        tfhdPos: payload(tfhd) + 4 - moof.start,
        tfdtPos: tfdt ? payload(tfdt) + 4 - moof.start : -1,
        tfdtVersion,
        time,
        duration,
        baseOffsetPos,
        baseOffset: baseOffset - moof.start, // relative to the moof
      });
    }
    if (trafs.length) {
      fragments.push({ start: moof.start, moofEnd: moof.end, end, mfhdPos: mfhd ? payload(mfhd) + 4 - moof.start : -1, trafs });
    }
  }
  return fragments;
}

// ---------------------------------------------------------------- writing

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  dv(out).setUint32(0, size);
  out.set(text4(type), 4);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const u32 = (n) => {
  const b = new Uint8Array(4);
  dv(b).setUint32(0, Math.max(0, Math.min(0xffffffff, Math.round(n))));
  return b;
};
const u64 = (n) => {
  const b = new Uint8Array(8);
  dv(b).setBigUint64(0, BigInt(Math.max(0, Math.round(n))));
  return b;
};
const bytes = (...values) => Uint8Array.from(values);

const ftyp = () => box('ftyp', text4('isom'), u32(0x200), text4('isom'), text4('iso6'), text4('mp41'));

function mvhd(timescale, duration, nextTrackId) {
  return box(
    'mvhd',
    bytes(1, 0, 0, 0), // version 1
    u64(0), // creation time
    u64(0), // modification time
    u32(timescale),
    u64(duration),
    u32(0x00010000), // rate 1.0
    bytes(0x01, 0x00), // volume 1.0
    new Uint8Array(10), // reserved
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000), // matrix
    new Uint8Array(24), // pre_defined
    u32(nextTrackId)
  );
}

const mehd = (duration) => box('mehd', bytes(1, 0, 0, 0), u64(duration));

function patchTrex(source, id) {
  if (!source) return box('trex', bytes(0, 0, 0, 0), u32(id), u32(1), u32(0), u32(0), u32(0));
  const trex = source.slice();
  dv(trex).setUint32(payload(readBoxes(trex)[0]) + 4, id);
  return trex;
}

function setDuration(view, pos, isV1, value) {
  if (isV1) view.setBigUint64(pos, BigInt(Math.max(0, Math.round(value))));
  else view.setUint32(pos, Math.max(0, Math.min(0xffffffff, Math.round(value))));
}

function patchTrak(source, { id, movieDuration, mediaDuration, fromMovieTimescale, toMovieTimescale }) {
  const trak = source.slice();
  const view = dv(trak);
  const [root] = readBoxes(trak);
  const tkhd = child(trak, root, 'tkhd');
  if (tkhd) {
    const p = payload(tkhd);
    const v1 = trak[p] === 1;
    trak[p + 3] |= 0x03; // track enabled, in movie
    view.setUint32(p + (v1 ? 20 : 12), id);
    setDuration(view, p + (v1 ? 28 : 20), v1, movieDuration);
  }
  const mdia = child(trak, root, 'mdia');
  const mdhd = mdia && child(trak, mdia, 'mdhd');
  if (mdhd) {
    const p = payload(mdhd);
    const v1 = trak[p] === 1;
    setDuration(view, p + (v1 ? 24 : 16), v1, mediaDuration);
  }
  // Edit lists: leading empty edits (a start delay) are already folded into the
  // fragment times, so they become zero-length; the rest use the movie timescale.
  let leading = true;
  for (const e of editEntries(trak, root)) {
    if (leading && e.mediaTime === -1) {
      setDuration(view, e.pos, e.v1, 0);
      continue;
    }
    leading = false;
    if (fromMovieTimescale && toMovieTimescale && fromMovieTimescale !== toMovieTimescale) {
      setDuration(view, e.pos, e.v1, (e.duration * toMovieTimescale) / fromMovieTimescale);
    }
  }
  return trak;
}

/**
 * Builds one MP4 from fragmented sources.
 * Each source: { init: parseInit() result, fragments: [{ moof, media (Blob), mfhdPos, trafs, ... }] }
 * where every traf carries `trackId` (an ID of that source's init) and an
 * optional `discontinuity` flag.
 */
export function buildMp4(sources) {
  const tracks = [];
  sources.forEach((src, si) => {
    for (const t of src.init.tracks) tracks.push({ key: `${si}:${t.id}`, src, t, timescale: t.timescale, refs: [] });
  });
  const byKey = new Map(tracks.map((tr) => [tr.key, tr]));

  const fragments = [];
  sources.forEach((src, si) => {
    for (const f of src.fragments) {
      const mapped = f.trafs.map((tf) => byKey.get(`${si}:${tf.trackId}`));
      if (mapped.some((tr) => !tr)) continue; // data for a track the header doesn't describe
      f.trafs.forEach((tf, k) => {
        tf.track = mapped[k];
        mapped[k].refs.push(tf);
      });
      fragments.push(f);
    }
  });

  const used = tracks.filter((tr) => tr.refs.length);
  if (!used.length) throw new Error('No video or audio data was found in the stream.');
  used.sort((a, b) => (a.t.handler === 'vide' ? 0 : 1) - (b.t.handler === 'vide' ? 0 : 1));
  used.forEach((tr, i) => (tr.newId = i + 1));

  // Timeline: all tracks start together at 0 (keeping their relative timing,
  // including start delays from edit lists) and stay continuous.
  const starts = used
    .map((tr) => {
      const first = tr.refs.find((tf) => tf.time !== null);
      return first ? tr.t.editDelay + first.time / tr.timescale : null;
    })
    .filter((s) => s !== null);
  const origin = starts.length ? Math.min(...starts) : 0;
  for (const tr of used) {
    let offset = (tr.t.editDelay - origin) * tr.timescale;
    let previousEnd = null;
    for (const tf of tr.refs) {
      let start;
      if (tf.time === null) {
        start = previousEnd ?? 0;
      } else {
        if (previousEnd !== null) {
          const jump = tf.time + offset - previousEnd;
          if (tf.discontinuity || jump < -0.5 * tr.timescale || jump > 10 * tr.timescale) offset = previousEnd - tf.time;
        }
        start = tf.time + offset;
      }
      tf.newTime = Math.max(0, start);
      previousEnd = tf.newTime + tf.duration;
    }
    tr.duration = previousEnd ?? 0;
  }

  const ordered = fragments
    .map((f, i) => ({ f, i, at: Math.min(...f.trafs.map((tf) => tf.newTime / tf.track.timescale)) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);

  const movieTimescale = used[0].src.init.movieTimescale || 1000;
  const inMovieUnits = (tr) => (tr.duration / tr.timescale) * movieTimescale;
  const movieDuration = Math.max(...used.map(inMovieUnits));
  const traks = used.map((tr) =>
    patchTrak(tr.t.trak, {
      id: tr.newId,
      movieDuration: inMovieUnits(tr),
      mediaDuration: tr.duration,
      fromMovieTimescale: tr.src.init.movieTimescale,
      toMovieTimescale: movieTimescale,
    })
  );
  const mvex = box('mvex', mehd(movieDuration), ...used.map((tr) => patchTrex(tr.t.trex, tr.newId)));
  const head = [ftyp(), box('moov', mvhd(movieTimescale, movieDuration, used.length + 1), ...traks, mvex)];

  const parts = [...head];
  let position = head.reduce((n, p) => n + p.length, 0);
  let sequence = 1;
  for (const { f } of ordered) {
    const moof = f.moof.slice(); // patch a copy
    const view = dv(moof);
    if (f.mfhdPos >= 0) view.setUint32(f.mfhdPos, sequence);
    sequence++;
    for (const tf of f.trafs) {
      view.setUint32(tf.tfhdPos, tf.track.newId);
      if (tf.tfdtPos >= 0) {
        const t = Math.round(tf.newTime);
        if (tf.tfdtVersion === 1) view.setBigUint64(tf.tfdtPos, BigInt(t));
        else if (t <= 0xffffffff) view.setUint32(tf.tfdtPos, t);
      }
      // Absolute data offsets must point to the fragment's new position.
      if (tf.baseOffsetPos >= 0) view.setBigUint64(tf.baseOffsetPos, BigInt(position + tf.baseOffset));
    }
    parts.push(moof, f.media);
    position += moof.length + f.media.size;
  }

  const hasVideo = used.some((tr) => tr.t.handler === 'vide');
  return {
    blob: new Blob(parts, { type: hasVideo ? 'video/mp4' : 'audio/mp4' }),
    hasVideo,
    duration: movieDuration / movieTimescale,
  };
}
