import { api } from './api.js';
import { isPinEnabled, initPinScreen } from './auth.js';
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
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}`;

  let ws;
  let reconnectDelay = 1000;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectDelay = 1000;
      // Ping every 30s to keep alive
      setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch {}
    };

    ws.onclose = () => {
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

    // Reload current chat if message belongs to it
    if (contact && msgs.some(m => m.contact === contact.email)) {
      loadMessages();
    }

    // Refresh chat list
    loadChatList();

    // Show notification if app is in background
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

// Service Worker notification click
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

  // Fetch last messages for each contact
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
  // Chats view
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

  // Chat view
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

  document.getElementById('btn-emoji').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEmoji();
  });

  document.getElementById('btn-attach').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAttachMenu();
  });

  document.getElementById('btn-location').addEventListener('click', sendLocation);

  document.getElementById('btn-camera').addEventListener('click', () => {
    closeAttachMenu();
    document.getElementById('input-camera').click();
  });

  document.getElementById('btn-gallery').addEventListener('click', () => {
    closeAttachMenu();
    document.getElementById('input-gallery').click();
  });

  document.getElementById('input-camera').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('input-gallery').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  // Close overlays on outside click
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emoji-picker');
    const emojiBtn = document.getElementById('btn-emoji');
    if (!picker.contains(e.target) && e.target !== emojiBtn) closeEmoji();

    const menu = document.getElementById('attach-menu');
    const attachBtn = document.getElementById('btn-attach');
    if (!menu.contains(e.target) && e.target !== attachBtn) closeAttachMenu();
  });

  // Settings back
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    showView('view-chats');
    loadChatList();
  });

  // Image viewer close
  document.getElementById('image-viewer-close').addEventListener('click', () => {
    document.getElementById('image-viewer').classList.add('hidden');
  });

  document.getElementById('image-viewer').addEventListener('click', (e) => {
    if (e.target === document.getElementById('image-viewer')) {
      document.getElementById('image-viewer').classList.add('hidden');
    }
  });

  // Modal overlay click
  document.getElementById('modal-new-chat').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-new-chat')) {
      document.getElementById('modal-new-chat').classList.add('hidden');
    }
  });

  // Visibility change - refresh when app becomes visible
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadChatList();
      if (getCurrentContact()) loadMessages();
    }
  });
}

// ─── Service Worker Registration ──────────────────────────────────────────────
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  await registerSW();

  const mainScreen = document.getElementById('screen-main');
  const pinScreen = document.getElementById('screen-pin');

  function startApp() {
    mainScreen.classList.remove('hidden');
    initEventListeners();
    initWebSocket();
    loadChatList();

    // Check if configured
    api.status().then(status => {
      if (!status.configured) {
        showView('view-settings');
        initSettings(async (updated) => {
          contacts = updated;
          await loadChatList();
        });
        showToast('Настройте аккаунт Яндекс.Почты', 4000);
      } else {
        showView('view-chats');
      }
    }).catch(() => {
      showView('view-chats');
    });

    // Handle URL params (e.g. from push notification click)
    const params = new URLSearchParams(location.search);
    const contactEmail = params.get('contact');
    if (contactEmail) {
      api.getContacts().then(cs => {
        const c = cs.find(x => x.email === contactEmail);
        if (c) openChat(c);
      });
    }
  }

  if (isPinEnabled()) {
    pinScreen.classList.remove('hidden');
    initPinScreen(startApp);
  } else {
    startApp();
  }
}

boot();
