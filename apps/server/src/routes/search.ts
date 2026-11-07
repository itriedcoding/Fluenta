import { Hono } from 'hono';
import { all, get } from '../db.ts';
import { requireAuth, publicUser, type Env, type UserRow } from '../auth.ts';
import { bad, intParam } from '../util.ts';
import { channelAccess, effectivePermissions } from '../access.ts';
import { PERMISSIONS } from '../permissions.ts';
import { presenceFor } from '../state.ts';
import { fetchMessageRow, serializeMessages } from '../messages.ts';
import { badgesForUsers } from '../badges.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

type FtsHit = { message_id: string; snippet: string; rank: number };

function ftsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["'*^:()\-]/g, '').trim())
    .filter((t) => t.length > 1)
    .slice(0, 8);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"*`).join(' ');
}

router.get('/', (c) => {
  const auth = c.get('auth');
  const userId = auth.user.id;
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ messages: [], users: [], channels: [], communities: [] });
  const limit = intParam(c.req.query('limit'), 8, 1, 25);

  // --- messages: FTS5 for ranked text search, scoped to accessible rooms ---
  const communityRows = all<{ community_id: string }>(
    'SELECT community_id FROM community_members WHERE user_id = ?',
    userId,
  );
  const accessibleChannels: { id: string; name: string; communityId: string; communityName: string }[] = [];
  for (const { community_id } of communityRows) {
    const community = get<{ name: string }>('SELECT name FROM communities WHERE id = ?', community_id);
    const perms = effectivePermissions(community_id, userId);
    const canManage = (perms & PERMISSIONS.MANAGE_CHANNELS) === PERMISSIONS.MANAGE_CHANNELS;
    const allowed = new Set(
      all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE user_id = ?', userId).map(
        (r) => r.channel_id,
      ),
    );
    const channels = all<{ id: string; name: string; is_private: number }>(
      'SELECT id, name, is_private FROM channels WHERE community_id = ? AND type = ?',
      community_id,
      'text',
    );
    for (const ch of channels) {
      if (ch.is_private && !allowed.has(ch.id) && !canManage) continue;
      accessibleChannels.push({ id: ch.id, name: ch.name, communityId: community_id, communityName: community?.name ?? '' });
    }
  }
  const accessibleConversations = all<{ id: string; name: string | null; type: string }>(
    `SELECT c.id, c.name, c.type FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id WHERE m.user_id = ?`,
    userId,
  );

  let messageResults: unknown[] = [];
  const match = ftsQuery(q);
  if (match && accessibleChannels.length > 0) {
    const hits = all<FtsHit>(
      `SELECT f.message_id, snippet(messages_fts, 1, char(1), char(2), '…', 18) AS snippet, bm25(messages_fts) AS rank
       FROM messages_fts f
       JOIN messages m ON m.id = f.message_id
       WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND m.channel_id IS NOT NULL
       ORDER BY rank LIMIT 120`,
      match,
    );
    const allowedSet = new Map(accessibleChannels.map((ch) => [ch.id, ch]));
    const relevant = hits.filter((h) => {
      const row = fetchMessageRow(h.message_id);
      return Boolean(row?.channel_id && allowedSet.has(row.channel_id));
    });
    const chosen = relevant.slice(0, limit);
    const rows = chosen.map((h) => fetchMessageRow(h.message_id)!).filter(Boolean);
    const serialized = serializeMessages(rows, { viewerId: userId });
    messageResults = serialized.map((message, index) => {
      const row = rows[index];
      const channel = allowedSet.get(row.channel_id!)!;
      return {
        ...message,
        snippet: chosen[index].snippet,
        context: {
          type: 'channel',
          channelId: channel.id,
          channelName: channel.name,
          communityId: channel.communityId,
          communityName: channel.communityName,
        },
      };
    });
  }

  // --- users (only people you share a space with) ---
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const userRows = all<UserRow & { shared: number }>(
    `SELECT DISTINCT u.* FROM users u
     WHERE (u.username LIKE ? OR u.display_name LIKE ?)
       AND (
         u.id = ?
         OR EXISTS (
           SELECT 1 FROM community_members a JOIN community_members b ON a.community_id = b.community_id
           WHERE a.user_id = ? AND b.user_id = u.id
         )
         OR EXISTS (
           SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id = b.conversation_id
           WHERE a.user_id = ? AND b.user_id = u.id
         )
       )
     LIMIT ?`,
    like,
    like,
    userId,
    userId,
    userId,
    limit,
  );

  // --- channels ---
  const channelResults = accessibleChannels
    .filter((ch) => ch.name.includes(q.toLowerCase()))
    .slice(0, limit)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      communityId: ch.communityId,
      communityName: ch.communityName,
    }));

  // --- communities ---
  const communityResults = all<{ id: string; name: string; icon_id: string | null; description: string }>(
    `SELECT c.id, c.name, c.icon_id, c.description FROM communities c
     JOIN community_members m ON m.community_id = c.id
     WHERE m.user_id = ? AND c.name LIKE ? LIMIT ?`,
    userId,
    like,
    limit,
  ).map((community) => ({
    id: community.id,
    name: community.name,
    iconUrl: community.icon_id ? `/api/uploads/${community.icon_id}` : null,
    description: community.description,
  }));

  // --- direct messages by name or content of the peer ---
  const dmResults = accessibleConversations
    .filter((conv) => conv.name && conv.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, limit)
    .map((conv) => ({ id: conv.id, name: conv.name!, type: conv.type }));

  return c.json({
    messages: messageResults,
    users: (() => {
      const badges = badgesForUsers(userRows.map((u) => u.id));
      return userRows.map((u) => ({ ...publicUser(u), presence: presenceFor(u.id, u.presence), badges: badges[u.id] ?? [] }));
    })(),
    channels: channelResults,
    communities: communityResults,
    conversations: dmResults,
  });
});

export default router;
