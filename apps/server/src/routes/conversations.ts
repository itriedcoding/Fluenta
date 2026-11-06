import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run } from '../db.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad, cleanText, intParam } from '../util.ts';
import { conversationAccess, conversationAudience, type ConversationRow } from '../access.ts';
import { conversationPayload } from '../state.ts';
import { fetchConversationMessages, serializeMessages } from '../messages.ts';
import { createMessage, type Scope } from '../messaging.ts';
import { hub } from '../realtime.ts';
import { now, uid } from '../ids.ts';
import { sharesCommunity } from '../access.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

function memberships(userId: string) {
  return all<{ id: string }>(
    'SELECT conversation_id AS id FROM conversation_members WHERE user_id = ?',
    userId,
  ).map((r) => r.id);
}

router.get('/', (c) => {
  const userId = c.get('auth').user.id;
  const rows = all<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
     WHERE m.user_id = ?
     ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id), c.created_at) DESC`,
    userId,
  );
  return c.json({
    conversations: rows
      .map((r) => conversationPayload(r.id, userId))
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
  });
});

router.post('/', async (c) => {
  const auth = c.get('auth');
  const parsed = z
    .object({
      type: z.enum(['dm', 'group']).default('dm'),
      userIds: z.array(z.string().min(3)).min(1).max(24),
      name: z.string().trim().max(60).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const userIds = [...new Set(parsed.data.userIds)].filter((id) => id !== auth.user.id);
  if (userIds.length === 0) return bad(c, 'Pick at least one other person', 400);
  for (const id of userIds) {
    if (!get('SELECT 1 AS x FROM users WHERE id = ?', id)) return bad(c, 'One of those people no longer exists', 404);
    if (!sharesCommunity(auth.user.id, id)) return bad(c, 'You can only message people you share a community with', 403);
  }

  if (parsed.data.type === 'dm') {
    if (userIds.length !== 1) return bad(c, 'A direct message is between two people', 400);
    const existing = get<{ id: string }>(
      `SELECT c.id FROM conversations c
       WHERE c.type = 'dm'
         AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
         AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)
         AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)`,
      auth.user.id,
      userIds[0],
    );
    if (existing) {
      return c.json({ conversation: conversationPayload(existing.id, auth.user.id), existed: true });
    }
  }

  const id = uid('d_');
  const ts = now();
  run(
    'INSERT INTO conversations (id, type, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    parsed.data.type,
    parsed.data.name ? cleanText(parsed.data.name) : null,
    auth.user.id,
    ts,
  );
  for (const userId of [auth.user.id, ...userIds]) {
    run(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
      id,
      userId,
      ts,
    );
  }
  const payload = conversationPayload(id, auth.user.id);
  for (const userId of [auth.user.id, ...userIds]) {
    hub.send(userId, { op: 'conversation:new', conversation: conversationPayload(id, userId) });
  }
  return c.json({ conversation: payload }, 201);
});

router.get('/:id', (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  return c.json({ conversation: conversationPayload(conversation.id, auth.user.id) });
});

router.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  if (conversation.owner_id !== auth.user.id) return bad(c, 'Only the owner can edit this conversation', 403);
  const parsed = z
    .object({ name: z.string().trim().min(1).max(60).optional(), iconId: z.string().max(80).nullable().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  if (parsed.data.iconId && !get('SELECT 1 AS x FROM uploads WHERE id = ? AND owner_id = ?', parsed.data.iconId, auth.user.id)) {
    return bad(c, 'Upload not found', 404);
  }
  run(
    `UPDATE conversations SET name = COALESCE(?, name), icon_id = CASE WHEN ? THEN ? ELSE icon_id END WHERE id = ?`,
    parsed.data.name ?? null,
    parsed.data.iconId !== undefined ? 1 : 0,
    parsed.data.iconId ?? null,
    conversation.id,
  );
  for (const userId of conversationAudience(conversation.id)) {
    hub.send(userId, { op: 'conversation:update', conversation: conversationPayload(conversation.id, userId) });
  }
  return c.json({ conversation: conversationPayload(conversation.id, auth.user.id) });
});

router.post('/:id/members', async (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  if (conversation.type !== 'group') return bad(c, 'Only group conversations can grow', 400);
  if (conversation.owner_id !== auth.user.id) return bad(c, 'Only the owner can add people', 403);
  const parsed = z.object({ userId: z.string().min(3) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  if (!conversationAccess(conversation.id, parsed.data.userId) && !get('SELECT 1 AS x FROM users WHERE id = ?', parsed.data.userId)) {
    return bad(c, 'That person no longer exists', 404);
  }
  const count = Number(
    get('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?', conversation.id)?.n ?? 0,
  );
  if (count >= 50) return bad(c, 'This group is full', 400);
  run(
    'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
    conversation.id,
    parsed.data.userId,
    now(),
  );
  for (const userId of conversationAudience(conversation.id)) {
    hub.send(userId, { op: 'conversation:update', conversation: conversationPayload(conversation.id, userId) });
  }
  return c.json({ conversation: conversationPayload(conversation.id, auth.user.id) });
});

router.delete('/:id/members/:userId', (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const targetId = c.req.param('userId');
  if (targetId !== auth.user.id && conversation.owner_id !== auth.user.id) {
    return bad(c, 'You cannot remove that person', 403);
  }
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversation.id, targetId);
  hub.send(targetId, { op: 'conversation:remove', conversationId: conversation.id });
  const remaining = conversationAudience(conversation.id);
  if (remaining.length === 0) {
    run('DELETE FROM conversations WHERE id = ?', conversation.id);
  } else {
    for (const userId of remaining) {
      hub.send(userId, { op: 'conversation:update', conversation: conversationPayload(conversation.id, userId) });
    }
  }
  return c.json({ ok: true });
});

router.post('/:id/mute', async (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const parsed = z.object({ muted: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  run(
    'UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?',
    parsed.data.muted ? 1 : 0,
    conversation.id,
    auth.user.id,
  );
  return c.json({ muted: parsed.data.muted });
});

router.get('/:id/messages', (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const limit = intParam(c.req.query('limit'), 50, 1, 100);
  const before = c.req.query('before') ? Number(c.req.query('before')) : null;
  const rows = fetchConversationMessages(conversation.id, before || null, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(-limit) : rows;
  const messages = serializeMessages(page, { viewerId: auth.user.id });
  return c.json({ messages, hasMore });
});

router.post('/:id/messages', async (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const parsed = z
    .object({
      content: z.string().max(4000).default(''),
      replyToId: z.string().max(80).nullable().optional(),
      attachmentIds: z.array(z.string().max(80)).max(5).optional(),
      nonce: z.string().max(60).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const result = createMessage({
    authorId: auth.user.id,
    content: parsed.data.content,
    replyToId: parsed.data.replyToId ?? null,
    attachmentIds: parsed.data.attachmentIds,
    conversation,
    audience: conversationAudience(conversation.id),
    nonce: parsed.data.nonce,
  });
  if (!result.ok) return bad(c, result.error, result.status);
  return c.json({ message: result.message }, 201);
});

router.post('/:id/read', (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const ts = now();
  run(
    'UPDATE conversation_members SET last_read_at = MAX(last_read_at, ?) WHERE conversation_id = ? AND user_id = ?',
    ts,
    conversation.id,
    auth.user.id,
  );
  hub.broadcast(conversationAudience(conversation.id), {
    op: 'read',
    conversationId: conversation.id,
    userId: auth.user.id,
    lastReadAt: ts,
  });
  return c.json({ ok: true, lastReadAt: ts });
});

router.post('/:id/typing', (c) => {
  const auth = c.get('auth');
  const conversation = conversationAccess(c.req.param('id'), auth.user.id);
  if (!conversation) return bad(c, 'Conversation not found', 404);
  const scope: Scope = { conversationId: conversation.id };
  hub.markTyping(`dm:${conversation.id}`, auth.user.id);
  hub.broadcastRaw(
    conversationAudience(conversation.id),
    JSON.stringify({ op: 'typing', ...scope, userId: auth.user.id, displayName: auth.user.display_name }),
    auth.user.id,
  );
  return c.json({ ok: true });
});

export default router;
