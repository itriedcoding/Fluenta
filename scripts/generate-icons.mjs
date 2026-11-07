// Generates every app icon and splash screen used by Fluenta: the web manifest,
// the desktop shell, and the Android launcher/adaptive/splash drawables.
// Pure Node: no image libraries, no native deps.
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Brand: deep red tile, white "F". Same mark as the in-app `.brand-mark`.
const TILE = [160, 27, 45];
const TILE_TOP = [206, 44, 66];
const WHITE = [247, 247, 250];
const BACKDROP = [8, 8, 10];

function insideRoundedRect(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function insideCircle(x, y, size, inset) {
  const r = size / 2 - inset;
  return (x - size / 2) ** 2 + (y - size / 2) ** 2 <= r * r;
}

/** The F geometry on a 512-unit canvas. */
const STEM = { x0: 186, x1: 236, y0: 132, y1: 380 };
const TOP_ARM = { x0: 186, x1: 344, y0: 132, y1: 182 };
const MID_ARM = { x0: 186, x1: 308, y0: 244, y1: 294 };

function insideMark(x, y, size, scale = 1, offsetX = 0, offsetY = 0) {
  const k = (size / 512) * scale;
  const ox = offsetX;
  const oy = offsetY;
  const px = x - ox;
  const py = y - oy;
  const inRect = (rect) => px >= rect.x0 * k && px <= rect.x1 * k && py >= rect.y0 * k && py <= rect.y1 * k;
  return inRect(STEM) || inRect(TOP_ARM) || inRect(MID_ARM);
}

/**
 * Renders an image with supersampling. `shade(x, y)` returns [r, g, b, alpha]
 * with alpha in 0..1, or null for transparency.
 */
function render(width, height, samples, shade) {
  const acc = new Float64Array(width * height * 4);
  const cover = new Float64Array(width * height);
  const perPixel = samples * samples;
  for (let sy = 0; sy < height * samples; sy += 1) {
    const y = (sy + 0.5) / samples;
    for (let sx = 0; sx < width * samples; sx += 1) {
      const x = (sx + 0.5) / samples;
      const color = shade(x, y);
      const index = Math.floor(y) * width + Math.floor(x);
      if (!color) continue;
      const alpha = color[3];
      if (alpha <= 0) continue;
      acc[index * 4] += color[0] * alpha;
      acc[index * 4 + 1] += color[1] * alpha;
      acc[index * 4 + 2] += color[2] * alpha;
      acc[index * 4 + 3] += alpha;
      cover[index] += 1;
    }
  }
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const alpha = acc[i * 4 + 3];
    if (alpha <= 0) continue;
    out[i * 4] = Math.round(acc[i * 4] / alpha);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / alpha);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / alpha);
    out[i * 4 + 3] = Math.round((cover[i] / perPixel) * 255);
  }
  return encodePng(width, height, out);
}

function write(path, buffer) {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
}

/** Full tile icon: gradient rounded square (or circle) with the white mark. */
function tile(size, { shape = 'rounded', insetRatio = 0.02, samples = 3 } = {}) {
  const inset = insetRatio * size;
  const radius = shape === 'circle' ? size / 2 : (size - inset * 2) * 0.22;
  const inside = shape === 'circle' ? (x, y) => insideCircle(x, y, size, inset) : (x, y) => insideRoundedRect(x, y, size, inset, radius);
  return render(size, size, samples, (x, y) => {
    if (!inside(x, y)) return null;
    let color = y < size * 0.45 ? TILE_TOP : TILE;
    if (insideMark(x, y, size)) color = WHITE;
    return [color[0], color[1], color[2], 1];
  });
}

/** Adaptive foreground: transparent canvas with the white mark only. */
function adaptiveForeground(size) {
  return render(size, size, 3, (x, y) => {
    if (!insideMark(x, y, size, 0.52, size * 0.24, size * 0.24)) return null;
    return [WHITE[0], WHITE[1], WHITE[2], 1];
  });
}

/** Splash: dark backdrop with a centred brand tile. */
function splash(width, height) {
  const side = Math.min(width, height) * 0.3;
  const offsetX = (width - side) / 2;
  const offsetY = (height - side) / 2;
  const inset = side * 0.02;
  const radius = (side - inset * 2) * 0.22;
  return render(width, height, 2, (x, y) => {
    const insideTile = insideRoundedRect(x - offsetX, y - offsetY, side, inset, radius);
    if (!insideTile) {
      // Subtle vertical lift so the splash is not a flat black rectangle.
      const lift = Math.round((y / height) * 6);
      return [BACKDROP[0] + lift, BACKDROP[1] + lift, BACKDROP[2] + lift + 1, 1];
    }
    let color = (y - offsetY) < side * 0.45 ? TILE_TOP : TILE;
    if (insideMark(x - offsetX, y - offsetY, side)) color = WHITE;
    return [color[0], color[1], color[2], 1];
  });
}

// ---- web + desktop ---------------------------------------------------------

const webIcons = [
  ['apps/web/public/icon-192.png', 192, 0.02],
  ['apps/web/public/icon-512.png', 512, 0.02],
  ['apps/web/public/icon-maskable-512.png', 512, 0.1],
  ['apps/desktop/build/icon.png', 512, 0.02],
];

for (const [path, size, inset] of webIcons) {
  write(path, tile(size, { insetRatio: inset }));
  console.log(`wrote ${path} (${size}px)`);
}

// ---- Android ---------------------------------------------------------------

const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

const RES = 'apps/android/android/app/src/main/res';

for (const [density, iconSize, foregroundSize] of DENSITIES) {
  write(`${RES}/mipmap-${density}/ic_launcher.png`, tile(iconSize));
  write(`${RES}/mipmap-${density}/ic_launcher_round.png`, tile(iconSize, { shape: 'circle' }));
  write(`${RES}/mipmap-${density}/ic_launcher_foreground.png`, adaptiveForeground(foregroundSize));
  console.log(`wrote Android ${density} launcher icons`);
}

const SPLASHES = [
  ['drawable', 480, 800],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
];

for (const [dir, width, height] of SPLASHES) {
  write(`${RES}/${dir}/splash.png`, splash(width, height));
  console.log(`wrote ${dir}/splash.png (${width}x${height})`);
}

console.log('\nAll icons and splash screens regenerated.');
