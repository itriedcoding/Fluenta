import { all, get } from './db.ts';
import { hub, type VoicePeer } from './realtime.ts';
import { channelAudience, effectivePermissions, type ChannelRow, type CommunityRow } from './access.ts';

export type PresenceValue = 'online' | 'idle' | 'dnd' | 'offline';

export function presenceFor(userId: string, stored: string | null): PresenceValue {
  if (!hub.isOnline(userId)) return 'offline';
  const chosen = stored || 'online';
  if (chosen === 'invisible') return 'offline';
  if (chosen === 'idle' || chosen === 'dnd' || chosen === 'online') return chosen;
  return 'online';
}

type MemberRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_id: string | null;
  bio: string | null;
  custom_status: string | null;
  presence: string;
  nickname: string | null;
  joined_at: number;
};

export function communityMembers(communityId: string) {
  const rows = all<MemberRow>(
    `SELECT u.id, u.username, u.display_name, u.avatar_id, u.bio, u.custom_status, u.presence,
            cm.nickname, cm.joined_at
     FROM community_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.community_id = ?
     ORDER BY u.display_name COLLATE NOCASE`,
    communityId,
  );
  const roles = all<{ user_id: string; role_id: string }>(
    'SELECT user_id, role_id FROM member_roles WHERE community_id = ?',
    communityId,
  );
  const roleMap = new Map<string, string[]>();
  for (const r of roles) {
    const list = roleMap.get(r.user_id) ?? [];
    list.push(r.role_id);
    roleMap.set(r.user_id, list);
  }
  return rows.map((row) => ({
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_id ? `/api/uploads/${row.avatar_id}` : null,
    bio: row.bio,
    customStatus: row.custom_status,
    presence: presenceFor(row.id, row.presence),
    nickname: row.nickname,
    roles: roleMap.get(row.id) ?? [],
    joinedAt: row.joined_at,
  }));
}

export function communityRoles(communityId: string) {
  return all<{ id: string; name: string; color: string; permissions: number; position: number; is_default: number }>(
    'SELECT id, name, color, permissions, position, is_default FROM roles WHERE community_id = ? ORDER BY position DESC, name',
    communityId,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    permissions: r.permissions,
    position: r.position,
    isDefault: Boolean(r.is_default),
  }));
}

export function visibleChannels(communityId: string, userId: string): ChannelRow[] {
  const perms = effectivePermissions(communityId, userId);
  const canManage = (perms & (1 << 1)) === 1 << 1;
  const rows = all<ChannelRow>(
    'SELECT * FROM channels WHERE community_id = ? ORDER BY position, created_at',
    communityId,
  );
  if (canManage) return rows;
  const allowed = new Set(
    all<{ channel_id: string }>('SELECT channel_id FROM channel_members WHERE user_id = ?', userId).map(
      (r) => r.channel_id,
    ),
  );
  return rows.filter((ch) => !ch.is_private || allowed.has(ch.id));
}

export function channelPayload(channel: ChannelRow) {
  return {
    id: channel.id,
    communityId: channel.community_id,
    name: channel.name,
    type: channel.type,
    topic: channel.topic,
    position: channel.position,
    isPrivate: Boolean(channel.is_private),
    slowmode: channel.slowmode,
    createdAt: channel.created_at,
  };
}

export function voiceSnapshot(): Record<string, VoicePeer[]> {
  return hub.allVoiceRooms();
}

export function communityPayload(community: CommunityRow, viewerId: string) {
  const members = communityMembers(community.id);
  const channels = visibleChannels(community.id, viewerId).map(channelPayload);
  return {
    id: community.id,
    name: community.name,
    description: community.description,
    iconUrl: community.icon_id ? `/api/uploads/${community.icon_id}` : null,
    ownerId: community.owner_id,
    inviteCode: community.invite_code,
    createdAt: community.created_at,
    memberCount: members.length,
    myPermissions: effectivePermissions(community.id, viewerId),
    roles: communityRoles(community.id),
    members,
    channels,
  };
}

export function conversationMembers(conversationId: string) {
  return all<MemberRow>(
    `SELECT u.id, u.username, u.display_name, u.avatar_id, u.bio, u.custom_status, u.presence,
            NULL AS nickname, cm.joined_at
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ?`,
    conversationId,
  ).map((row) => ({
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_id ? `/api/uploads/${row.avatar_id}` : null,
    bio: row.bio,
    customStatus: row.custom_status,
    presence: presenceFor(row.id, row.presence),
    roles: [] as string[],
    joinedAt: row.joined_at,
  }));
}

export function conversationPayload(conversationId: string, viewerId: string) {
  const row = get<{
    id: string;
    type: 'dm' | 'group';
    name: string | null;
    icon_id: string | null;
    owner_id: string;
    created_at: number;
  }>('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!row) return null;
  const members = conversationMembers(conversationId);
  const last = get<{ id: string; content: string; author_id: string; created_at: number; deleted_at: number | null }>(
    `SELECT id, content, author_id, created_at, deleted_at FROM messages
     WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
    conversationId,
  );
  const read = get<{ last_read_at: number }>(
    'SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    viewerId,
  );
  const unread = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
     WHERE conversation_id = ? AND created_at > ? AND author_id != ? AND deleted_at IS NULL`,
    conversationId,
    read?.last_read_at ?? 0,
    viewerId,
  );
  const reads = Object.fromEntries(
    all<{ user_id: string; last_read_at: number }>(
      'SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id = ?',
      conversationId,
    ).map((r) => [r.user_id, r.last_read_at]),
  );
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    iconUrl: row.icon_id ? `/api/uploads/${row.icon_id}` : null,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    members,
    lastMessage: last
      ? {
          id: last.id,
          content: last.deleted_at ? 'Message deleted' : last.content.slice(0, 140),
          authorId: last.author_id,
          createdAt: last.created_at,
        }
      : null,
    unread: Number(unread?.n ?? 0),
    reads,
    muted: Boolean(
      get(
        'SELECT muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        conversationId,
        viewerId,
      )?.muted,
    ),
  };
}

export function userConversations(userId: string) {
  const rows = all<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
     WHERE m.user_id = ?
     ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id), c.created_at) DESC`,
    userId,
  );
  return rows
    .map((r) => conversationPayload(r.id, userId))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

export function userCommunities(userId: string) {
  return all<CommunityRow>(
    `SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
     WHERE m.user_id = ? ORDER BY c.created_at`,
    userId,
  );
}

export function unreadMap(userId: string) {
  const channels = all<{ id: string; n: number }>(
    `SELECT ch.id, COUNT(m.id) AS n
     FROM channels ch
     JOIN community_members cm ON cm.community_id = ch.community_id AND cm.user_id = ?
     LEFT JOIN channel_reads cr ON cr.channel_id = ch.id AND cr.user_id = cm.user_id
     LEFT JOIN messages m ON m.channel_id = ch.id AND m.created_at > COALESCE(cr.last_read_at, 0)
       AND m.author_id != cm.user_id AND m.deleted_at IS NULL
     GROUP BY ch.id
     HAVING n > 0`,
    userId,
  );
  const conversations = all<{ id: string; n: number }>(
    `SELECT c.id, COUNT(m.id) AS n
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     LEFT JOIN messages m ON m.conversation_id = c.id AND m.created_at > cm.last_read_at
       AND m.author_id != cm.user_id AND m.deleted_at IS NULL
     GROUP BY c.id
     HAVING n > 0`,
    userId,
  );
  return {
    channels: Object.fromEntries(channels.map((r) => [r.id, Number(r.n)])),
    conversations: Object.fromEntries(conversations.map((r) => [r.id, Number(r.n)])),
  };
}

export function communitySummaries(userId: string) {
  return userCommunities(userId).map((c) => ({
    id: c.id,
    name: c.name,
    iconUrl: c.icon_id ? `/api/uploads/${c.icon_id}` : null,
    memberCount: Number(
      get('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', c.id)?.n ?? 0,
    ),
  }));
}

/** Audience for a community-wide event such as a role change. */
export function communityAudienceIds(communityId: string): string[] {
  return all<{ user_id: string }>(
    'SELECT user_id FROM community_members WHERE community_id = ?',
    communityId,
  ).map((r) => r.user_id);
}

export { channelAudience };
