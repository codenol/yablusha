import { api } from './api.js';
import { createEmojiPicker } from './emoji.js';
import { showToast } from './app.js';
import { escHtml, getInitial } from './settings.js';

let currentContact = null;
let pendingFiles = [];
let emojiOpen = false;
let attachMenuOpen = false;

export function getCurrentContact() { return currentContact; }

export async function openChat(contact) {
  currentContact = contact;
  const chatView = document.getElementById('view-chat');
  const chatsView = document.getElementById('view-chats');

  // Update header
  document.getElementById('chat-avatar').textContent = getInitial(contact.name || contact.email);
  document.getElementById('chat-contact-name').textContent = contact.name || contact.email;
  document.getElementById('chat-contact-email').textContent = contact.email;

  chatsView.classList.add('hidden');
  chatView.classList.remove('hidden');

  // Clear state
  pendingFiles = [];
  updateFilesPreview();
  document.getElementById('msg-input').value = '';
  updateSendBtn();

  // Load messages
  await loadMessages();
}

export async function loadMessages() {
  if (!currentContact) return;
  const container = document.getElementById('messages-container');

  try {
    const msgs = await api.getMessages(currentContact.email);
    renderMessages(msgs, container);
  } catch (err) {
    console.error('Load messages error:', err);
  }
}

function renderMessages(msgs, container) {
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.innerHTML = '';

  if (!msgs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Нет сообщений</p>
        <p class="empty-hint">Напишите первое сообщение!</p>
      </div>`;
    return;
  }

  let lastDate = null;

  msgs.forEach((msg, i) => {
    const date = new Date(msg.date);
    const dateStr = formatDate(date);

    if (dateStr !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${escHtml(dateStr)}</span>`;
      container.appendChild(sep);
      lastDate = dateStr;
    }

    const group = document.createElement('div');
    group.className = `msg-group ${msg.direction}`;
    group.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (msg.type === 'location' && msg.location) {
      bubble.classList.add('location-bubble');
      bubble.innerHTML = renderLocationBubble(msg);
    } else if (msg.type === 'photo' && msg.attachments?.length) {
      bubble.classList.add('photo-bubble');
      bubble.innerHTML = renderPhotoBubble(msg);
      if (msg.text) {
        const textEl = document.createElement('p');
        textEl.className = 'msg-text';
        textEl.textContent = msg.text;
        bubble.appendChild(textEl);
      }
    } else {
      bubble.classList.add('text-bubble');
      bubble.innerHTML = `<p class="msg-text">${linkify(escHtml(msg.text || ''))}</p>`;
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.innerHTML = `${formatTime(date)}${msg.direction === 'out' ? ' <span class="msg-status">✓✓</span>' : ''}`;

    bubble.appendChild(timeEl);
    group.appendChild(bubble);
    container.appendChild(group);
  });

  // Photo click handlers
  container.querySelectorAll('.photo-thumb').forEach(img => {
    img.addEventListener('click', () => openImageViewer(img.src));
  });

  if (wasAtBottom || msgs.length <= 10) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderLocationBubble(msg) {
  const loc = msg.location;
  return `
    <div class="msg-location">
      <div class="location-map-preview">📍</div>
      <div class="location-info">
        <div>${escHtml(extractAddress(msg.text) || 'Местоположение')}</div>
        <div class="location-coords">${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}</div>
      </div>
      <a href="${escHtml(loc.mapsUrl)}" target="_blank" rel="noopener" class="btn-open-maps">
        Открыть в Яндекс.Картах →
      </a>
    </div>`;
}

function renderPhotoBubble(msg) {
  const count = msg.attachments.length;
  const cls = count === 1 ? 'count-1' : count === 2 ? 'count-2' : count === 3 ? 'count-3' : count === 4 ? 'count-4' : 'count-many';
  const imgs = msg.attachments.slice(0, 4).map((att, i) => {
    const extra = i === 3 && count > 4 ? `<div class="photo-more">+${count - 4}</div>` : '';
    return `<img class="photo-thumb" src="${escHtml(att.path)}" alt="" loading="lazy" />${extra}`;
  }).join('');
  return `<div class="msg-photos ${cls}">${imgs}</div>`;
}

function extractAddress(text) {
  if (!text) return '';
  const lines = text.split('\n');
  return lines.find(l => l && !l.startsWith('📍') && !l.startsWith('http')) || '';
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ─── Send Message ────────────────────────────────────────────────────────────

export async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();

  if (!text && !pendingFiles.length) return;
  if (!currentContact) return;

  const fd = new FormData();
  fd.append('to', currentContact.email);
  if (text) fd.append('text', text);
  pendingFiles.forEach(f => fd.append('attachments', f, f.name));

  input.value = '';
  const savedFiles = [...pendingFiles];
  pendingFiles = [];
  updateFilesPreview();
  updateSendBtn();
  autoResizeInput(input);

  try {
    await api.sendMessage(fd);
    await loadMessages();
  } catch (err) {
    showToast('Ошибка отправки: ' + err.message);
    pendingFiles = savedFiles;
    updateFilesPreview();
  }
}

export async function sendLocation() {
  if (!currentContact) return;
  showToast('Определяем местоположение...');

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    const fd = new FormData();
    fd.append('to', currentContact.email);
    fd.append('locationJson', JSON.stringify({ lat, lon }));

    try {
      await api.sendMessage(fd);
      await loadMessages();
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  }, (err) => {
    showToast('Не удалось получить геолокацию: ' + err.message);
  }, { enableHighAccuracy: true, timeout: 10000 });
}

// ─── File Handling ────────────────────────────────────────────────────────────

export function addFiles(files) {
  const allowed = Array.from(files).filter(f => f.type.startsWith('image/'));
  pendingFiles.push(...allowed);
  updateFilesPreview();
  updateSendBtn();
}

function updateFilesPreview() {
  const preview = document.getElementById('files-preview');
  if (!pendingFiles.length) {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }
  preview.classList.remove('hidden');
  preview.innerHTML = '';
  pendingFiles.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = 'file-preview-item';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-preview-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      updateFilesPreview();
      updateSendBtn();
    });
    item.appendChild(img);
    item.appendChild(removeBtn);
    preview.appendChild(item);
  });
}

// ─── Input & UI ──────────────────────────────────────────────────────────────

function updateSendBtn() {
  const input = document.getElementById('msg-input');
  const hasContent = input.value.trim() || pendingFiles.length;
  document.getElementById('btn-send').classList.toggle('hidden', !hasContent);
}

export function autoResizeInput(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

// ─── Emoji ───────────────────────────────────────────────────────────────────

export function toggleEmoji() {
  const picker = document.getElementById('emoji-picker');
  emojiOpen = !emojiOpen;

  if (emojiOpen) {
    closeAttachMenu();
    picker.classList.remove('hidden');
    createEmojiPicker((emoji) => {
      const input = document.getElementById('msg-input');
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const val = input.value;
      input.value = val.slice(0, start) + emoji + val.slice(end);
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.focus();
      updateSendBtn();
    });
  } else {
    picker.classList.add('hidden');
  }
}

export function closeEmoji() {
  emojiOpen = false;
  document.getElementById('emoji-picker').classList.add('hidden');
}

// ─── Attach Menu ─────────────────────────────────────────────────────────────

export function toggleAttachMenu() {
  attachMenuOpen = !attachMenuOpen;
  if (attachMenuOpen) {
    closeEmoji();
    document.getElementById('attach-menu').classList.remove('hidden');
  } else {
    document.getElementById('attach-menu').classList.add('hidden');
  }
}

export function closeAttachMenu() {
  attachMenuOpen = false;
  document.getElementById('attach-menu').classList.add('hidden');
}

// ─── Image Viewer ─────────────────────────────────────────────────────────────

function openImageViewer(src) {
  const viewer = document.getElementById('image-viewer');
  const img = document.getElementById('image-viewer-img');
  img.src = src;
  viewer.classList.remove('hidden');
}

// ─── Chat List ────────────────────────────────────────────────────────────────

export function renderChatList(contacts, lastMessages = {}) {
  const list = document.getElementById('chat-list');
  const empty = document.getElementById('empty-state');

  if (!contacts.length) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = '';

  contacts.forEach(contact => {
    const email = contact.email || contact;
    const name = contact.name || email;
    const last = lastMessages[email];

    const item = document.createElement('div');
    item.className = 'chat-item';
    item.innerHTML = `
      <div class="contact-avatar">${getInitial(name)}</div>
      <div class="chat-info">
        <div class="chat-name">${escHtml(name)}</div>
        <div class="chat-preview">${last ? escHtml(previewMessage(last)) : escHtml(email)}</div>
      </div>
      <div class="chat-meta">
        <div class="chat-time">${last ? formatTime(new Date(last.date)) : ''}</div>
      </div>
    `;
    item.addEventListener('click', () => openChat(contact));
    list.appendChild(item);
  });
}

function previewMessage(msg) {
  if (msg.type === 'location') return '📍 Местоположение';
  if (msg.type === 'photo') return '📷 Фото';
  return (msg.text || '').slice(0, 60);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const day = 86400000;
  if (diff < day && now.getDate() === date.getDate()) return 'Сегодня';
  if (diff < 2 * day) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function openImageViewer2(src) {
  openImageViewer(src);
}
