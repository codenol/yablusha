import { getToken, clearSession } from './auth.js';

const BASE = '';

async function request(method, path, body, isFormData = false) {
  const opts = { method, headers: {} };

  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;

  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body;
  }

  const res = await fetch(BASE + path, opts);

  if (res.status === 401) {
    clearSession();
    location.reload();
    throw new Error('Сессия истекла');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  register: (email, password) => request('POST', '/auth/register', { email, password }),
  login: (email, password) => request('POST', '/auth/login', { email, password }),

  status: () => request('GET', '/api/status'),
  getConfig: () => request('GET', '/api/config'),
  saveConfig: (data) => request('POST', '/api/config', data),

  getContacts: () => request('GET', '/api/contacts'),
  addContact: (email, name) => request('POST', '/api/contacts', { email, name }),
  updateContact: (email, name) => request('PUT', `/api/contacts/${encodeURIComponent(email)}`, { name }),
  deleteContact: (email) => request('DELETE', `/api/contacts/${encodeURIComponent(email)}`),

  getMessages: (contact) => request('GET', `/api/messages/${encodeURIComponent(contact)}`),
  sendMessage: (formData) => request('POST', '/api/messages', formData, true),

  refresh: () => request('POST', '/api/refresh'),

  getVapidKey: () => request('GET', '/api/push/vapid-key'),
  pushSubscribe: (subscription) => request('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => request('POST', '/api/push/unsubscribe', { endpoint }),
};
