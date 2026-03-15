const PIN_HASH_KEY = 'yablusha_pin_hash';
const PIN_ENABLED_KEY = 'yablusha_pin_enabled';
const LOCK_KEY = 'yablusha_locked_until';
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60000;
let attempts_key = 'yablusha_pin_attempts';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isPinEnabled() {
  return localStorage.getItem(PIN_ENABLED_KEY) === '1' && !!localStorage.getItem(PIN_HASH_KEY);
}

export async function setPin(pin) {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN должен быть 4 цифры');
  const hash = await sha256(pin);
  localStorage.setItem(PIN_HASH_KEY, hash);
  localStorage.setItem(PIN_ENABLED_KEY, '1');
}

export function disablePin() {
  localStorage.removeItem(PIN_HASH_KEY);
  localStorage.setItem(PIN_ENABLED_KEY, '0');
}

export async function verifyPin(pin) {
  const lockedUntil = parseInt(localStorage.getItem(LOCK_KEY) || '0');
  if (Date.now() < lockedUntil) {
    const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
    throw new Error(`Слишком много попыток. Подождите ${secs} сек.`);
  }

  const stored = localStorage.getItem(PIN_HASH_KEY);
  if (!stored) return true;

  const hash = await sha256(pin);
  if (hash === stored) {
    localStorage.removeItem(attempts_key);
    localStorage.removeItem(LOCK_KEY);
    return true;
  }

  const attempts = (parseInt(localStorage.getItem(attempts_key) || '0')) + 1;
  localStorage.setItem(attempts_key, String(attempts));

  if (attempts >= MAX_ATTEMPTS) {
    localStorage.setItem(LOCK_KEY, String(Date.now() + LOCKOUT_MS));
    localStorage.removeItem(attempts_key);
    throw new Error(`Слишком много попыток. Подождите 1 минуту`);
  }

  return false;
}

export function initPinScreen(onSuccess) {
  const screen = document.getElementById('screen-pin');
  const dots = [0, 1, 2, 3].map(i => document.getElementById(`dot-${i}`));
  const keys = document.querySelectorAll('.pin-key[data-digit]');
  const backBtn = document.getElementById('pin-back');
  const subtitle = document.getElementById('pin-subtitle');
  const errorEl = document.getElementById('pin-error');
  let current = '';

  function updateDots() {
    dots.forEach((d, i) => d.classList.toggle('filled', i < current.length));
  }

  async function submit() {
    const pin = current;
    current = '';
    updateDots();

    try {
      const ok = await verifyPin(pin);
      if (ok) {
        screen.classList.add('hidden');
        onSuccess();
      } else {
        errorEl.classList.remove('hidden');
        setTimeout(() => errorEl.classList.add('hidden'), 2000);
        // shake animation
        const cont = document.querySelector('.pin-dots');
        cont.style.animation = 'none';
        cont.offsetHeight;
        cont.style.animation = 'shake 0.4s ease';
      }
    } catch (err) {
      subtitle.textContent = err.message;
      subtitle.style.color = '#e74c3c';
    }
  }

  keys.forEach(key => {
    key.addEventListener('click', () => {
      if (current.length >= 4) return;
      current += key.dataset.digit;
      updateDots();
      if (current.length === 4) setTimeout(submit, 100);
    });
  });

  backBtn.addEventListener('click', () => {
    current = current.slice(0, -1);
    updateDots();
  });

  // Add shake keyframe
  const style = document.createElement('style');
  style.textContent = `@keyframes shake {
    0%,100%{transform:translateX(0)}
    20%{transform:translateX(-8px)}
    40%{transform:translateX(8px)}
    60%{transform:translateX(-6px)}
    80%{transform:translateX(6px)}
  }`;
  document.head.appendChild(style);

  updateDots();
}
