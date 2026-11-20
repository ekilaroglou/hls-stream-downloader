// Toolbar icon with a small count in the corner when the page has videos
// (smaller and tidier than Chrome's built-in badge, which covers half the icon).

const SIZES = [16, 32];
const DOT = '#059669';
const bitmaps = new Map();
const drawn = new Map(); // count -> { 16: ImageData, 32: ImageData }

function baseIcon(size) {
  if (!bitmaps.has(size)) {
    const url = chrome.runtime.getURL(`icons/icon${size}.png`);
    bitmaps.set(size, fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b)));
  }
  return bitmaps.get(size);
}

async function draw(size, count) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await baseIcon(size), 0, 0, size, size);
  const s = size / 16;
  const r = 4.25 * s;
  const cx = size - r;
  const cy = size - r;
  // A transparent ring separates the dot from the icon.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.25 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = DOT;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (count <= 9) {
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(7.5 * s)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const text = String(count);
    const m = ctx.measureText(text);
    ctx.fillText(text, cx + 0.15 * s, cy + m.actualBoundingBoxAscent / 2);
  }
  return ctx.getImageData(0, 0, size, size);
}

/** Image data for chrome.action.setIcon: the icon with `count` in a small dot (count > 0). */
export async function iconWithCount(count) {
  if (!drawn.has(count)) {
    const images = await Promise.all(SIZES.map((size) => draw(size, count)));
    drawn.set(count, Object.fromEntries(SIZES.map((size, i) => [size, images[i]])));
  }
  return drawn.get(count);
}

export const PLAIN_ICON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
