import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOCATION_RE = /📍 (-?\d+\.?\d*),(-?\d+\.?\d*)/;

export class ImapService {
  constructor(config, dataDir, onNewMessages) {
    this.config = config;
    this.dataDir = dataDir;
    this.onNewMessages = onNewMessages;
    this.connected = false;
    this.pollTimer = null;
    this.messagesDir = join(dataDir, 'messages');
    this.attachDir = join(dataDir, 'attachments');
    this.cache = {};
    this._sentFolder = undefined;
    mkdirSync(this.messagesDir, { recursive: true });
  }

  // ─── Cache helpers ──────────────────────────────────────────────────────────

  _cacheFile(contact) {
    return join(this.messagesDir, `${contact.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
  }

  _getContactMessages(contact) {
    if (this.cache[contact]) return this.cache[contact];
    const file = this._cacheFile(contact);
    if (existsSync(file)) {
      try {
        this.cache[contact] = JSON.parse(readFileSync(file, 'utf8'));
        return this.cache[contact];
      } catch {}
    }
    this.cache[contact] = [];
    return this.cache[contact];
  }

  _saveContactMessages(contact) {
    writeFileSync(this._cacheFile(contact), JSON.stringify(this.cache[contact] || [], null, 2));
  }

  // ─── IMAP connection (per-operation, not persistent) ────────────────────────

  async _withClient(fn) {
    const client = new ImapFlow({
      host: this.config.imapHost || 'imap.yandex.ru',
      port: this.config.imapPort || 993,
      secure: true,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
      socketTimeout: 20000,
      connectionTimeout: 15000,
    });

    // Prevent unhandled 'error' event from crashing the process
    client.on('error', (err) => {
      console.error('IMAP client error:', err.message);
    });

    try {
      await client.connect();
      const result = await fn(client);
      await client.logout().catch(() => {});
      return result;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async connect() {
    // Verify credentials with a quick connection test
    await this._withClient(async () => {});
    this.connected = true;
    console.log('IMAP: credentials verified for', this.config.email);

    await this.fetchAll().catch(err => console.error('Initial fetch error:', err.message));
    this._startPolling();
  }

  async disconnect() {
    this._stopPolling();
    this.connected = false;
  }

  _startPolling() {
    this._stopPolling();
    const interval = Math.max(this.config.pollInterval || 30000, 10000);
    this.pollTimer = setInterval(async () => {
      await this.fetchAll().catch(err => console.error('Poll error:', err.message));
    }, interval);
  }

  _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  async fetchAll() {
    const contacts = this.config.contacts || [];
    if (!contacts.length) return [];

    const newMessages = [];
    try {
      await this._withClient(async (client) => {
        // Detect sent folder once per session
        if (this._sentFolder === undefined) {
          this._sentFolder = await this._detectSentFolder(client);
        }

        for (const contact of contacts) {
          const email = contact.email || contact;
          const msgs = await this._fetchContact(client, email).catch(err => {
            console.error(`Fetch error for ${email}:`, err.message);
            return [];
          });
          newMessages.push(...msgs);
        }
      });
    } catch (err) {
      console.error('IMAP fetchAll error:', err.message);
    }

    if (newMessages.length > 0 && this.onNewMessages) {
      this.onNewMessages(newMessages);
    }
    return newMessages;
  }

  async _detectSentFolder(client) {
    try {
      const list = await client.list();
      const sent = list.find(m =>
        m.specialUse === '\\Sent' ||
        m.path.toLowerCase() === 'sent' ||
        m.path.toLowerCase().includes('sent')
      );
      const folder = sent ? sent.path : null;
      console.log('IMAP: sent folder =', folder);
      return folder;
    } catch {
      return null;
    }
  }

  async _fetchContact(client, contactEmail) {
    const existing = this._getContactMessages(contactEmail);
    const existingUids = new Set(existing.map(m => `${m.direction}:${m.uid}`));
    const newMessages = [];

    // Fetch INBOX — emails FROM this contact
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const iter = client.fetch({ from: contactEmail }, { uid: true, source: true });
        for await (const msg of iter) {
          if (existingUids.has(`in:${msg.uid}`)) continue;
          const parsed = await simpleParser(msg.source);
          const message = this._parseMessage(parsed, msg.uid, 'in', contactEmail);
          existing.push(message);
          newMessages.push(message);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      if (!err.message?.includes('No messages')) {
        console.error(`INBOX error (${contactEmail}):`, err.message);
      }
    }

    // Fetch Sent folder — emails TO this contact
    if (this._sentFolder) {
      try {
        const lock = await client.getMailboxLock(this._sentFolder);
        try {
          const iter = client.fetch({ to: contactEmail }, { uid: true, source: true });
          for await (const msg of iter) {
            if (existingUids.has(`out:${msg.uid}`)) continue;
            const parsed = await simpleParser(msg.source);
            const message = this._parseMessage(parsed, msg.uid, 'out', contactEmail);
            existing.push(message);
            newMessages.push(message);
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        if (!err.message?.includes('No messages')) {
          console.error(`Sent error (${contactEmail}):`, err.message);
        }
      }
    }

    if (newMessages.length > 0) {
      this.cache[contactEmail] = existing.sort((a, b) => new Date(a.date) - new Date(b.date));
      this._saveContactMessages(contactEmail);
    }

    return newMessages;
  }

  // ─── Message parsing ────────────────────────────────────────────────────────

  _parseMessage(parsed, uid, direction, contact) {
    const from = parsed.from?.value?.[0]?.address || '';
    const to = parsed.to?.value?.[0]?.address || '';
    const date = parsed.date?.toISOString() || new Date().toISOString();
    const bodyText = (parsed.text || '').trim();

    let type = 'text';
    let locationData = null;
    const attachments = [];

    const locMatch = bodyText.match(LOCATION_RE);
    if (locMatch) {
      type = 'location';
      const lat = parseFloat(locMatch[1]);
      const lon = parseFloat(locMatch[2]);
      locationData = { lat, lon, mapsUrl: `https://maps.yandex.ru/?pt=${lon},${lat}&z=15&l=map` };
    }

    if (parsed.attachments?.length > 0) {
      for (const att of parsed.attachments) {
        if (!att.contentType?.startsWith('image/')) continue;
        if (type === 'text') type = 'photo';
        const attId = uuidv4();
        const attDir = join(this.attachDir, attId);
        mkdirSync(attDir, { recursive: true });
        const safeName = (att.filename || `image.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_');
        try {
          writeFileSync(join(attDir, safeName), att.content);
        } catch (e) {
          console.error('Attachment save error:', e.message);
        }
        attachments.push({
          filename: safeName,
          path: `/api/attachments/${attId}/${safeName}`,
          contentType: att.contentType,
        });
      }
    }

    const textStored = this.config.encrypt ? this.config.encrypt(bodyText) : bodyText;
    const locationStored = (locationData && this.config.encrypt)
      ? this.config.encrypt(JSON.stringify(locationData))
      : locationData;
    return { id: uuidv4(), uid, from, to, date, type, text: textStored, location: locationStored, attachments, direction, contact };
  }

  // ─── Public ─────────────────────────────────────────────────────────────────

  async getMessages(contactEmail) {
    const msgs = this._getContactMessages(contactEmail)
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!this.config.decrypt) return msgs;
    return msgs.map(m => {
      const text = m.text ? this.config.decrypt(m.text) : '';
      let location = m.location;
      if (location && typeof location === 'string') {
        try { location = JSON.parse(this.config.decrypt(location)); } catch { location = null; }
      }
      return { ...m, text, location };
    });
  }

  addSentMessage(contactEmail, msg) {
    const msgs = this._getContactMessages(contactEmail);
    if (!msgs.find(m => m.id === msg.id)) {
      msgs.push(msg);
      msgs.sort((a, b) => new Date(a.date) - new Date(b.date));
      this._saveContactMessages(contactEmail);
    }
  }
}
