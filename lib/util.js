export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Signed stream URLs often carry their expiry time (unix seconds) in the
// query string under one of these common parameter names.
const EXPIRY_PARAMS = ['expires', 'Expires', 'exp', 'expiry', 'expire', 'validto', 'valid_to'];

export function tokenExpiry(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const name of EXPIRY_PARAMS) {
    const v = u.searchParams.get(name);
    if (v && /^\d{10}$/.test(v)) return Number(v) * 1000;
  }
  const token = u.searchParams.get('hdnts') || u.searchParams.get('__token__');
  const m = token && /(?:^|~)exp=(\d{10})/.exec(token);
  return m ? Number(m[1]) * 1000 : null;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.bandwidth) parts.push(formatBitrate(v.bandwidth));
  return parts.join(' · ') || 'Unknown quality';
}

// Names Windows reserves for devices; Chrome refuses to save "CON.mp4" and the like.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export function sanitizeFilename(name, fallback = 'video') {
  const cleaned = Array.from(
    String(name || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
  )
    .slice(0, 120) // by character, so an emoji isn't cut in half
    .join('')
    .replace(/[.\s]+$/, '');
  if (RESERVED_NAMES.test(cleaned)) return `${cleaned}_`;
  return cleaned || fallback;
}
