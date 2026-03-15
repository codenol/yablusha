import { api } from './api.js';
import { isLoggedIn, saveSession, clearSession, getEmail, getToken } from './auth.js';
import {
  openChat, loadMessages, sendMessage, sendLocation, addFiles,
  toggleEmoji, closeEmoji, toggleAttachMenu, closeAttachMenu,
  autoResizeInput, renderChatList, getCurrentContact,
} from './chat.js';
import { initSettings, applyTheme, escHtml } from './settings.js';

// ─── Theme ────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('yablusha_theme') || 'auto';
  applyTheme(saved);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('yablusha_theme') || 'auto') === 'auto') applyTheme('auto');
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
export function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ─── Views ─────────────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== id));
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────
function initWebSocket(token) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}`;

  let ws;
  let reconnectDelay = 1000;
  let pingInterval = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectDelay = 1000;
      // Authenticate WebSocket connection
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
      // Ping every 30s
      pingInterval = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 30000);
    };

    ws.onmessage = (event) => {
      try { handleWsMessage(JSON.parse(event.data)); } catch {}
    };

    ws.onclose = () => {
      clearInterval(pingInterval);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => ws.close();
  }

  connect();
}

function handleWsMessage(data) {
  if (data.type === 'new_messages') {
    const msgs = data.messages || [];
    const contact = getCurrentContact();

    if (contact && msgs.some(m => m.contact === contact.email)) {
      loadMessages();
    }

    loadChatList();

    if (document.hidden && msgs.length) {
      const m = msgs[0];
      if (m.direction === 'in') {
        const title = 'YabluSha';
        const body = m.type === 'location' ? '📍 Местоположение' :
          m.type === 'photo' ? '📷 Фото' : (m.text || '').slice(0, 100);
        if (Notification.permission === 'granted') {
          new Notification(title, { body, icon: '/icons/icon-192.png' });
        }
      }
    }
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification_click' && event.data.data?.contact) {
      // TODO: navigate to contact
    }
  });
}

// ─── Chat List ────────────────────────────────────────────────────────────────
let contacts = [];

async function loadChatList() {
  contacts = await api.getContacts().catch(() => []);

  const lastMessages = {};
  await Promise.all(contacts.map(async (c) => {
    const email = c.email || c;
    const msgs = await api.getMessages(email).catch(() => []);
    if (msgs.length) lastMessages[email] = msgs[msgs.length - 1];
  }));

  renderChatList(contacts, lastMessages);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function initEventListeners() {
  document.getElementById('btn-settings').addEventListener('click', async () => {
    showView('view-settings');
    await initSettings(async (updated) => {
      contacts = updated;
      await loadChatList();
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    showToast('Обновление...');
    await api.refresh().catch(() => {});
    await loadChatList();
    showToast('Обновлено');
  });

  document.getElementById('btn-new-chat').addEventListener('click', () => {
    document.getElementById('modal-new-chat').classList.remove('hidden');
    document.getElementById('new-chat-email').value = '';
    document.getElementById('new-chat-name').value = '';
  });

  document.getElementById('btn-new-chat-cancel').addEventListener('click', () => {
    document.getElementById('modal-new-chat').classList.add('hidden');
  });

  document.getElementById('btn-new-chat-confirm').addEventListener('click', async () => {
    const email = document.getElementById('new-chat-email').value.trim();
    const name = document.getElementById('new-chat-name').value.trim();
    if (!email) { showToast('Введите email'); return; }
    try {
      await api.addContact(email, name || email);
      document.getElementById('modal-new-chat').classList.add('hidden');
      contacts = await api.getContacts();
      await loadChatList();
      const contact = contacts.find(c => c.email === email);
      if (contact) openChat(contact);
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  });

  document.getElementById('btn-back').addEventListener('click', () => {
    showView('view-chats');
    loadChatList();
  });

  document.getElementById('btn-chat-refresh').addEventListener('click', async () => {
    await api.refresh().catch(() => {});
    await loadMessages();
  });

  const msgInput = document.getElementById('msg-input');

  msgInput.addEventListener('input', () => {
    autoResizeInput(msgInput);
    const hasText = msgInput.value.trim();
    document.getElementById('btn-send').classList.toggle('hidden', !hasText && !document.getElementById('files-preview').children.length);
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  msgInput.addEventListener('focus', () => {
    closeEmoji();
    closeAttachMenu();
  });

  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('btn-emoji').addEventListener('click', (e) => { e.stopPropagation(); toggleEmoji(); });
  document.getElementById('btn-attach').addEventListener('click', (e) => { e.stopPropagation(); toggleAttachMenu(); });
  document.getElementById('btn-location').addEventListener('click', sendLocation);

  document.getElementById('btn-camera').addEventListener('click', () => {
    closeAttachMenu();
    document.getElementById('input-camera').click();
  });

  document.getElementById('btn-gallery').addEventListener('click', () => {
    closeAttachMenu();
    document.getElementById('input-gallery').click();
  });

  document.getElementById('input-camera').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  document.getElementById('input-gallery').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emoji-picker');
    const emojiBtn = document.getElementById('btn-emoji');
    if (!picker.contains(e.target) && e.target !== emojiBtn) closeEmoji();

    const menu = document.getElementById('attach-menu');
    const attachBtn = document.getElementById('btn-attach');
    if (!menu.contains(e.target) && e.target !== attachBtn) closeAttachMenu();
  });

  document.getElementById('btn-settings-back').addEventListener('click', () => {
    showView('view-chats');
    loadChatList();
  });

  document.getElementById('image-viewer-close').addEventListener('click', () => {
    document.getElementById('image-viewer').classList.add('hidden');
  });

  document.getElementById('image-viewer').addEventListener('click', (e) => {
    if (e.target === document.getElementById('image-viewer')) {
      document.getElementById('image-viewer').classList.add('hidden');
    }
  });

  document.getElementById('modal-new-chat').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-new-chat')) {
      document.getElementById('modal-new-chat').classList.add('hidden');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadChatList();
      if (getCurrentContact()) loadMessages();
    }
  });
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────

function initAuthScreen(onSuccess) {
  const screen = document.getElementById('screen-auth');
  screen.classList.remove('hidden');

  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      document.getElementById('form-login').classList.toggle('hidden', !isLogin);
      document.getElementById('form-register').classList.toggle('hidden', isLogin);
    });
  });

  // Password visibility toggles
  document.getElementById('btn-login-toggle-pw').addEventListener('click', () => {
    const input = document.getElementById('login-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('btn-reg-toggle-pw').addEventListener('click', () => {
    const input = document.getElementById('reg-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Login form
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('btn-login');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Входим...';
    try {
      const data = await api.login(email, password);
      saveSession(data.token, data.email);
      screen.classList.add('hidden');
      onSuccess();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });

  // Register form
  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;
    const errEl = document.getElementById('reg-error');
    const btn = document.getElementById('btn-register');
    errEl.classList.add('hidden');
    if (password !== password2) {
      errEl.textContent = 'Пароли не совпадают';
      errEl.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Регистрация...';
    try {
      const data = await api.register(email, password);
      saveSession(data.token, data.email);
      screen.classList.add('hidden');
      onSuccess();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Зарегистрироваться';
    }
  });
}

// ─── Service Worker ────────────────────────────────────────────────────────────
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); }
    catch (err) { console.warn('SW registration failed:', err); }
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  await registerSW();

  function startApp() {
    const mainScreen = document.getElementById('screen-main');
    mainScreen.classList.remove('hidden');
    initEventListeners();
    initWebSocket(getToken());
    loadChatList();

    api.status().then(status => {
      if (!status.configured) {
        showView('view-settings');
        initSettings(async (updated) => {
          contacts = updated;
          await loadChatList();
        });
        showToast('Настройте почтовый аккаунт', 4000);
      } else {
        showView('view-chats');
      }
    }).catch(() => showView('view-chats'));

    const params = new URLSearchParams(location.search);
    const contactEmail = params.get('contact');
    if (contactEmail) {
      api.getContacts().then(cs => {
        const c = cs.find(x => x.email === contactEmail);
        if (c) openChat(c);
      });
    }
  }

  if (isLoggedIn()) {
    startApp();
  } else {
    initAuthScreen(startApp);
  }
}

boot();
