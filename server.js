import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { ImapService } from './services/imap.js';
import { SmtpService } from './services/smtp.js';
import { PushService } from './services/push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const ATTACH_DIR = join(DATA_DIR, 'attachments');

// Ensure directories exist
[DATA_DIR, ATTACH_DIR, join(DATA_DIR, 'messages')].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// Default config
const DEFAULT_CONFIG = {
  email: '',
  password: '',
  contacts: [],
  pollInterval: 30000,
};

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = join(ATTACH_DIR, req.uploadId || 'tmp');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Sanitize filename
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// Assign upload ID before multer runs
app.use('/api/messages', (req, res, next) => {
  req.uploadId = uuidv4();
  next();
});

let imapService = null;
let smtpService = null;
const pushService = new PushService(DATA_DIR);

// Broadcast to all WS clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Init services from config
async function initServices() {
  const cfg = loadConfig();
  if (!cfg.email || !cfg.password) return;

  if (imapService) await imapService.disconnect().catch(() => {});
  imapService = new ImapService(cfg, DATA_DIR, (newMessages) => {
    broadcast({ type: 'new_messages', messages: newMessages });
  });
  await imapService.connect().catch(err => console.error('IMAP connect error:', err.message));

  smtpService = new SmtpService(cfg);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  res.json({
    configured: !!(cfg.email && cfg.password),
    email: cfg.email,
    connected: imapService?.connected || false,
  });
});

// Config
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  const { password, ...safe } = cfg;
  res.json({ ...safe, hasPassword: !!password });
});

app.post('/api/config', async (req, res) => {
  const cfg = loadConfig();
  const { email, password, pollInterval } = req.body;
  if (email !== undefined) cfg.email = email.trim();
  if (password !== undefined && password !== '') cfg.password = password;
  if (pollInterval !== undefined) cfg.pollInterval = pollInterval;
  saveConfig(cfg);
  await initServices().catch(console.error);
  res.json({ ok: true });
});

// Contacts
app.get('/api/contacts', (req, res) => {
  const cfg = loadConfig();
  res.json(cfg.contacts || []);
});

app.post('/api/contacts', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const cfg = loadConfig();
  cfg.contacts = cfg.contacts || [];
  const exists = cfg.contacts.find(c => c.email === email);
  if (!exists) cfg.contacts.push({ email: email.trim(), name: name || email.trim() });
  saveConfig(cfg);
  res.json({ ok: true });
});

app.put('/api/contacts/:email', (req, res) => {
  const { name } = req.body;
  const cfg = loadConfig();
  const contact = cfg.contacts?.find(c => c.email === req.params.email);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (name !== undefined) contact.name = name;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete('/api/contacts/:email', (req, res) => {
  const cfg = loadConfig();
  cfg.contacts = (cfg.contacts || []).filter(c => c.email !== req.params.email);
  saveConfig(cfg);
  res.json({ ok: true });
});

// Messages
app.get('/api/messages/:contact', async (req, res) => {
  if (!imapService) return res.json([]);
  try {
    const msgs = await imapService.getMessages(req.params.contact);
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', upload.array('attachments', 10), async (req, res) => {
  if (!smtpService) return res.status(503).json({ error: 'Not configured' });
  const { to, text, locationJson } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient required' });

  const files = req.files || [];
  const attachments = files.map(f => ({ path: f.path, filename: f.originalname }));

  let bodyText = text || '';
  let msgType = 'text';

  if (locationJson) {
    const loc = JSON.parse(locationJson);
    msgType = 'location';
    bodyText = `📍 ${loc.lat},${loc.lon}\n${loc.address || ''}\nhttps://maps.yandex.ru/?pt=${loc.lon},${loc.lat}&z=15&l=map`;
  } else if (files.length > 0) {
    msgType = 'photo';
  }

  try {
    const cfg = loadConfig();
    const msgId = await smtpService.send({
      from: cfg.email,
      to,
      text: bodyText,
      attachments,
    });

    // Save sent message to local cache
    const sentMsg = {
      id: uuidv4(),
      msgId,
      from: cfg.email,
      to,
      date: new Date().toISOString(),
      type: msgType,
      text: bodyText,
      attachments: files.map(f => ({
        filename: f.originalname,
        path: `/api/attachments/${req.uploadId}/${f.filename}`,
        contentType: f.mimetype,
      })),
      direction: 'out',
    };

    if (imapService) imapService.addSentMessage(to, sentMsg);
    broadcast({ type: 'new_messages', messages: [sentMsg] });

    res.json({ ok: true, message: sentMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Attachments
app.get('/api/attachments/:id/:filename', (req, res) => {
  const filePath = join(ATTACH_DIR, req.params.id, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Refresh messages
app.post('/api/refresh', async (req, res) => {
  if (!imapService) return res.json({ ok: false });
  try {
    await imapService.fetchAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Push Notifications ───────────────────────────────────────────────────────

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: pushService.getVapidPublicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription required' });
  pushService.subscribe(subscription);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  pushService.unsubscribe(endpoint);
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });
  ws.send(JSON.stringify({ type: 'connected' }));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`YabluSha running on http://localhost:${PORT}`);
  await initServices().catch(console.error);
});
