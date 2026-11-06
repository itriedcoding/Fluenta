import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { all, get, run } from './db.ts';
import { config } from './config.ts';
import { now, uid } from './ids.ts';

type Keys = { publicKey: string; privateKey: string };

let keys: Keys | null = null;
let configured = false;

function loadKeys(): Keys {
  if (keys) return keys;
  const file = path.join(config.dataDir, 'vapid.json');
  if (fs.existsSync(file)) {
    keys = JSON.parse(fs.readFileSync(file, 'utf8')) as Keys;
  } else {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log('[push] generated new VAPID key pair');
  }
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || `mailto:no-reply@${new URL(config.appOrigin || 'https://fluenta.local').hostname}`,
      keys.publicKey,
      keys.privateKey,
    );
    configured = true;
  }
  return keys;
}

export function vapidPublicKey(): string {
  return loadKeys().publicKey;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
};

export async function saveSubscription(
  userId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent: string | null,
) {
  run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, user_agent = excluded.user_agent`,
    uid('ps_'),
    userId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    userAgent,
    now(),
  );
}

export function removeSubscription(endpoint: string) {
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
}

export function hasSubscriptions(userId: string): boolean {
  return Boolean(get('SELECT 1 AS x FROM push_subscriptions WHERE user_id = ? LIMIT 1', userId));
}

/** Sends a notification to every registered device of the given users. */
export async function pushToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  if (userIds.length === 0) return 0;
  const ph = userIds.map(() => '?').join(',');
  const subs = all<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ph})`,
    ...userIds,
  );
  if (subs.length === 0) return 0;

  loadKeys();
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 3600 },
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
        } else {
          console.error('[push] delivery failed', status ?? err);
        }
      }
    }),
  );
  return sent;
}
