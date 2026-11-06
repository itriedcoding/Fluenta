import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run } from '../db.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad, cleanText, intParam } from '../util.ts';
import { PERMISSIONS } from '../permissions.ts';
import { channelAccess, channelAudience, communityRow, type ChannelRow } from '../access.ts';
import { channelPayload, communityAudienceIds, communityPayload } from '../state.ts';
import { channelReaders, fetchChannelMessages, serializeMessages } from '../messages.ts';
import { createMessage, type Scope } from '../messaging.ts';
import { hub } from '../realtime.ts';
import { now } from '../ids.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

function manage(channel: ChannelRow, userId: string) {
  const community = communityRow(channel.community_id);
  if (!community) return false;
  if (community.owner_id === userId) return true;
  const access = channelAccess(channel.id, userId);
  return Boolean(access && (access.permissions & PERMISSIONS.MANAGE_CHANNELS) === PERMISSIONS.MANAGE_CHANNELS);
}

router.get('/:id', (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  return c.json({ channel: channelPayload(access.channel) });
});

router.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  if (!manage(access.channel, auth.user.id)) return bad(c, 'You do not have permission to edit this channel', 403);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(40).optional(),
      topic: z.string().max(200).optional(),
      slowmode: z.number().int().min(0).max(21600).optional(),
      isPrivate: z.boolean().optional(),
      position: z.number().int().min(0).max(1000).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const slug = parsed.data.name
    ? parsed.data.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)
    : null;
  if (parsed.data.name && !slug) return bad(c, 'Channel name needs letters or numbers', 400);
  run(
    `UPDATE channels SET
       name = COALESCE(?, name),
       topic = COALESCE(?, topic),
       slowmode = COALESCE(?, slowmode),
       position = COALESCE(?, position),
       is_private = CASE WHEN ? THEN ? ELSE is_private END
     WHERE id = ?`,
    slug,
    parsed.data.topic !== undefined ? cleanText(parsed.data.topic) : null,
    parsed.data.slowmode ?? null,
    parsed.data.position ?? null,
    parsed.data.isPrivate !== undefined ? 1 : 0,
    parsed.data.isPrivate ? 1 : 0,
    access.channel.id,
  );
  const updated = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', access.channel.id)!;
  hub.broadcast(communityAudienceIds(access.channel.community_id), {
    op: 'community:update',
    community: communityPayload(communityRow(access.channel.community_id)!, auth.user.id),
  });
  return c.json({ channel: channelPayload(updated) });
});

router.delete('/:id', (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  if (!manage(access.channel, auth.user.id)) return bad(c, 'You do not have permission to delete this channel', 403);
  const remaining = all('SELECT id FROM channels WHERE community_id = ?', access.channel.community_id);
  if (remaining.length <= 1) return bad(c, 'Every community needs at least one channel', 400);
  run('DELETE FROM channels WHERE id = ?', access.channel.id);
  hub.broadcast(communityAudienceIds(access.channel.community_id), {
    op: 'community:update',
    community: communityPayload(communityRow(access.channel.community_id)!, auth.user.id),
  });
  return c.json({ ok: true });
});

/** Private-channel membership. */
router.put('/:id/members', async (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  if (!manage(access.channel, auth.user.id)) return bad(c, 'You do not have permission to manage access', 403);
  const parsed = z
    .object({ userId: z.string().min(3), allowed: z.boolean() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const member = get(
    'SELECT 1 AS x FROM community_members WHERE community_id = ? AND user_id = ?',
    access.channel.community_id,
    parsed.data.userId,
  );
  if (!member) return bad(c, 'That user is not a member of this community', 404);
  if (parsed.data.allowed) {
    run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', access.channel.id, parsed.data.userId);
  } else {
    run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', access.channel.id, parsed.data.userId);
  }
  const payload = communityPayload(communityRow(access.channel.community_id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(access.channel.community_id), { op: 'community:update', community: payload });
  return c.json({ ok: true });
});

router.get('/:id/messages', (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  if (access.channel.type !== 'text') return bad(c, 'That channel does not hold messages', 400);
  const limit = intParam(c.req.query('limit'), 50, 1, 100);
  const before = c.req.query('before') ? Number(c.req.query('before')) : null;
  const rows = fetchChannelMessages(access.channel.id, before || null, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(-limit) : rows;
  const messages = serializeMessages(page, {
    viewerId: auth.user.id,
    channelReaders: channelReaders(access.channel.id),
  });
  return c.json({ messages, hasMore });
});

router.post('/:id/messages', async (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  if (access.channel.type !== 'text') return bad(c, 'You cannot send messages here', 400);
  if ((access.permissions & PERMISSIONS.SEND_MESSAGES) !== PERMISSIONS.SEND_MESSAGES) {
    return bad(c, 'You do not have permission to send messages', 403);
  }
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
    channel: access.channel,
    audience: channelAudience(access.channel.id),
    nonce: parsed.data.nonce,
  });
  if (!result.ok) return bad(c, result.error, result.status);
  return c.json({ message: result.message }, 201);
});

router.post('/:id/read', async (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  const ts = now();
  run(
    `INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    access.channel.id,
    auth.user.id,
    ts,
  );
  hub.broadcast(channelAudience(access.channel.id), {
    op: 'read',
    channelId: access.channel.id,
    userId: auth.user.id,
    lastReadAt: ts,
  });
  return c.json({ ok: true, lastReadAt: ts });
});

/** Typing indicators are ephemeral; clients throttle to one every 3 seconds. */
router.post('/:id/typing', (c) => {
  const auth = c.get('auth');
  const access = channelAccess(c.req.param('id'), auth.user.id);
  if (!access) return bad(c, 'Channel not found', 404);
  const user = auth.user;
  const scope: Scope = { channelId: access.channel.id };
  hub.markTyping(`ch:${access.channel.id}`, auth.user.id);
  hub.broadcastRaw(
    channelAudience(access.channel.id),
    JSON.stringify({
      op: 'typing',
      ...scope,
      userId: user.id,
      displayName: user.display_name,
    }),
    auth.user.id,
  );
  return c.json({ ok: true });
});

export default router;
