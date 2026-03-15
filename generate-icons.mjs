// Pure Node.js PNG generator - no dependencies
// Generates 192x192 and 512x512 PNG icons
import { deflateSync, crc32 } from 'zlib';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function crc32Buf(buf) {
  // Simple CRC32 implementation
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.allocUnsafe(4);
  const crcData = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32Buf(crcData));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPNG(size) {
  // Pixel data: RGBA
  const pixels = new Uint8Array(size * size * 4);

  // Fill background: #1a7f5a (green)
  const bgR = 0x1a, bgG = 0x7f, bgB = 0x5a;

  // Simple circle/rounded rect
  const cx = size / 2, cy = size / 2, r = size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;

      if (dist <= r) {
        pixels[i] = bgR;
        pixels[i+1] = bgG;
        pixels[i+2] = bgB;
        pixels[i+3] = 255;
      } else {
        pixels[i+3] = 0; // transparent
      }
    }
  }

  // Draw letter "Y" - simple pixel font scaled to size
  drawY(pixels, size, 0xff, 0xff, 0xff);

  // Build PNG
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data with filter bytes
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    rawRows.push(0); // filter type None
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      rawRows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }

  const raw = Buffer.from(rawRows);
  const compressed = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawY(pixels, size, r, g, b) {
  // Draw Y using thick lines
  const cx = size / 2;
  const cy = size / 2;
  const thick = Math.max(2, Math.round(size * 0.065));
  const top = size * 0.18;
  const mid = size * 0.45;
  const bottom = size * 0.82;
  const leftX = size * 0.22;
  const rightX = size * 0.78;

  // Left arm: from (leftX, top) to (cx, mid)
  drawLine(pixels, size, leftX, top, cx, mid, thick, r, g, b);
  // Right arm: from (rightX, top) to (cx, mid)
  drawLine(pixels, size, rightX, top, cx, mid, thick, r, g, b);
  // Stem: from (cx, mid) to (cx, bottom)
  drawLine(pixels, size, cx, mid, cx, bottom, thick, r, g, b);
}

function drawLine(pixels, size, x0, y0, x1, y1, thickness, r, g, b) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const steps = Math.max(dx, dy) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = Math.round(x0 + t * (x1 - x0));
    const py = Math.round(y0 + t * (y1 - y0));
    // Draw thick dot
    for (let ty = -thickness; ty <= thickness; ty++) {
      for (let tx = -thickness; tx <= thickness; tx++) {
        if (tx*tx + ty*ty <= thickness*thickness) {
          const nx = px + tx, ny = py + ty;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            const i = (ny * size + nx) * 4;
            if (pixels[i+3] > 0) { // only inside circle
              pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = 255;
            }
          }
        }
      }
    }
  }
}

for (const size of [192, 512]) {
  const png = createPNG(size);
  const outPath = join(__dirname, 'public', 'icons', `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ Created icon-${size}.png (${png.length} bytes)`);
}
