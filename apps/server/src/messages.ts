import { all, get } from './db.ts';

export type MessageRow = {
  id: string;
  channel_id: string | null;
  conversation_id: string | null;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  username: string;
  display_name: string;
  avatar_id: string | null;
};

export type SerializedMessage = ReturnType<typeof serializeMessages>[number];

const BASE_SELECT = `
  SELECT m.*, u.username, u.display_name, u.avatar_id
  FROM messages m JOIN users u ON u.id = m.author_id
`;

export function fetchChannelMessages(
  channelId: string,
  before: number | null,
  limit: number,
): MessageRow[] {
  const rows = before
    ? all<MessageRow>(
        `${BASE_SELECT} WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`,
        channelId,
        before,
        limit,
      )
    : all<MessageRow>(
        `${BASE_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?`,
        channelId,
        limit,
      );
  return rows.reverse();
}

export function fetchConversationMessages(
  conversationId: string,
  before: number | null,
  limit: number,
): MessageRow[] {
  const rows = before
    ? all<MessageRow>(
        `${BASE_SELECT} WHERE m.conversation_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`,
        conversationId,
        before,
        limit,
      )
    : all<MessageRow>(
        `${BASE_SELECT} WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT ?`,
        conversationId,
        limit,
      );
  return rows.reverse();
}

export function fetchMessageRow(id: string): MessageRow | undefined {
  return get<MessageRow>(`${BASE_SELECT} WHERE m.id = ?`, id);
}

function placeholders(n: number) {
  return new Array(n).fill('?').join(',');
}

export type SerializeOptions = {
  viewerId: string;
  /** userId -> last_read_at for the enclosing channel, enables read counts. */
  channelReaders?: Map<string, number>;
};

/**
 * Turns raw rows into the single message shape used by REST and WebSocket
 * payloads, batching attachment / reaction / reply lookups.
 */
export function serializeMessages(rows: MessageRow[], options: SerializeOptions) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);

  const attachments = all<{
    message_id: string;
    id: string;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
  }>(
    `SELECT a.message_id, up.id, up.name, up.mime, up.size, up.width, up.height
     FROM attachments a JOIN uploads up ON up.id = a.upload_id
     WHERE a.message_id IN (${ph})`,
    ...ids,
  );

  const reactions = all<{ message_id: string; emoji: string; user_id: string }>(
    `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph})`,
    ...ids,
  );

  const replyIds = rows.map((r) => r.reply_to_id).filter((x): x is string => Boolean(x));
  const replies = replyIds.length
    ? all<{ id: string; content: string; author_id: string; username: string; display_name: string; deleted_at: number | null }>(
        `SELECT m.id, m.content, m.author_id, m.deleted_at, u.username, u.display_name
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.id IN (${placeholders(replyIds.length)})`,
        ...replyIds,
      )
    : [];

  const attachmentMap = new Map<string, typeof attachments>();
  for (const a of attachments) {
    const list = attachmentMap.get(a.message_id) ?? [];
    list.push(a);
    attachmentMap.set(a.message_id, list);
  }

  const reactionMap = new Map<string, Map<string, { count: number; me: boolean; users: string[] }>>();
  for (const r of reactions) {
    let perMessage = reactionMap.get(r.message_id);
    if (!perMessage) {
      perMessage = new Map();
      reactionMap.set(r.message_id, perMessage);
    }
    const entry = perMessage.get(r.emoji) ?? { count: 0, me: false, users: [] };
    entry.count += 1;
    entry.users.push(r.user_id);
    if (r.user_id === options.viewerId) entry.me = true;
    perMessage.set(r.emoji, entry);
  }

  const replyMap = new Map(replies.map((r) => [r.id, r]));

  return rows.map((row) => {
    const reply = row.reply_to_id ? replyMap.get(row.reply_to_id) : undefined;
    const deleted = Boolean(row.deleted_at);
    const files = (attachmentMap.get(row.id) ?? []).map((a) => ({
      id: a.id,
      url: `/api/uploads/${a.id}`,
      name: a.name,
      mime: a.mime,
      size: a.size,
      width: a.width,
      height: a.height,
      isImage: a.mime.startsWith('image/'),
    }));
    const reactionList = [...(reactionMap.get(row.id)?.entries() ?? [])].map(([emoji, v]) => ({
      emoji,
      count: v.count,
      me: v.me,
      users: v.users,
    }));

    let readBy: string[] | undefined;
    if (options.channelReaders) {
      readBy = [...options.channelReaders.entries()]
        .filter(([userId, lastRead]) => userId !== row.author_id && lastRead >= row.created_at)
        .map(([userId]) => userId);
    }

    return {
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      author: {
        id: row.author_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_id ? `/api/uploads/${row.avatar_id}` : null,
      },
      content: deleted ? '' : row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      replyTo: reply
        ? {
            id: reply.id,
            content: reply.deleted_at ? 'Message deleted' : reply.content.slice(0, 180),
            author: { id: reply.author_id, username: reply.username, displayName: reply.display_name },
          }
        : null,
      attachments: files,
      reactions: reactionList,
      readBy,
    };
  });
}

export function channelReaders(channelId: string) {
  const rows = all<{ user_id: string; last_read_at: number }>(
    'SELECT user_id, last_read_at FROM channel_reads WHERE channel_id = ?',
    channelId,
  );
  return new Map(rows.map((r) => [r.user_id, r.last_read_at]));
}
