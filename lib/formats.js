// Recognises the format of HLS media segments and decides how they can be saved.
import { looksLikeMp4 } from './mp4.js';

// MPEG-TS stream types (ISO 13818-1 and common private ones).
const H264 = 0x1b;
const AAC_ADTS = 0x0f;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x20, 0x24, 0x42, 0xd1, 0xea]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x1c, 0x81, 0x82, 0x83, 0x84, 0x85, 0x87, 0x8a]);
// Descriptors that mark a "private data" (0x06) stream as audio: AC-3, E-AC-3, DTS, AAC.
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b, 0x7c]);
const AUDIO_REGISTRATIONS = new Set(['AC-3', 'EAC3', 'DTS1', 'DTS2', 'DTS3', 'Opus']);

/** Lists the elementary streams announced in the first PMT of a TS segment, or null. */
export function tsStreams(bytes) {
  let pmtPid = -1;
  for (let off = 0; off + 188 <= bytes.length; off += 188) {
    if (bytes[off] !== 0x47) return null;
    const unitStart = (bytes[off + 1] & 0x40) !== 0;
    const pid = ((bytes[off + 1] & 0x1f) << 8) | bytes[off + 2];
    const adaptation = (bytes[off + 3] & 0x30) >> 4;
    if (!unitStart || adaptation === 2) continue;
    let p = off + 4;
    if (adaptation === 3) p += 1 + bytes[p];
    p += 1 + bytes[p]; // pointer field
    if (p + 12 > off + 188) continue;
    const sectionEnd = Math.min(off + 188, p + 3 + (((bytes[p + 1] & 0x0f) << 8) | bytes[p + 2]) - 4);
    if (pid === 0 && bytes[p] === 0x00) {
      for (let q = p + 8; q + 4 <= sectionEnd; q += 4) {
        const program = (bytes[q] << 8) | bytes[q + 1];
        if (program !== 0) {
          pmtPid = ((bytes[q + 2] & 0x1f) << 8) | bytes[q + 3];
          break;
        }
      }
    } else if (pid === pmtPid && bytes[p] === 0x02) {
      const streams = [];
      const infoLength = ((bytes[p + 10] & 0x0f) << 8) | bytes[p + 11];
      for (let q = p + 12 + infoLength; q + 5 <= sectionEnd; ) {
        const type = bytes[q];
        const esLength = ((bytes[q + 3] & 0x0f) << 8) | bytes[q + 4];
        let audio = AUDIO_TYPES.has(type);
        for (let d = q + 5; d + 2 <= q + 5 + esLength; d += 2 + bytes[d + 1]) {
          const tag = bytes[d];
          if (type === 0x06 && AUDIO_DESCRIPTORS.has(tag)) audio = true;
          if (type === 0x06 && tag === 0x05 && bytes[d + 1] >= 4) {
            const id = String.fromCharCode(bytes[d + 2], bytes[d + 3], bytes[d + 4], bytes[d + 5]);
            if (AUDIO_REGISTRATIONS.has(id)) audio = true;
          }
        }
        streams.push({ type, audio, video: VIDEO_TYPES.has(type) });
        q += 5 + esLength;
      }
      return streams;
    }
  }
  return null;
}

// mux.js converts TS to MP4 only for H.264 video and AAC audio.
function muxjsCanConvert(streams) {
  const media = streams.filter((s) => s.audio || s.video);
  return media.length > 0 && media.every((s) => s.type === H264 || s.type === AAC_ADTS);
}

function skipId3(b) {
  let p = 0;
  while (p + 10 <= b.length && b[p] === 0x49 && b[p + 1] === 0x44 && b[p + 2] === 0x33) {
    const size = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
    p += 10 + size + (b[p + 5] & 0x10 ? 10 : 0);
  }
  return p;
}

/**
 * How a segment can be saved:
 *  - { kind: 'fmp4' }  fragmented MP4: merged and saved as MP4
 *  - { kind: 'mux' }   TS (H.264/AAC) or packed AAC: converted to MP4 with mux.js
 *  - { kind: 'raw' }   anything else: segments joined as they are
 * `ext`/`mime` describe the file when the segments are saved as they are.
 */
export function sniffSegment(bytes, hasInitSegment) {
  if (hasInitSegment || looksLikeMp4(bytes)) return { kind: 'fmp4', ext: 'mp4', mime: 'video/mp4' };
  if (bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47)) {
    const streams = tsStreams(bytes);
    return { kind: streams && muxjsCanConvert(streams) ? 'mux' : 'raw', ext: 'ts', mime: 'video/mp2t' };
  }
  const p = skipId3(bytes);
  if (bytes[p] === 0xff && (bytes[p + 1] & 0xf6) === 0xf0) return { kind: 'mux', ext: 'aac', mime: 'audio/aac' };
  if (bytes[p] === 0xff && (bytes[p + 1] & 0xe0) === 0xe0) return { kind: 'raw', ext: 'mp3', mime: 'audio/mpeg' };
  if (bytes[p] === 0x0b && bytes[p + 1] === 0x77) {
    const eac3 = (bytes[p + 5] >> 3) > 10;
    return { kind: 'raw', ext: eac3 ? 'eac3' : 'ac3', mime: eac3 ? 'audio/eac3' : 'audio/ac3' };
  }
  return { kind: 'raw', ext: 'bin', mime: 'application/octet-stream' };
}
