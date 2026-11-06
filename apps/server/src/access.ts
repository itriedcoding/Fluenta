import { all, get } from './db.ts';
import { PERMISSIONS } from './permissions.ts';

export type ChannelRow = {
  id: string;
  community_id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  is_private: number;
  slowmode: number;
  created_at: number;
};

export type CommunityRow = {
  id: string;
  name: string;
  description: string;
  icon_id: string | null;
  owner_id: string;
  invite_code: string;
  created_at: number;
};

export type ConversationRow = {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  icon_id: string | null;
  owner_id: string;
  created_at: number;
};

export function isCommunityMember(communityId: string, userId: string): boolean {
  return Boolean(
    get('SELECT 1 AS x FROM community_members WHERE community_id = ? AND user_id = ?', communityId, userId),
  );
}

export function communityRow(id: string): CommunityRow | undefined {
  return get<CommunityRow>('SELECT * FROM communities WHERE id = ?', id);
}

export function isOwner(community: CommunityRow, userId: string) {
  return community.owner_id === userId;
}

export function effectivePermissions(communityId: string, userId: string): number {
  const community = communityRow(communityId);
  if (!community) return 0;
  if (community.owner_id === userId) return 0xffffffff;
  const row = get<{ perms: number | null }>(
    `SELECT SUM(r.permissions) AS perms
     FROM member_roles mr JOIN roles r ON r.id = mr.role_id
     WHERE mr.community_id = ? AND mr.user_id = ?`,
    communityId,
    userId,
  );
  const defaults = get<{ perms: number | null }>(
    `SELECT SUM(permissions) AS perms FROM roles WHERE community_id = ? AND is_default = 1`,
    communityId,
  );
  return Number(row?.perms ?? 0) | Number(defaults?.perms ?? 0);
}

export function can(communityId: string, userId: string, permission: number): boolean {
  return (effectivePermissions(communityId, userId) & permission) === permission;
}

export type ChannelAccess = {
  channel: ChannelRow;
  community: CommunityRow;
  permissions: number;
};

export function channelAccess(channelId: string, userId: string): ChannelAccess | null {
  const channel = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel) return null;
  const community = communityRow(channel.community_id);
  if (!community) return null;
  if (!isCommunityMember(channel.community_id, userId)) return null;
  if (channel.is_private) {
    const allowed = get(
      'SELECT 1 AS x FROM channel_members WHERE channel_id = ? AND user_id = ?',
      channelId,
      userId,
    );
    const elevated =
      (effectivePermissions(channel.community_id, userId) & PERMISSIONS.MANAGE_CHANNELS) ===
      PERMISSIONS.MANAGE_CHANNELS;
    if (!allowed && !elevated) return null;
  }
  return { channel, community, permissions: effectivePermissions(channel.community_id, userId) };
}

export function conversationRow(id: string): ConversationRow | undefined {
  return get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
}

export function conversationAccess(conversationId: string, userId: string): ConversationRow | null {
  const conversation = conversationRow(conversationId);
  if (!conversation) return null;
  const member = get(
    'SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    userId,
  );
  return member ? conversation : null;
}

export function channelAudience(channelId: string): string[] {
  const rows = all<{ user_id: string }>(
    `SELECT cm.user_id
     FROM community_members cm
     JOIN channels ch ON ch.community_id = cm.community_id
     WHERE ch.id = ?
       AND (ch.is_private = 0 OR EXISTS (
         SELECT 1 FROM channel_members x WHERE x.channel_id = ch.id AND x.user_id = cm.user_id
       ) OR EXISTS (
         SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
         WHERE mr.community_id = cm.community_id AND mr.user_id = cm.user_id
           AND (r.permissions & ?) = ?
       ))`,
    channelId,
    PERMISSIONS.MANAGE_CHANNELS,
    PERMISSIONS.MANAGE_CHANNELS,
  );
  return rows.map((r) => r.user_id);
}

export function conversationAudience(conversationId: string): string[] {
  return all<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
    conversationId,
  ).map((r) => r.user_id);
}

/** Everyone who shares a community or conversation with this user (plus the user). */
export function presenceAudience(userId: string): string[] {
  return all<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
       SELECT cm2.user_id
       FROM community_members cm1
       JOIN community_members cm2 ON cm2.community_id = cm1.community_id
       WHERE cm1.user_id = ?
       UNION
       SELECT c2.user_id
       FROM conversation_members c1
       JOIN conversation_members c2 ON c2.conversation_id = c1.conversation_id
       WHERE c1.user_id = ?
     )`,
    userId,
    userId,
  ).map((r) => r.user_id);
}

export function sharesCommunity(a: string, b: string): boolean {
  if (a === b) return true;
  return Boolean(
    get(
      `SELECT 1 AS x FROM community_members x
       JOIN community_members y ON y.community_id = x.community_id
       WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`,
      a,
      b,
    ),
  );
}
