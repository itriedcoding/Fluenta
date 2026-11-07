import { Hono } from 'hono';
import { z } from 'zod';
import { get, run } from '../db.ts';
import { config, isGoogleEnabled } from '../config.ts';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  publicUser,
  requireAuth,
  setSessionCookie,
  SESSION_COOKIE,
  type Env,
  type UserRow,
  verifyPassword,
} from '../auth.ts';
import { clientIp, limiter, rateLimit, uniqueName } from '../util.ts';
import { inviteCode, now, randomToken, sha256, uid } from '../ids.ts';
import { bad } from '../util.ts';
import { sendMail } from '../mail.ts';
import { DEFAULT_MEMBER_PERMISSIONS } from '../permissions.ts';
import { badgesFor } from '../badges.ts';
import crypto from 'node:crypto';

const router = new Hono<Env>();

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');

const signupSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const loginSchema = z.object({
  email: z.string().trim().max(200),
  password: z.string().min(1).max(200),
});

function sessionMeta(c: Parameters<typeof clientIp>[0]) {
  return { userAgent: c.req.header('user-agent') ?? null, ip: clientIp(c) };
}

function originFor(c: Parameters<typeof clientIp>[0]) {
  if (config.appOrigin) return config.appOrigin;
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || new URL(c.req.url).protocol.replace(':', '');
  return `${proto}://${c.req.header('host')}`;
}

router.post('/signup', async (c) => {
  if (!config.registrationOpen) return bad(c, 'Registration is closed on this server', 403);
  if (!limiter(c, 'signup', 10, 60 * 60 * 1000)) return bad(c, 'Too many attempts. Try again later.', 429);
  const parsed = signupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const { email, username, displayName, password } = parsed.data;

  if (get('SELECT 1 AS x FROM users WHERE email = ?', email)) {
    return bad(c, 'An account with that email already exists', 409);
  }
  if (get('SELECT 1 AS x FROM users WHERE username = ?', username)) {
    return bad(c, 'That username is taken', 409);
  }

  const id = uid('u_');
  const ts = now();
  const passwordHash = await hashPassword(password);
  run(
    `INSERT INTO users (id, email, username, display_name, password_hash, presence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`,
    id,
    email,
    username,
    displayName,
    passwordHash,
    ts,
    ts,
  );
  const user = get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
  const session = createSession(id, sessionMeta(c));
  setSessionCookie(c, session.token, config.sessionDays * 86400);
  return c.json({ user: { ...publicUser(user), badges: badgesFor(user.id) }, token: session.token }, 201);
});

router.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const { email, password } = parsed.data;
  const ip = clientIp(c);
  // Per-account throttle stops credential stuffing; the per-IP ceiling keeps a
  // single client from spraying many accounts without punishing shared NATs.
  if (!rateLimit(`login-ip:${ip}`, 300, 10 * 60 * 1000)) {
    return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  }
  if (!rateLimit(`login-user:${ip}:${email.toLowerCase()}`, 10, 10 * 60 * 1000)) {
    return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  }

  const user = get<UserRow>('SELECT * FROM users WHERE email = ?', email.toLowerCase());
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) return bad(c, 'Incorrect email or password', 401);

  const session = createSession(user.id, sessionMeta(c));
  setSessionCookie(c, session.token, config.sessionDays * 86400);
  run('UPDATE users SET updated_at = ? WHERE id = ?', now(), user.id);
  return c.json({ user: { ...publicUser(user), badges: badgesFor(user.id) }, token: session.token });
});

router.post('/logout', requireAuth, async (c) => {
  const auth = c.get('auth');
  destroySession(auth.sessionId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

router.get('/me', requireAuth, async (c) => {
  const user = c.get('auth').user;
  return c.json({ user: { ...publicUser(user), badges: badgesFor(user.id) } });
});

router.post('/forgot-password', async (c) => {
  const parsed = z.object({ email: z.string().trim().max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  if (!limiter(c, 'forgot', 5, 15 * 60 * 1000)) return bad(c, 'Too many requests. Try again later.', 429);

  const email = parsed.data.email.toLowerCase();
  const user = get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  let delivered = false;
  if (user) {
    const token = randomToken(32);
    const ts = now();
    run(
      `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      uid('pr_'),
      user.id,
      sha256(token),
      ts,
      ts + 60 * 60 * 1000,
    );
    const link = `${originFor(c)}/reset?token=${token}`;
    const result = await sendMail(
      user.email,
      'Reset your Fluenta password',
      `Use this link within the next hour to choose a new password:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      `<p>Use the link below within the next hour to choose a new password.</p><p><a href="${link}">Reset password</a></p><p>If you didn't request this, you can ignore this email.</p>`,
    );
    delivered = result.delivered;
  }
  return c.json({
    ok: true,
    // Only reflects whether this server can send mail at all, never whether the account exists.
    delivery: delivered ? 'email' : 'unavailable',
  });
});

router.post('/reset-password', async (c) => {
  const parsed = z
    .object({ token: z.string().min(10).max(200), password: z.string().min(8, 'Password must be at least 8 characters').max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  if (!limiter(c, 'reset', 10, 15 * 60 * 1000)) return bad(c, 'Too many attempts. Try again later.', 429);

  const row = get<{ id: string; user_id: string; expires_at: number; used_at: number | null }>(
    'SELECT * FROM password_resets WHERE token_hash = ?',
    sha256(parsed.data.token),
  );
  if (!row || row.used_at || row.expires_at < now()) return bad(c, 'This reset link is invalid or has expired', 400);

  const hash = await hashPassword(parsed.data.password);
  const ts = now();
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, ts, row.user_id);
  run('UPDATE password_resets SET used_at = ? WHERE id = ?', ts, row.id);
  run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
  const session = createSession(row.user_id, sessionMeta(c));
  setSessionCookie(c, session.token, config.sessionDays * 86400);
  return c.json({ ok: true, token: session.token });
});

// ---- Google OAuth ---------------------------------------------------------

const OAUTH_STATE_COOKIE = 'fluenta_oauth_state';

router.get('/google/start', async (c) => {
  if (!isGoogleEnabled()) return bad(c, 'Google sign-in is not configured on this server', 400);
  const state = randomToken(16);
  const redirectUri = `${originFor(c)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  const secure = c.req.header('x-forwarded-proto') === 'https' ? '; Secure' : '';
  c.header(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

router.get('/google/callback', async (c) => {
  if (!isGoogleEnabled()) return bad(c, 'Google sign-in is not configured on this server', 400);
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expectedState = readCookie(c.req.header('cookie'), OAUTH_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.redirect('/?auth=google_failed', 302);
  }
  const redirectUri = `${originFor(c)}/api/auth/google/callback`;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const tokens = (await tokenRes.json()) as { access_token: string };
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) throw new Error(`profile fetch failed: ${profileRes.status}`);
    const profile = (await profileRes.json()) as {
      sub: string;
      email: string;
      email_verified: boolean;
      name?: string;
      picture?: string;
    };
    if (!profile.email) throw new Error('Google account has no email');

    let user = get<UserRow>(
      `SELECT u.* FROM users u JOIN oauth_accounts o ON o.user_id = u.id
       WHERE o.provider = 'google' AND o.provider_id = ?`,
      profile.sub,
    );
    if (!user) {
      user = get<UserRow>('SELECT * FROM users WHERE email = ?', profile.email.toLowerCase());
      if (!user) {
        const ts = now();
        const username = uniqueName(
          profile.email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, ''),
          (candidate) => Boolean(get('SELECT 1 AS x FROM users WHERE username = ?', candidate)),
        );
        const id = uid('u_');
        run(
          `INSERT INTO users (id, email, username, display_name, presence, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'online', ?, ?)`,
          id,
          profile.email.toLowerCase(),
          username,
          (profile.name || username).slice(0, 40),
          ts,
          ts,
        );
        user = get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
      }
      run(
        `INSERT OR IGNORE INTO oauth_accounts (provider, provider_id, user_id, created_at)
         VALUES ('google', ?, ?, ?)`,
        profile.sub,
        user.id,
        now(),
      );
    }
    const session = createSession(user.id, sessionMeta(c));
    const secure = c.req.header('x-forwarded-proto') === 'https' ? '; Secure' : '';
    c.header('Set-Cookie', [
      `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionDays * 86400}${secure}`,
      `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    ].join(', '));
    return c.redirect('/?auth=google_ok', 302);
  } catch (err) {
    console.error('[auth] google callback failed', err);
    return c.redirect('/?auth=google_failed', 302);
  }
});

/** Configuration the client needs in order to render accurate auth options. */
const metaRouter = new Hono();
metaRouter.get('/auth-config', (c) =>
  c.json({
    google: isGoogleEnabled(),
    registrationOpen: config.registrationOpen,
    mail: Boolean(config.smtp.url || config.smtp.host),
  }),
);

router.route('/', metaRouter);

/** Public invite preview used by the welcome screen before someone signs up. */
router.get('/invite-preview/:code', (c) => {
  const code = c.req.param('code');
  const community = get<{
    id: string;
    name: string;
    description: string;
    icon_id: string | null;
  }>('SELECT id, name, description, icon_id FROM communities WHERE invite_code = ?', code);
  if (!community) return bad(c, 'That invite is no longer valid', 404);
  const memberCount = Number(
    get('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', community.id)?.n ?? 0,
  );
  return c.json({
    invite: {
      communityId: community.id,
      name: community.name,
      description: community.description,
      iconUrl: community.icon_id ? `/api/uploads/${community.icon_id}` : null,
      memberCount,
    },
  });
});

export function createDefaultCommunity(userId: string, displayName: string) {
  const id = uid('c_');
  const ts = now();
  const communityName = `${displayName.split(' ')[0]}'s space`.slice(0, 60) || 'My space';
  run(
    'INSERT INTO communities (id, name, description, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    communityName,
    'Your personal space. Invite friends, spin up channels, hang out.',
    userId,
    crypto.randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8),
    ts,
  );
  run(
    'INSERT INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)',
    id,
    userId,
    ts,
  );
  const roleId = uid('r_');
  run(
    `INSERT INTO roles (id, community_id, name, color, permissions, position, is_default, created_at)
     VALUES (?, ?, 'Member', '#c9c9d1', ?, 0, 1, ?)`,
    roleId,
    id,
    DEFAULT_MEMBER_PERMISSIONS,
    ts,
  );
  const generalId = uid('ch_');
  run(
    `INSERT INTO channels (id, community_id, name, type, topic, position, created_at)
     VALUES (?, ?, 'general', 'text', 'Start the conversation', 0, ?)`,
    generalId,
    id,
    ts,
  );
  run(
    `INSERT INTO channels (id, community_id, name, type, topic, position, created_at)
     VALUES (?, ?, 'Lounge', 'voice', '', 1, ?)`,
    uid('ch_'),
    id,
    ts,
  );
  return { communityId: id, channelId: generalId };
}

export { inviteCode };
export default router;
