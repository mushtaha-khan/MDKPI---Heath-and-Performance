// Generate a 128x128 brand icon (red background, white "pulse" check) as a valid PNG.
// Run once: node extension/make-icon.cjs
const zlib = require('zlib');
const fs = require('fs');

const S = 128;
const px = Buffer.alloc(S * S * 4);
function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
// Background: rounded red square (#e23744).
const radius = 24;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const inX = x >= radius && x < S - radius;
    const inY = y >= radius && y < S - radius;
    let inside = inX || inY;
    if (!inside) {
      const cx = x < radius ? radius : S - radius;
      const cy = y < radius ? radius : S - radius;
      inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
    }
    if (inside) set(x, y, 0xe2, 0x37, 0x44, 255);
  }
}
// White check mark.
function stroke(x0, y0, x1, y1, w) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) set(x + dx, y + dy, 255, 255, 255, 255);
  }
}
stroke(40, 66, 58, 86, 5);
stroke(58, 86, 92, 42, 5);

// Encode PNG.
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tc = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tc) >>> 0, 0);
  return Buffer.concat([len, tc, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c;
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(__dirname + '/icon.png', png);
console.log('icon.png written', png.length, 'bytes');
