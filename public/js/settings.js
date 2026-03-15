import { api } from './api.js';
import { setPin, disablePin, isPinEnabled } from './auth.js';
import { subscribePush, unsubscribePush, requestNotificationPermission, initPush } from './push.js';
import { showToast } from './app.js';

export async function initSettings(onContactsChanged) {
  // Load current config
  const cfg = await api.getConfig().catch(() => ({}));
  const contacts = await api.getContacts().catch(() => []);

  // Fill fields
  document.getElementById('setting-email').value = cfg.email || '';
  document.getElementById('setting-pin-enabled').checked = isPinEnabled();
  document.getElementById('new-pin').value = '';
  document.getElementById('confirm-pin').value = '';

  // Theme
  const savedTheme = localStorage.getItem('yablusha_theme') || 'auto';
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === savedTheme);
  });

  // PIN toggle visibility
  const pinSetup = document.getElementById('pin-setup');
  pinSetup.classList.toggle('hidden', !isPinEnabled());

  document.getElementById('setting-pin-enabled').addEventListener('change', (e) => {
    pinSetup.classList.toggle('hidden', !e.target.checked);
    if (!e.target.checked) disablePin();
  });

  // Save PIN
  document.getElementById('btn-save-pin').addEventListener('click', async () => {
    const pin = document.getElementById('new-pin').value;
    const confirm = document.getElementById('confirm-pin').value;
    if (pin !== confirm) { showToast('PIN-коды не совпадают'); return; }
    try {
      await setPin(pin);
      showToast('PIN установлен');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Save account
  document.getElementById('btn-save-account').addEventListener('click', async () => {
    const email = document.getElementById('setting-email').value.trim();
    const password = document.getElementById('setting-password').value;
    if (!email) { showToast('Введите email'); return; }
    try {
      await api.saveConfig({ email, password });
      showToast('Сохранено');
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  });

  // Toggle password visibility
  document.getElementById('btn-toggle-password').addEventListener('click', () => {
    const input = document.getElementById('setting-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Theme buttons
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      localStorage.setItem('yablusha_theme', theme);
      document.querySelectorAll('.theme-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTheme(theme);
    });
  });

  // Contacts
  renderContacts(contacts, onContactsChanged);

  // Add contact
  document.getElementById('btn-add-contact').addEventListener('click', async () => {
    const email = document.getElementById('new-contact-email').value.trim();
    const name = document.getElementById('new-contact-name').value.trim();
    if (!email) { showToast('Введите email'); return; }
    try {
      await api.addContact(email, name || email);
      document.getElementById('new-contact-email').value = '';
      document.getElementById('new-contact-name').value = '';
      const updated = await api.getContacts();
      renderContacts(updated, onContactsChanged);
      onContactsChanged(updated);
      showToast('Контакт добавлен');
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  });

  // Push notifications
  const pushStatus = document.getElementById('push-status');
  const pushState = await initPush();

  if (!pushState.supported) {
    pushStatus.textContent = 'Push-уведомления не поддерживаются этим браузером';
    document.getElementById('btn-enable-push').disabled = true;
  } else if (pushState.subscribed) {
    pushStatus.textContent = '✓ Push-уведомления включены';
    document.getElementById('btn-enable-push').textContent = 'Отключить уведомления';
  } else {
    pushStatus.textContent = 'Push-уведомления отключены';
  }

  document.getElementById('btn-enable-push').addEventListener('click', async () => {
    try {
      const state = await initPush();
      if (state.subscribed) {
        await unsubscribePush();
        pushStatus.textContent = 'Push-уведомления отключены';
        document.getElementById('btn-enable-push').textContent = 'Включить push-уведомления';
        showToast('Уведомления отключены');
      } else {
        const perm = await requestNotificationPermission();
        if (perm !== 'granted') {
          showToast('Разрешение на уведомления отклонено');
          return;
        }
        await subscribePush();
        pushStatus.textContent = '✓ Push-уведомления включены';
        document.getElementById('btn-enable-push').textContent = 'Отключить уведомления';
        showToast('Уведомления включены');
      }
    } catch (err) {
      showToast('Ошибка: ' + err.message);
    }
  });
}

function renderContacts(contacts, onChanged) {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  if (!contacts.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Нет контактов</p>';
    return;
  }
  contacts.forEach(c => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `
      <div class="contact-avatar" style="width:36px;height:36px;font-size:14px">${getInitial(c.name || c.email)}</div>
      <div class="contact-item-info">
        <div class="contact-item-name">${escHtml(c.name || c.email)}</div>
        <div class="contact-item-email">${escHtml(c.email)}</div>
      </div>
      <button class="btn-contact-delete" title="Удалить">✕</button>
    `;
    item.querySelector('.btn-contact-delete').addEventListener('click', async () => {
      await api.deleteContact(c.email);
      const updated = await api.getContacts();
      renderContacts(updated, onChanged);
      onChanged(updated);
    });
    list.appendChild(item);
  });
}

export function applyTheme(theme) {
  if (theme === 'auto') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.getElementById('theme-color-meta')?.setAttribute('content', dark ? '#1f2c34' : '#1a7f5a');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('theme-color-meta')?.setAttribute('content', theme === 'dark' ? '#1f2c34' : '#1a7f5a');
  }
}

export function getInitial(name) {
  return (name || '?')[0].toUpperCase();
}

export function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
