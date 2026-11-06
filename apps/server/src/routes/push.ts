import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type Env } from '../auth.ts';
import { bad } from '../util.ts';
import { removeSubscription, saveSubscription, vapidPublicKey } from '../push.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

router.get('/key', (c) => c.json({ publicKey: vapidPublicKey() }));

router.post('/subscribe', async (c) => {
  const parsed = z
    .object({
      endpoint: z.string().url().max(500),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  saveSubscription(c.get('auth').user.id, parsed.data, c.req.header('user-agent') ?? null);
  return c.json({ ok: true });
});

router.post('/unsubscribe', async (c) => {
  const parsed = z.object({ endpoint: z.string().url().max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  removeSubscription(parsed.data.endpoint);
  return c.json({ ok: true });
});

export default router;
