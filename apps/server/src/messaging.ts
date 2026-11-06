import { all, get, indexMessage, run, transaction, unindexMessage } from './db.ts';
import { hub } from './realtime.ts';
import { now, uid } from './ids.ts';
import { fetchMessageRow, serializeMessages, type MessageRow } from './messages.ts';
import { cleanText } from './util.ts';
import { pushToUsers, hasSubscriptions } from './push.ts';
import type { ChannelRow, ConversationRow } from './access.ts';

export type Scope = { channelId?: string; conversationId?: string };

export function messageScope(message: { channel_id?: string | null; conversation_id?: string | null }): Scope {
  return message.channel_id
    ? { channelId: message.channel_id }
    : { conversationId: message.conversation_id ?? undefined };
}

export type CreateMessageInput = {
  authorId: string;
  content: string;
  replyToId?: string | null;
  attachmentIds?: string[];
  channel?: ChannelRow;
  conversation?: ConversationRow;
  audience: string[];
  /** Client-generated id echoed back so optimistic sends can be reconciled. */
  nonce?: string | null;
};

export type CreateResult =
  | { ok: true; message: ReturnType<typeof serializeMessages>[number] }
  | { ok: false; status: number; error: string };

export function createMessage(input: CreateMessageInput): CreateResult {
  const content = cleanText(input.content ?? '');
  const attachmentIds = (input.attachmentIds ?? []).slice(0, 5);
  if (!content && attachmentIds.length === 0) {
    return { ok: false, status: 400, error: 'Message cannot be empty' };
  }
  if (content.length > 4000) return { ok: false, status: 400, error: 'Message is too long (max 4000 characters)' };

  if (input.channel && input.channel.slowmode > 0) {
    const last = get<{ created_at: number }>(
      'SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY created_at DESC LIMIT 1',
      input.channel.id,
      input.authorId,
    );
    if (last && now() - last.created_at < input.channel.slowmode * 1000) {
      const wait = Math.ceil((input.channel.slowmode * 1000 - (now() - last.created_at)) / 1000);
      return { ok: false, status: 429, error: `Slow mode is on — wait ${wait}s` };
    }
  }

  if (input.replyToId) {
    const parent = get<{ id: string; channel_id: string | null; conversation_id: string | null }>(
      'SELECT id, channel_id, conversation_id FROM messages WHERE id = ?',
      input.replyToId,
    );
    const sameScope =
      parent &&
      (input.channel
        ? parent.channel_id === input.channel.id
        : parent.conversation_id === input.conversation?.id);
    if (!sameScope) return { ok: false, status: 400, error: 'Cannot reply to that message' };
  }

  for (const id of attachmentIds) {
    const upload = get('SELECT 1 AS x FROM uploads WHERE id = ? AND owner_id = ?', id, input.authorId);
    if (!upload) return { ok: false, status: 400, error: 'Attachment not found' };
  }

  const id = uid('m_');
  const ts = now();
  transaction(() => {
    run(
      `INSERT INTO messages (id, channel_id, conversation_id, author_id, content, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.channel?.id ?? null,
      input.conversation?.id ?? null,
      input.authorId,
      content,
      input.replyToId ?? null,
      ts,
    );
    for (const uploadId of attachmentIds) {
      run('INSERT OR IGNORE INTO attachments (message_id, upload_id) VALUES (?, ?)', id, uploadId);
    }
    indexMessage(id, content);
  });

  const row = fetchMessageRow(id)!;
  const [serialized] = serializeMessages([row], { viewerId: input.authorId });
  const message = input.nonce ? { ...serialized, nonce: input.nonce } : serialized;
  hub.broadcast(input.audience, { op: 'message:new', message });

  void notifyOffline(input.audience, input.authorId, row, input.channel, input.conversation);
  return { ok: true, message };
}

async function notifyOffline(
  audience: string[],
  authorId: string,
  row: MessageRow,
  channel?: ChannelRow,
  conversation?: ConversationRow,
) {
  const recipients = audience.filter(
    (id) => id !== authorId && hub.connectionCount(id) === 0 && hasSubscriptions(id),
  );
  if (recipients.length === 0) return;
  const author = get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', authorId);
  const preview = row.content ? row.content.slice(0, 120) : 'Sent an attachment';
  let title = author?.display_name ?? 'New message';
  if (channel) {
    const community = get<{ name: string }>('SELECT name FROM communities WHERE id = ?', channel.community_id);
    title = `${title} · #${channel.name}`;
    if (community) title += ` (${community.name})`;
  } else if (conversation?.name) {
    title = `${conversation.name}: ${title}`;
  }
  await pushToUsers(recipients, {
    title,
    body: preview,
    url: channel ? `/?c=${channel.id}` : `/?d=${conversation?.id}`,
    tag: channel ? `ch-${channel.id}` : `dm-${conversation?.id}`,
  }).catch((err) => console.error('[push] notify failed', err));
}

export function editMessage(messageId: string, userId: string, content: string, canManage: boolean) {
  const row = get<{ id: string; author_id: string; channel_id: string | null; conversation_id: string | null; created_at: number; deleted_at: number | null }>(
    'SELECT id, author_id, channel_id, conversation_id, created_at, deleted_at FROM messages WHERE id = ?',
    messageId,
  );
  if (!row || row.deleted_at) return { status: 404, error: 'Message not found' } as const;
  if (row.author_id !== userId && !canManage) return { status: 403, error: 'You cannot edit that message' } as const;
  const text = cleanText(content);
  if (!text) return { status: 400, error: 'Message cannot be empty' } as const;
  if (text.length > 4000) return { status: 400, error: 'Message is too long' } as const;
  run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', text, now(), messageId);
  indexMessage(messageId, text);
  return {
    status: 200,
    updated: { id: messageId, content: text, editedAt: now(), channelId: row.channel_id, conversationId: row.conversation_id },
  } as const;
}

export function deleteMessage(messageId: string, userId: string, canManage: boolean) {
  const row = get<{ id: string; author_id: string; channel_id: string | null; conversation_id: string | null }>(
    'SELECT id, author_id, channel_id, conversation_id FROM messages WHERE id = ?',
    messageId,
  );
  if (!row) return { status: 404, error: 'Message not found' } as const;
  if (row.author_id !== userId && !canManage) return { status: 403, error: 'You cannot delete that message' } as const;
  run('UPDATE messages SET deleted_at = ?, content = \'\' WHERE id = ?', now(), messageId);
  unindexMessage(messageId);
  return {
    status: 200,
    deleted: { id: messageId, channelId: row.channel_id, conversationId: row.conversation_id },
  } as const;
}

export function toggleReaction(messageId: string, userId: string, emoji: string, add: boolean) {
  const exists = get('SELECT 1 AS x FROM messages WHERE id = ? AND deleted_at IS NULL', messageId);
  if (!exists) return { status: 404, error: 'Message not found' } as const;
  if (add) {
    run(
      'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      messageId,
      userId,
      emoji,
      now(),
    );
  } else {
    run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  }
  const reactions = all<{ emoji: string; user_id: string }>(
    'SELECT emoji, user_id FROM reactions WHERE message_id = ?',
    messageId,
  ).reduce<Record<string, string[]>>((acc, r) => {
    (acc[r.emoji] ??= []).push(r.user_id);
    return acc;
  }, {});
  return { status: 200, reactions } as const;
}

/** Lightweight mention extraction, used by the client for highlighting + unread badges. */
export function extractMentions(content: string): string[] {
  return [...content.matchAll(/@([a-zA-Z0-9._-]{3,24})/g)].map((m) => m[1].toLowerCase());
}
