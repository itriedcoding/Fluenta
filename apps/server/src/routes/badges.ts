import { Hono } from 'hono';
import { z } from 'zod';
import { badgeCatalog, badgesFor, BADGE_BY_KEY, grantBadge, isFounder, revokeBadge } from '../badges.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad } from '../util.ts';
import { hub } from '../realtime.ts';
import { presenceAudience } from '../access.ts';

const router = new Hono<Env>();

router.use('*', requireAuth);

router.get('/', (c) => {
  const auth = c.get('auth');
  return c.json({
    badges: badgeCatalog(),
    mine: badgesFor(auth.user.id),
    canGrant: isFounder(auth.user.id),
  });
});

router.get('/users/:id', (c) => {
  const id = c.req.param('id');
  return c.json({ userId: id, badges: badgesFor(id) });
});

const grantBody = z.object({ userId: z.string().min(1).max(80) });

function broadcastBadges(userId: string) {
  hub.broadcast(presenceAudience(userId), {
    op: 'badges:update',
    userId,
    badges: badgesFor(userId),
  });
}

router.post('/:key/grant', async (c) => {
  const auth = c.get('auth');
  if (!isFounder(auth.user.id)) return bad(c, 'Only the server founder can grant badges', 403);
  const key = c.req.param('key');
  if (!BADGE_BY_KEY.has(key)) return bad(c, 'Unknown badge', 404);
  const parsed = grantBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  try {
    grantBadge(parsed.data.userId, key, auth.user.id);
  } catch (err) {
    return bad(c, err instanceof Error ? err.message : 'Could not grant that badge', 400);
  }
  broadcastBadges(parsed.data.userId);
  return c.json({ ok: true, badges: badgesFor(parsed.data.userId) });
});

router.delete('/:key/grant/:userId', (c) => {
  const auth = c.get('auth');
  if (!isFounder(auth.user.id)) return bad(c, 'Only the server founder can revoke badges', 403);
  const key = c.req.param('key');
  if (!BADGE_BY_KEY.has(key)) return bad(c, 'Unknown badge', 404);
  try {
    revokeBadge(c.req.param('userId'), key);
  } catch (err) {
    return bad(c, err instanceof Error ? err.message : 'Could not revoke that badge', 400);
  }
  broadcastBadges(c.req.param('userId'));
  return c.json({ ok: true, badges: badgesFor(c.req.param('userId')) });
});

export default router;
