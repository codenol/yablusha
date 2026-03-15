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
    this.client = null;
    this.connected = false;
    this.pollTimer = null;
    this.messagesDir = join(dataDir, 'messages');
    this.attachDir = join(dataDir, 'attachments');
    this.cache = {}; // { contactEmail: [messages] }
    mkdirSync(this.messagesDir, { recursive: true });
    this._loadCache();
  }

  _cacheFile(contact) {
    return join(this.messagesDir, `${contact.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
  }

  _loadCache() {
    // Load existing cached messages
    this.cache = {};
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
    const msgs = this.cache[contact] || [];
    writeFileSync(this._cacheFile(contact), JSON.stringify(msgs, null, 2));
  }

  _parseMessage(parsed, uid, direction, contact) {
    const from = parsed.from?.value?.[0]?.address || '';
    const to = parsed.to?.value?.[0]?.address || '';
    const date = parsed.date?.toISOString() || new Date().toISOString();
    const bodyText = (parsed.text || '').trim();

    let type = 'text';
    let locationData = null;
    const attachments = [];

    // Detect location
    const locMatch = bodyText.match(LOCATION_RE);
    if (locMatch) {
      type = 'location';
      const lat = parseFloat(locMatch[1]);
      const lon = parseFloat(locMatch[2]);
      locationData = {
        lat, lon,
        mapsUrl: `https://maps.yandex.ru/?pt=${lon},${lat}&z=15&l=map`,
      };
    }

    // Detect photo attachments
    if (parsed.attachments?.length > 0) {
      for (const att of parsed.attachments) {
        if (att.contentType?.startsWith('image/')) {
          if (type === 'text') type = 'photo';
          const attId = uuidv4();
          const attDir = join(this.attachDir, attId);
          mkdirSync(attDir, { recursive: true });
          const filename = att.filename || `image_${attId}.jpg`;
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = join(attDir, safeName);
          try {
            writeFileSync(filePath, att.content);
          } catch (e) {
            console.error('Failed to save attachment:', e.message);
          }
          attachments.push({
            filename: safeName,
            path: `/api/attachments/${attId}/${safeName}`,
            contentType: att.contentType,
          });
        }
      }
    }

    return {
      id: uuidv4(),
      uid,
      from,
      to,
      date,
      type,
      text: bodyText,
      location: locationData,
      attachments,
      direction,
      contact,
    };
  }

  async connect() {
    this.client = new ImapFlow({
      host: 'imap.yandex.ru',
      port: 993,
      secure: true,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
    });

    await this.client.connect();
    this.connected = true;
    console.log('IMAP connected to Yandex Mail');

    // Initial fetch
    await this.fetchAll().catch(console.error);

    // Start polling
    this._startPolling();
  }

  async disconnect() {
    this._stopPolling();
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
    this.connected = false;
  }

  _startPolling() {
    this._stopPolling();
    const interval = this.config.pollInterval || 30000;
    this.pollTimer = setInterval(async () => {
      await this.fetchAll().catch(err => console.error('Poll error:', err.message));
    }, interval);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async fetchAll() {
    if (!this.connected || !this.client) return;
    const contacts = this.config.contacts || [];
    const newMessages = [];

    for (const contact of contacts) {
      const contactEmail = contact.email || contact;
      const msgs = await this._fetchContact(contactEmail).catch(err => {
        console.error(`Fetch error for ${contactEmail}:`, err.message);
        return [];
      });
      newMessages.push(...msgs);
    }

    if (newMessages.length > 0 && this.onNewMessages) {
      this.onNewMessages(newMessages);
    }

    return newMessages;
  }

  async _fetchContact(contactEmail) {
    const existing = this._getContactMessages(contactEmail);
    const existingUids = new Set(existing.map(m => `${m.direction}:${m.uid}`));
    const newMessages = [];

    // Fetch INBOX (incoming from contact)
    try {
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        const messages = this.client.fetch(
          { from: contactEmail },
          { uid: true, envelope: true, source: true }
        );

        for await (const msg of messages) {
          const key = `in:${msg.uid}`;
          if (existingUids.has(key)) continue;

          const parsed = await simpleParser(msg.source);
          const message = await this._parseMessage(parsed, msg.uid, 'in', contactEmail);
          existing.push(message);
          newMessages.push(message);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error('INBOX fetch error:', err.message);
    }

    // Fetch Sent folder (outgoing to contact)
    const sentFolder = await this._findSentFolder();
    if (sentFolder) {
      try {
        const lock = await this.client.getMailboxLock(sentFolder);
        try {
          const messages = this.client.fetch(
            { to: contactEmail },
            { uid: true, envelope: true, source: true }
          );

          for await (const msg of messages) {
            const key = `out:${msg.uid}`;
            if (existingUids.has(key)) continue;

            const parsed = await simpleParser(msg.source);
            const message = await this._parseMessage(parsed, msg.uid, 'out', contactEmail);
            existing.push(message);
            newMessages.push(message);
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        console.error('Sent fetch error:', err.message);
      }
    }

    if (newMessages.length > 0) {
      // Sort all messages by date
      this.cache[contactEmail] = existing.sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );
      this._saveContactMessages(contactEmail);
    }

    return newMessages;
  }

  async _findSentFolder() {
    if (this._sentFolder !== undefined) return this._sentFolder;
    try {
      const list = await this.client.list();
      const sent = list.find(m =>
        m.path.toLowerCase().includes('sent') ||
        m.specialUse === '\\Sent'
      );
      this._sentFolder = sent ? sent.path : null;
      return this._sentFolder;
    } catch {
      this._sentFolder = null;
      return null;
    }
  }

  async getMessages(contactEmail) {
    const msgs = this._getContactMessages(contactEmail);
    return msgs.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  addSentMessage(contactEmail, msg) {
    const msgs = this._getContactMessages(contactEmail);
    // Avoid duplicates by message ID
    if (!msgs.find(m => m.id === msg.id)) {
      msgs.push(msg);
      msgs.sort((a, b) => new Date(a.date) - new Date(b.date));
      this._saveContactMessages(contactEmail);
    }
  }
}
