// Generates the PNG app icons used by the web manifest, the desktop shell and
// the Android launcher. Pure Node: no image libraries, no native deps.
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

// Brand: red tile, white "F". Same mark as the in-app `.brand-mark`.
const TILE = [168, 27, 45];
const TILE_TOP = [206, 44, 66];
const WHITE = [247, 247, 250];

function insideRoundedRect(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function insideRect(x, y, rect) {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

/** Draws the Fluenta mark with 3x supersampling for clean edges. */
function paint(size, insetRatio) {
  const ss = 3;
  const total = size * ss;
  const k = total / 512;
  const inset = insetRatio * total;
  const radius = (total - inset * 2) * 0.22;

  // The F, centred on the tile: stem plus two arms.
  const stem = { x0: 186 * k, x1: 236 * k, y0: 132 * k, y1: 380 * k };
  const topArm = { x0: 186 * k, x1: 344 * k, y0: 132 * k, y1: 182 * k };
  const midArm = { x0: 186 * k, x1: 308 * k, y0: 244 * k, y1: 294 * k };
  const shapes = [stem, topArm, midArm];

  const acc = new Float64Array(size * size * 4);
  for (let y = 0; y < total; y += 1) {
    for (let x = 0; x < total; x += 1) {
      if (!insideRoundedRect(x, y, total, inset, radius)) continue;
      let color = y < total * 0.45 ? TILE_TOP : TILE;
      for (const shape of shapes) {
        if (insideRect(x, y, shape)) color = WHITE;
      }
      const i = (Math.floor(y / ss) * size + Math.floor(x / ss)) * 4;
      acc[i] += color[0];
      acc[i + 1] += color[1];
      acc[i + 2] += color[2];
      acc[i + 3] += 255;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const samples = ss * ss;
  for (let i = 0; i < size * size; i += 1) {
    const coverage = acc[i * 4 + 3] / 255;
    if (coverage === 0) continue;
    out[i * 4] = Math.round(acc[i * 4] / coverage);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / coverage);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / coverage);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / samples);
  }
  return encodePng(size, size, out);
}

const targets = [
  ['apps/web/public/icon-192.png', 192, 0.02],
  ['apps/web/public/icon-512.png', 512, 0.02],
  ['apps/web/public/icon-maskable-512.png', 512, 0.1],
  ['apps/desktop/build/icon.png', 512, 0.02],
];

for (const [path, size, inset] of targets) {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, paint(size, inset));
  console.log(`wrote ${path} (${size}px)`);
}
