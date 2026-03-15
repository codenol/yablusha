import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

function loadKey() {
  if (process.env.ENCRYPTION_KEY) {
    const k = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    return k;
  }
  const keyFile = join(DATA_DIR, 'server.key');
  if (existsSync(keyFile)) {
    return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  console.log('Generated new encryption key → data/server.key');
  return key;
}

const KEY = loadKey();

export function encrypt(text) {
  if (text === null || text === undefined || text === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('hex'), ct: ct.toString('hex'), tag: tag.toString('hex') });
}

export function decrypt(enc) {
  if (!enc) return '';
  try {
    const { iv, ct, tag } = JSON.parse(enc);
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
