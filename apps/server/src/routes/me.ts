import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run } from '../db.ts';
import { requireAuth, publicUser, hashPassword, verifyPassword, type Env, type UserRow } from '../auth.ts';
import { bad, cleanText } from '../util.ts';
import { hub } from '../realtime.ts';
import { presenceAudience } from '../access.ts';
import { now } from '../ids.ts';
import { presenceFor } from '../state.ts';

const router = new Hono<Env>();

const statusValues = ['online', 'idle', 'dnd', 'invisible'] as const;

router.use('*', requireAuth);

router.get('/', (c) => {
  const user = c.get('auth').user;
  return c.json({ user: publicUser(user), presence: presenceFor(user.id, user.presence) });
});

router.patch('/', async (c) => {
  const parsed = z
    .object({
      displayName: z.string().trim().min(1).max(40).optional(),
      username: z
        .string()
        .trim()
        .min(3)
        .max(24)
        .regex(/^[a-zA-Z0-9._-]+$/)
        .optional(),
      bio: z.string().max(280).optional(),
      customStatus: z.string().max(120).optional(),
      avatarId: z.string().max(80).nullable().optional(),
      presence: z.enum(statusValues).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  const data = parsed.data;

  if (data.username && data.username.toLowerCase() !== auth.user.username.toLowerCase()) {
    const taken = get('SELECT 1 AS x FROM users WHERE username = ? AND id != ?', data.username, auth.user.id);
    if (taken) return bad(c, 'That username is taken', 409);
  }
  if (data.avatarId && !get('SELECT 1 AS x FROM uploads WHERE id = ? AND owner_id = ?', data.avatarId, auth.user.id)) {
    return bad(c, 'Upload not found', 404);
  }

  run(
    `UPDATE users SET
       display_name = COALESCE(?, display_name),
       username = COALESCE(?, username),
       bio = COALESCE(?, bio),
       custom_status = COALESCE(?, custom_status),
       avatar_id = CASE WHEN ? THEN ? ELSE avatar_id END,
       presence = COALESCE(?, presence),
       updated_at = ?
     WHERE id = ?`,
    data.displayName ?? null,
    data.username ?? null,
    data.bio !== undefined ? cleanText(data.bio) : null,
    data.customStatus !== undefined ? cleanText(data.customStatus) : null,
    data.avatarId !== undefined ? 1 : 0,
    data.avatarId ?? null,
    data.presence ?? null,
    now(),
    auth.user.id,
  );

  const user = get<UserRow>('SELECT * FROM users WHERE id = ?', auth.user.id)!;
  const presence = presenceFor(user.id, user.presence);
  hub.broadcast(presenceAudience(user.id), {
    op: 'profile:update',
    user: { ...publicUser(user), presence },
  });
  return c.json({ user: publicUser(user), presence });
});

router.post('/presence', async (c) => {
  const parsed = z.object({ presence: z.enum(statusValues) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  run('UPDATE users SET presence = ?, updated_at = ? WHERE id = ?', parsed.data.presence, now(), auth.user.id);
  const presence = presenceFor(auth.user.id, parsed.data.presence);
  hub.broadcast(presenceAudience(auth.user.id), {
    op: 'presence',
    userId: auth.user.id,
    presence,
  });
  return c.json({ presence });
});

router.post('/password', async (c) => {
  const parsed = z
    .object({ current: z.string().max(200), next: z.string().min(8, 'Password must be at least 8 characters').max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  if (!(await verifyPassword(parsed.data.current, auth.user.password_hash))) {
    return bad(c, 'Current password is incorrect', 400);
  }
  const hash = await hashPassword(parsed.data.next);
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now(), auth.user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId);
  return c.json({ ok: true });
});

router.get('/sessions', (c) => {
  const auth = c.get('auth');
  const rows = all<{ id: string; user_agent: string | null; ip: string | null; created_at: number; last_seen_at: number }>(
    'SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
    auth.user.id,
  );
  return c.json({
    sessions: rows.map((r) => ({
      id: r.id,
      current: r.id === auth.sessionId,
      userAgent: r.user_agent,
      ip: r.ip,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    })),
  });
});

router.delete('/sessions/:id', (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  if (id === auth.sessionId) return bad(c, 'Use sign out to end the current session', 400);
  run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, auth.user.id);
  return c.json({ ok: true });
});

router.delete('/sessions', (c) => {
  const auth = c.get('auth');
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId);
  return c.json({ ok: true });
});

router.delete('/', (c) => {
  const auth = c.get('auth');
  run('DELETE FROM users WHERE id = ?', auth.user.id);
  return c.json({ ok: true });
});

export default router;
