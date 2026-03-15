import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'yablusha.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    imap_email TEXT,
    imap_password_enc TEXT,
    imap_host TEXT DEFAULT 'imap.yandex.ru',
    imap_port INTEGER DEFAULT 993,
    smtp_host TEXT DEFAULT 'smtp.yandex.ru',
    smtp_port INTEGER DEFAULT 465,
    poll_interval INTEGER DEFAULT 30000
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    contact_email TEXT NOT NULL,
    contact_name TEXT,
    UNIQUE(user_id, contact_email)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    endpoint TEXT NOT NULL,
    keys_json TEXT,
    UNIQUE(user_id, endpoint)
  );
`);

export { db };

export const userDb = {
  findByEmail: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email),
  findById: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  listAll: () => db.prepare('SELECT * FROM users').all(),
  create: (email, passwordHash) => {
    const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
    return r.lastInsertRowid;
  },
};

export const accountDb = {
  get: (userId) => db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId),
  upsert: (userId, data) => {
    db.prepare(`
      INSERT INTO accounts (user_id, imap_email, imap_password_enc, imap_host, imap_port, smtp_host, smtp_port, poll_interval)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        imap_email = excluded.imap_email,
        imap_password_enc = COALESCE(excluded.imap_password_enc, imap_password_enc),
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        poll_interval = excluded.poll_interval
    `).run(
      userId,
      data.imapEmail ?? null,
      data.imapPasswordEnc ?? null,
      data.imapHost ?? 'imap.yandex.ru',
      data.imapPort ?? 993,
      data.smtpHost ?? 'smtp.yandex.ru',
      data.smtpPort ?? 465,
      data.pollInterval ?? 30000,
    );
  },
};

export const contactDb = {
  list: (userId) => db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(userId),
  add: (userId, email, name) => {
    db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_email, contact_name) VALUES (?, ?, ?)').run(userId, email, name);
  },
  update: (userId, email, name) => {
    db.prepare('UPDATE contacts SET contact_name = ? WHERE user_id = ? AND contact_email = ?').run(name, userId, email);
  },
  remove: (userId, email) => {
    db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_email = ?').run(userId, email);
  },
};

export const pushDb = {
  list: (userId) => db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId),
  add: (userId, endpoint, keysJson) => {
    db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?)').run(userId, endpoint, keysJson);
  },
  remove: (userId, endpoint) => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  },
};
