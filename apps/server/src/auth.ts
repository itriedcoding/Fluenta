import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Context, Next } from 'hono';
import { and, eq } from './sql.ts';
import { get, run } from './db.ts';
import { config } from './config.ts';
import { now, randomToken, sha256, uid } from './ids.ts';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export type UserRow = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  avatar_id: string | null;
  bio: string | null;
  custom_status: string | null;
  presence: string;
  created_at: number;
  updated_at: number;
};

export type AuthCtx = {
  user: UserRow;
  sessionId: string;
  token: string;
};

export type Env = { Variables: { auth: AuthCtx } };

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_id ? `/api/uploads/${row.avatar_id}` : null,
    bio: row.bio,
    customStatus: row.custom_status,
    presence: row.presence,
    createdAt: row.created_at,
    email: row.email,
  };
}

export type SessionInfo = { userAgent: string | null; ip: string | null };

export function createSession(userId: string, info: SessionInfo) {
  const token = randomToken(32);
  const id = uid('s_');
  const ts = now();
  const expiresAt = ts + config.sessionDays * 86_400_000;
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    sha256(token),
    info.userAgent?.slice(0, 300) ?? null,
    info.ip ?? null,
    ts,
    ts,
    expiresAt,
  );
  return { id, token, expiresAt };
}

export function findSession(token: string) {
  const row = get<{
    session_id: string;
    expires_at: number;
    id: string;
    email: string;
    username: string;
    display_name: string;
    password_hash: string | null;
    avatar_id: string | null;
    bio: string | null;
    custom_status: string | null;
    presence: string;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT s.id AS session_id, s.expires_at, u.*
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row) return null;
  if (row.expires_at < now()) {
    run('DELETE FROM sessions WHERE id = ?', row.session_id);
    return null;
  }
  const { session_id, expires_at, ...user } = row;
  return { sessionId: session_id, expiresAt: expires_at, user: user as UserRow };
}

export function destroySession(sessionId: string) {
  run('DELETE FROM sessions WHERE id = ?', sessionId);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'fluenta_session';

export function requestToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return parseCookies(c.req.header('cookie'))[SESSION_COOKIE] ?? null;
}

export function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim();
  if (proto) return proto === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, token: string, maxAgeSeconds: number) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(c)) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(c: Context) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps(c)) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '));
}

/** Loads the session for the request, if any. */
export async function attachAuth(c: Context, next: Next) {
  const token = requestToken(c);
  if (token) {
    const session = findSession(token);
    if (session) {
      run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), session.sessionId);
      c.set('auth', { user: session.user, sessionId: session.sessionId, token } satisfies AuthCtx);
      await next();
      return;
    }
  }
  await next();
}

export async function requireAuth(c: Context, next: Next) {
  if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
  await next();
}

/**
 * Blocks cross-site requests that rely on the ambient session cookie.
 * Bearer-token clients (desktop/mobile) are immune to CSRF and skip the check.
 */
export async function sameOriginGuard(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return next();
  if (!c.get('auth')) return next();

  const origin = c.req.header('origin');
  if (origin) {
    const expected = config.appOrigin || `${isHttps(c) ? 'https' : 'http'}://${c.req.header('host')}`;
    if (origin.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
  }
  await next();
}

export function sessionCleanup() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', now());
}

export { and, eq };
