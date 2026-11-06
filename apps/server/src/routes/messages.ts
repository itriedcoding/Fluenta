import { Hono } from 'hono';
import { z } from 'zod';
import { get } from '../db.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad } from '../util.ts';
import { channelAccess, channelAudience, conversationAccess, conversationAudience } from '../access.ts';
import { PERMISSIONS } from '../permissions.ts';
import { deleteMessage, editMessage, toggleReaction } from '../messaging.ts';
import { hub } from '../realtime.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

type MessageScopeRow = {
  id: string;
  author_id: string;
  channel_id: string | null;
  conversation_id: string | null;
  deleted_at: number | null;
  community_id?: string;
  permissions?: number;
};

function resolve(messageId: string, userId: string) {
  const row = get<MessageScopeRow>('SELECT id, author_id, channel_id, conversation_id, deleted_at FROM messages WHERE id = ?', messageId);
  if (!row) return null;
  if (row.channel_id) {
    const access = channelAccess(row.channel_id, userId);
    if (!access) return null;
    return { row, audience: channelAudience(row.channel_id), canManage: (access.permissions & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES };
  }
  if (row.conversation_id) {
    const conversation = conversationAccess(row.conversation_id, userId);
    if (!conversation) return null;
    return { row, audience: conversationAudience(row.conversation_id), canManage: false };
  }
  return null;
}

router.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const found = resolve(c.req.param('id'), auth.user.id);
  if (!found) return bad(c, 'Message not found', 404);
  const parsed = z.object({ content: z.string().max(4000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const result = editMessage(found.row.id, auth.user.id, parsed.data.content, found.canManage);
  if (result.status !== 200) return bad(c, 'error' in result ? result.error : 'Could not edit message', result.status);
  hub.broadcast(found.audience, { op: 'message:update', message: result.updated });
  return c.json({ message: result.updated });
});

router.delete('/:id', (c) => {
  const auth = c.get('auth');
  const found = resolve(c.req.param('id'), auth.user.id);
  if (!found) return bad(c, 'Message not found', 404);
  const result = deleteMessage(found.row.id, auth.user.id, found.canManage);
  if (result.status !== 200) return bad(c, 'error' in result ? result.error : 'Could not delete message', result.status);
  hub.broadcast(found.audience, { op: 'message:delete', ...result.deleted });
  return c.json({ ok: true });
});

function emojiFromParam(raw: string): string | null {
  const emoji = decodeURIComponent(raw).trim();
  if (!emoji || emoji.length > 32) return null;
  return emoji;
}

router.put('/:id/reactions/:emoji', (c) => {
  const auth = c.get('auth');
  const found = resolve(c.req.param('id'), auth.user.id);
  if (!found) return bad(c, 'Message not found', 404);
  if (found.row.channel_id) {
    const access = channelAccess(found.row.channel_id, auth.user.id);
    if (!access || (access.permissions & PERMISSIONS.ADD_REACTIONS) !== PERMISSIONS.ADD_REACTIONS) {
      return bad(c, 'You do not have permission to react here', 403);
    }
  }
  const emoji = emojiFromParam(c.req.param('emoji'));
  if (!emoji) return bad(c, 'Invalid reaction', 400);
  toggleReaction(found.row.id, auth.user.id, emoji, true);
  hub.broadcast(found.audience, {
    op: 'reaction',
    messageId: found.row.id,
    userId: auth.user.id,
    emoji,
    added: true,
    channelId: found.row.channel_id,
    conversationId: found.row.conversation_id,
  });
  return c.json({ ok: true });
});

router.delete('/:id/reactions/:emoji', (c) => {
  const auth = c.get('auth');
  const found = resolve(c.req.param('id'), auth.user.id);
  if (!found) return bad(c, 'Message not found', 404);
  const emoji = emojiFromParam(c.req.param('emoji'));
  if (!emoji) return bad(c, 'Invalid reaction', 400);
  toggleReaction(found.row.id, auth.user.id, emoji, false);
  hub.broadcast(found.audience, {
    op: 'reaction',
    messageId: found.row.id,
    userId: auth.user.id,
    emoji,
    added: false,
    channelId: found.row.channel_id,
    conversationId: found.row.conversation_id,
  });
  return c.json({ ok: true });
});

export default router;
