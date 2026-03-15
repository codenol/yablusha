# YabluSha — PWA Мессенджер через Яндекс.Почту

Мессенджер с mobile-first дизайном, который общается через письма Яндекс.Почты.

## Возможности

- 💬 Отправка текстовых сообщений
- 📍 Геолокация (с открытием в Яндекс.Картах)
- 📷 Фото с камеры и галереи (несколько сразу)
- 😊 Встроенный выбор эмодзи
- 🔔 Push-уведомления (iOS 16.4+, Android)
- 🔢 PIN-код при входе
- 🌙 Тёмная и светлая темы
- PWA — устанавливается на рабочий экран

## Требования

- Node.js 18+
- Аккаунт Яндекс.Почты
- HTTPS (для push-уведомлений и установки PWA)

## Установка

```bash
npm install
node server.js
```

По умолчанию сервер запускается на порту 3000.

## Настройка Яндекс.Почты

1. Включите IMAP в настройках Яндекс.Почты:
   - Почта → Настройки → Почтовые программы → Разрешить доступ

2. Если включена двухфакторная аутентификация, создайте пароль приложения:
   - [https://id.yandex.ru/security/app-passwords](https://id.yandex.ru/security/app-passwords)

3. Откройте приложение и введите email + пароль в настройках

## Настройка HTTPS (обязательно для PWA и push)

### Вариант 1: Nginx + Let's Encrypt (VPS Ubuntu)
```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com

# /etc/nginx/sites-available/yablusha
server {
    listen 443 ssl;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### Вариант 2: Ngrok (быстрый тест дома)
```bash
ngrok http 3000
```

### Вариант 3: Windows (домашний сервер)
Используйте [Caddy](https://caddyserver.com/) — он автоматически получает SSL:
```
# Caddyfile
yourdomain.com {
    reverse_proxy localhost:3000
}
```

## Push-уведомления на iOS

1. Требуется iOS 16.4+
2. Добавьте приложение на рабочий экран:
   - Safari → Поделиться → На экран «Домой»
3. Откройте приложение с рабочего экрана
4. В настройках нажмите «Включить push-уведомления»
5. Разрешите уведомления в появившемся диалоге

## Переменные окружения

```env
PORT=3000
```

Данные аккаунта сохраняются в `data/config.json` (не коммитится в git).

## Структура проекта

```
yablusha/
├── server.js           # Express + WebSocket сервер
├── services/
│   ├── imap.js         # IMAP (получение писем)
│   ├── smtp.js         # SMTP (отправка писем)
│   └── push.js         # Web Push уведомления
├── public/
│   ├── index.html      # SPA
│   ├── manifest.json   # PWA манифест
│   ├── sw.js           # Service Worker
│   ├── css/app.css     # Стили
│   └── js/
│       ├── app.js      # Главный модуль
│       ├── api.js      # API клиент
│       ├── auth.js     # PIN авторизация
│       ├── chat.js     # UI чата
│       ├── push.js     # Push клиент
│       ├── emoji.js    # Выбор эмодзи
│       └── settings.js # Настройки
└── data/               # Создаётся автоматически (не в git)
    ├── config.json     # Конфиг (email, пароль)
    ├── messages/       # Кэш сообщений
    └── attachments/    # Вложения
```

## Запуск как системный сервис (Ubuntu)

```bash
# /etc/systemd/system/yablusha.service
[Unit]
Description=YabluSha Messenger
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/yablusha
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable yablusha
sudo systemctl start yablusha
```
