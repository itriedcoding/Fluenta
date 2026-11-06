import fs from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '..');

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  /** Canonical public origin, e.g. https://chat.example.com. Optional: derived from the request when unset. */
  appOrigin: (process.env.APP_ORIGIN || '').replace(/\/$/, ''),
  dataDir: process.env.FLUENTA_DATA_DIR || path.join(serverDir, 'data'),
  publicDir: path.join(serverDir, 'public'),
  maxUploadBytes: Number(process.env.FLUENTA_MAX_UPLOAD_MB || 25) * 1024 * 1024,
  sessionDays: 30,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  smtp: {
    url: process.env.SMTP_URL || '',
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Fluenta <no-reply@fluenta.local>',
  },
  registrationOpen: process.env.FLUENTA_REGISTRATION_OPEN !== 'false',
  trustProxy: process.env.FLUENTA_TRUST_PROXY !== 'false',
};

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const isGoogleEnabled = () =>
  Boolean(config.google.clientId && config.google.clientSecret);

export const isMailEnabled = () =>
  Boolean(config.smtp.url || config.smtp.host);
