#!/usr/bin/env node
// Run: node generate-icons.js
// Requires: npm install canvas (or sharp)
// Creates PNG icons for PWA

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.2;

  // Background
  ctx.fillStyle = '#1a7f5a';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // Letter Y
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size * 0.55}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Y', size / 2, size / 2);

  return canvas.toBuffer('image/png');
}

[192, 512].forEach(size => {
  const buf = generateIcon(size);
  const path = join(__dirname, 'public', 'icons', `icon-${size}.png`);
  writeFileSync(path, buf);
  console.log(`Created ${path}`);
});
