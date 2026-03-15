import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ImapService } from './services/imap.js';
import { SmtpService } from './services/smtp.js';
import { PushService } from './services/push.js';
import { encrypt, decrypt } from './services/crypto.js';
import { userDb, accountDb, contactDb, pushDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const ATTACH_DIR = join(DATA_DIR, 'attachments');

[DATA_DIR, ATTACH_DIR].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// ─── JWT Secret ───────────────────────────────────────────────────────────────

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = join(DATA_DIR, 'jwt.secret');
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(secretFile, s, { mode: 0o600 });
  console.log('Generated JWT secret → data/jwt.secret');
  return s;
}

const JWT_SECRET = getJwtSecret();

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userId = req.user?.userId || 'tmp';
      const dir = join(ATTACH_DIR, String(userId), req.uploadId || 'tmp');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.use('/api/messages', (req, res, next) => {
  req.uploadId = uuidv4();
  next();
});

// ─── Per-user IMAP/SMTP services ──────────────────────────────────────────────

const userServices = new Map(); // userId → { imap, smtp }
const pushService = new PushService(DATA_DIR);

function broadcastToUser(userId, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.userId === userId) client.send(msg);
  });
}

async function initUserServices(userId) {
  const account = accountDb.get(userId);
  if (!account?.imap_email || !account?.imap_password_enc) return null;

  const existing = userServices.get(userId);
  if (existing?.imap) await existing.imap.disconnect().catch(() => {});

  const password = decrypt(account.imap_password_enc);
  const contacts = contactDb.list(userId).map(c => ({ email: c.contact_email, name: c.contact_name }));

  const cfg = {
    email: account.imap_email,
    password,
    imapHost: account.imap_host,
    imapPort: account.imap_port,
    contacts,
    pollInterval: account.poll_interval,
    encrypt,
    decrypt,
  };

  const userDataDir = join(DATA_DIR, 'users', String(userId));
  mkdirSync(join(userDataDir, 'messages'), { recursive: true });

  const imap = new ImapService(cfg, userDataDir, (newMessages) => {
    broadcastToUser(userId, { type: 'new_messages', messages: newMessages });
    newMessages.filter(m => m.direction === 'in').forEach(m => {
      const body = m.type === 'location' ? '📍 Местоположение' :
        m.type === 'photo' ? '📷 Фото' : (m.text || '').slice(0, 100);
      pushService.sendToUser(pushDb.list(userId), 'YabluSha', body, { contact: m.contact }).catch(() => {});
    });
  });

  await imap.connect().catch(err => console.error(`IMAP error (user ${userId}):`, err.message));

  const smtp = new SmtpService({
    email: account.imap_email,
    password,
    smtpHost: account.smtp_host,
    smtpPort: account.smtp_port,
  });

  userServices.set(userId, { imap, smtp });
  return { imap, smtp };
}

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Требуется авторизация' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен' });
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  const normalEmail = email.trim().toLowerCase();
  if (userDb.findByEmail(normalEmail)) return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
  const hash = await bcrypt.hash(password, 12);
  const userId = userDb.create(normalEmail, hash);
  const token = jwt.sign({ userId, email: normalEmail }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: normalEmail });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  const user = userDb.findByEmail(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email });
});

app.use('/api', requireAuth);

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const { userId } = req.user;
  const account = accountDb.get(userId);
  const svc = userServices.get(userId);
  res.json({
    configured: !!(account?.imap_email && account?.imap_password_enc),
    email: account?.imap_email || '',
    connected: svc?.imap?.connected || false,
  });
});

app.get('/api/config', (req, res) => {
  const account = accountDb.get(req.user.userId) || {};
  res.json({
    email: account.imap_email || '',
    imapHost: account.imap_host || 'imap.yandex.ru',
    imapPort: account.imap_port || 993,
    smtpHost: account.smtp_host || 'smtp.yandex.ru',
    smtpPort: account.smtp_port || 465,
    pollInterval: account.poll_interval || 30000,
    hasPassword: !!account.imap_password_enc,
  });
});

app.post('/api/config', async (req, res) => {
  const { userId } = req.user;
  const { email, password, imapHost, imapPort, smtpHost, smtpPort, pollInterval } = req.body;
  if (!email) return res.status(400).json({ error: 'Email обязателен' });

  const existing = accountDb.get(userId);
  const imapPasswordEnc = password ? encrypt(password) : (existing?.imap_password_enc ?? null);

  accountDb.upsert(userId, {
    imapEmail: email.trim(),
    imapPasswordEnc,
    imapHost: imapHost || 'imap.yandex.ru',
    imapPort: imapPort || 993,
    smtpHost: smtpHost || 'smtp.yandex.ru',
    smtpPort: smtpPort || 465,
    pollInterval: pollInterval || 30000,
  });

  await initUserServices(userId).catch(console.error);
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const contacts = contactDb.list(req.user.userId);
  res.json(contacts.map(c => ({ email: c.contact_email, name: c.contact_name })));
});

app.post('/api/contacts', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email обязателен' });
  contactDb.add(req.user.userId, email.trim(), name || email.trim());
  await initUserServices(req.user.userId).catch(console.error);
  res.json({ ok: true });
});

app.put('/api/contacts/:email', (req, res) => {
  contactDb.update(req.user.userId, req.params.email, req.body.name);
  res.json({ ok: true });
});

app.delete('/api/contacts/:email', async (req, res) => {
  contactDb.remove(req.user.userId, req.params.email);
  await initUserServices(req.user.userId).catch(console.error);
  res.json({ ok: true });
});

app.get('/api/messages/:contact', async (req, res) => {
  const svc = userServices.get(req.user.userId);
  if (!svc?.imap) return res.json([]);
  try {
    res.json(await svc.imap.getMessages(req.params.contact));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', upload.array('attachments', 10), async (req, res) => {
  const { userId } = req.user;
  const svc = userServices.get(userId);
  if (!svc?.smtp) return res.status(503).json({ error: 'Почтовый аккаунт не настроен' });

  const { to, text, locationJson } = req.body;
  if (!to) return res.status(400).json({ error: 'Получатель обязателен' });

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
    const account = accountDb.get(userId);
    const msgId = await svc.smtp.send({ from: account.imap_email, to, text: bodyText, attachments });

    const sentMsg = {
      id: uuidv4(),
      msgId,
      from: account.imap_email,
      to,
      date: new Date().toISOString(),
      type: msgType,
      text: encrypt(bodyText),
      location: (locationJson && msgType === 'location') ? encrypt(locationJson) : null,
      attachments: files.map(f => ({
        filename: f.originalname,
        path: `/api/attachments/${userId}/${req.uploadId}/${f.filename}`,
        contentType: f.mimetype,
      })),
      direction: 'out',
    };

    svc.imap.addSentMessage(to, sentMsg);

    // Broadcast decrypted version to WebSocket
    const broadcastMsg = {
      ...sentMsg,
      text: bodyText,
      location: locationJson ? JSON.parse(locationJson) : null,
    };
    broadcastToUser(userId, { type: 'new_messages', messages: [broadcastMsg] });

    res.json({ ok: true, message: broadcastMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attachments/:userId/:id/:filename', (req, res) => {
  if (String(req.user.userId) !== req.params.userId) return res.status(403).send('Forbidden');
  const filePath = join(ATTACH_DIR, req.params.userId, req.params.id, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.post('/api/refresh', async (req, res) => {
  const svc = userServices.get(req.user.userId);
  if (!svc?.imap) return res.json({ ok: false });
  try {
    await svc.imap.fetchAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: pushService.getVapidPublicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription required' });
  const { endpoint, ...keys } = subscription;
  pushDb.add(req.user.userId, endpoint, JSON.stringify(keys));
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  pushDb.remove(req.user.userId, endpoint);
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'auth') {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          ws.userId = decoded.userId;
          ws.send(JSON.stringify({ type: 'authenticated' }));
        } catch {
          ws.send(JSON.stringify({ type: 'auth_error' }));
        }
      }
    } catch {}
  });
  ws.send(JSON.stringify({ type: 'connected' }));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`YabluSha running on http://localhost:${PORT}`);
  const allUsers = userDb.listAll();
  for (const user of allUsers) {
    await initUserServices(user.id).catch(err =>
      console.error(`Auto-connect failed for user ${user.id}:`, err.message)
    );
  }
});
