// Genera los iconos PWA en public/icons sin dependencias externas.
// Diseño: barras blancas ascendentes sobre fondo gris oscuro de marca.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BRAND = [51, 65, 85];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Tres barras ascendentes (crecimiento del capital) centradas en el lienzo.
function coin(x, y, s, scale) {
  const u = (s * scale) / 10;
  const left = s / 2 - 3.5 * u;
  const base = s / 2 + 2.6 * u;
  const bars = [[0, 2.2], [2.5, 3.6], [5, 5.2]];
  return bars.some(([off, h]) => x >= left + off * u && x <= left + (off + 2) * u && y <= base && y >= base - h * u);
}

function roundedSquare(x, y, s, radius) {
  const r = s * radius;
  const dx = Math.max(r - x, x - (s - r), 0);
  const dy = Math.max(r - y, y - (s - r), 0);
  return Math.hypot(dx, dy) <= r;
}

const icon = (radius, scale) => (x, y, s) =>
  !roundedSquare(x, y, s, radius) ? [0, 0, 0, 0] : coin(x, y, s, scale) ? [...WHITE, 255] : [...BRAND, 255];

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, icon(0.22, 1)));
writeFileSync('public/icons/icon-512.png', png(512, icon(0.22, 1)));
writeFileSync('public/icons/maskable-512.png', png(512, icon(0, 0.72)));
writeFileSync('public/icons/apple-touch-icon.png', png(180, icon(0, 0.85)));
writeFileSync('public/icons/badge-72.png', png(72, (x, y, s) => (coin(x, y, s, 1.15) ? [...WHITE, 255] : [0, 0, 0, 0])));
writeFileSync('src/app/icon.png', png(48, icon(0.22, 1)));
console.log('Iconos generados en public/icons');
