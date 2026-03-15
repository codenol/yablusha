import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export class PushService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.subsFile = join(dataDir, 'push-subscriptions.json');
    this.vapidFile = join(dataDir, 'vapid-keys.json');
    this._initVapid();
    this.subscriptions = this._loadSubscriptions();
  }

  _initVapid() {
    if (existsSync(this.vapidFile)) {
      this.vapid = JSON.parse(readFileSync(this.vapidFile, 'utf8'));
    } else {
      this.vapid = webpush.generateVAPIDKeys();
      writeFileSync(this.vapidFile, JSON.stringify(this.vapid, null, 2));
      console.log('Generated new VAPID keys');
    }

    webpush.setVapidDetails(
      'mailto:yablusha@localhost',
      this.vapid.publicKey,
      this.vapid.privateKey
    );
  }

  getVapidPublicKey() {
    return this.vapid.publicKey;
  }

  _loadSubscriptions() {
    if (!existsSync(this.subsFile)) return [];
    try { return JSON.parse(readFileSync(this.subsFile, 'utf8')); }
    catch { return []; }
  }

  _saveSubscriptions() {
    writeFileSync(this.subsFile, JSON.stringify(this.subscriptions, null, 2));
  }

  subscribe(subscription) {
    const exists = this.subscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      this.subscriptions.push(subscription);
      this._saveSubscriptions();
    }
  }

  unsubscribe(endpoint) {
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== endpoint);
    this._saveSubscriptions();
  }

  async sendNotification(title, body, data = {}) {
    const payload = JSON.stringify({ title, body, data });
    const dead = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            dead.push(sub.endpoint);
          } else {
            console.error('Push error:', err.message);
          }
        }
      })
    );

    // Remove expired subscriptions
    if (dead.length > 0) {
      this.subscriptions = this.subscriptions.filter(s => !dead.includes(s.endpoint));
      this._saveSubscriptions();
    }
  }
}
