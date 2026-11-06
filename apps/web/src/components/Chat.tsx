import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadMessages,
  markRead,
  muteConversation,
  openModal,
  permissionFor,
  PERM,
  setMobileView,
  setOverlay,
  setReply,
  toggleMemberList,
  useStore,
} from '../lib/store';
import { conversationTitle, formatDay, scopeKey } from '../lib/util';
import type { Channel, Community, Conversation, Message, Scope } from '../lib/types';
import { Avatar, Icon, Spinner } from './ui';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';

export function Chat({
  channel,
  community,
  conversation,
}: {
  channel?: Channel;
  community?: Community | null;
  conversation?: Conversation;
}) {
  const scope: Scope = channel
    ? { kind: 'channel', id: channel.id }
    : { kind: 'conversation', id: conversation!.id };
  const key = scopeKey(scope);

  const me = useStore((state) => state.me);
  const cache = useStore((state) => state.messages[key]);
  const typingAll = useStore((state) => state.typing);
  const people = useStore((state) => state.people);
  const readsAll = useStore((state) => state.reads);
  const connection = useStore((state) => state.connection);
  const memberList = useStore((state) => state.memberList);
  const conversations = useStore((state) => state.conversations);
  const communities = useStore((state) => state.communities);

  const typing = typingAll[key] ?? [];
  const items = cache?.items ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const bottomRef = useRef(true);
  const previousHeight = useRef(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [searching, setSearching] = useState(false);

  const communityForChannel = channel
    ? community ?? communities.find((c) => c.channels.some((ch) => ch.id === channel.id)) ?? null
    : null;
  const currentConversation = conversation ?? conversations.find((c) => c.id === scope.id) ?? null;
  const title = channel ? channel.name : currentConversation && me ? conversationTitle(currentConversation, me.id) : 'Conversation';
  const canManage = communityForChannel ? permissionFor(communityForChannel, PERM.MANAGE_MESSAGES) : false;
  const canSend = channel
    ? !communityForChannel || permissionFor(communityForChannel, PERM.SEND_MESSAGES)
    : true;

  const lastOwnMessageId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].author.id === me?.id) return items[i].id;
    return null;
  }, [items, me?.id]);

  const readers = useMemo(() => {
    if (!me || !currentConversation) return [];
    const readState = readsAll[key] ?? {};
    return currentConversation.members
      .filter((member) => member.userId !== me.id && (readState[member.userId] ?? 0) >= (currentConversation.reads?.[member.userId] ?? 0))
      .filter((member) => (readState[member.userId] ?? 0) > 0);
  }, [readsAll, key, currentConversation, me]);

  useEffect(() => {
    bottomRef.current = true;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [key]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (previousHeight.current) {
      node.scrollTop = node.scrollHeight - previousHeight.current;
      previousHeight.current = 0;
      return;
    }
    if (bottomRef.current) {
      node.scrollTo({ top: node.scrollHeight, behavior: items.length > 0 ? 'smooth' : 'auto' });
      setJumpVisible(false);
    }
  }, [items]);

  useEffect(() => {
    const onFocus = () => markRead(scope);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    bottomRef.current = distance < 120;
    setJumpVisible(distance > 400);
    if (node.scrollTop < 80 && cache?.hasMore && !cache.loading) {
      previousHeight.current = node.scrollHeight;
      void loadMessages(scope, true);
    }
  }

  function scrollToMessage(id: string) {
    const node = document.getElementById(`message-${id}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }

  const grouped = useMemo(() => buildTimeline(items, me?.id ?? ''), [items, me?.id]);

  return (
    <div className="chat">
      <header className="chat-header">
        <button type="button" className="icon-btn mobile-only" onClick={() => setMobileView('sidebar')} aria-label="Back">
          <Icon name="chevronLeft" size={20} />
        </button>

        {channel ? (
          <span className="chat-header-icon">
            <Icon name={channel.type === 'voice' ? 'volume' : 'hash'} size={20} />
          </span>
        ) : currentConversation && me ? (
          <Avatar
            size={30}
            name={conversationTitle(currentConversation, me.id)}
            url={currentConversation.iconUrl ?? peerAvatar(currentConversation, me.id)}
            id={currentConversation.id}
            presence={currentConversation.type === 'dm' ? peerPresence(currentConversation, me.id) : undefined}
          />
        ) : null}

        <div className="chat-header-text">
          <h1>{title}</h1>
          <p>
            {channel
              ? channel.topic || (channel.isPrivate ? 'Private channel' : `Part of ${communityForChannel?.name ?? 'this community'}`)
              : currentConversation
                ? `${currentConversation.members.length} member${currentConversation.members.length === 1 ? '' : 's'}`
                : ''}
          </p>
        </div>

        <div className="chat-header-actions">
          {connection !== 'online' && (
            <span className="connection-chip" title="Realtime connection">
              <span className={`status-pip ${connection}`} /> {connection === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
          )}
          <button type="button" className="icon-btn" title="Search messages" onClick={() => setOverlay('search')}>
            <Icon name="search" size={18} />
          </button>
          {communityForChannel && channel && (
            <button
              type="button"
              className="icon-btn"
              title="Channel settings"
              onClick={() =>
                permissionFor(communityForChannel, PERM.MANAGE_CHANNELS)
                  ? openModal({ kind: 'channel-settings', channelId: channel.id })
                  : openModal({ kind: 'invite', communityId: communityForChannel.id })
              }
            >
              <Icon name="settings" size={18} />
            </button>
          )}
          {currentConversation && (
            <button
              type="button"
              className="icon-btn"
              title={currentConversation.muted ? 'Unmute notifications' : 'Mute notifications'}
              onClick={() => void muteConversation(currentConversation.id, !currentConversation.muted)}
            >
              <Icon name="bell" size={18} className={currentConversation.muted ? 'muted' : undefined} />
            </button>
          )}
          {(channel || currentConversation?.type === 'group') && (
            <button
              type="button"
              className="icon-btn"
              title={memberList ? 'Hide member list' : 'Show member list'}
              onClick={toggleMemberList}
            >
              <Icon name="users" size={18} />
            </button>
          )}
        </div>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        {cache?.loading && items.length === 0 && (
          <div className="messages-loading">
            <Spinner size={18} /> Loading messages…
          </div>
        )}
        {!cache?.loading && items.length === 0 && (
          <div className="messages-empty">
            <span className="messages-empty-icon">
              <Icon name={channel ? 'hash' : 'at'} size={22} />
            </span>
            <h2>{channel ? `Welcome to #${channel.name}` : 'This is the start of your conversation'}</h2>
            <p>
              {channel
                ? channel.topic || 'Send the first message and get things going.'
                : 'Say hello — messages arrive instantly on every device.'}
            </p>
          </div>
        )}

        {cache?.hasMore && (
          <div className="messages-more">
            {cache.loading ? <Spinner size={16} /> : (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const node = scroller.current;
                  if (node) previousHeight.current = node.scrollHeight;
                  void loadMessages(scope, true);
                }}
              >
                Load earlier messages
              </button>
            )}
          </div>
        )}

        {grouped.map((entry) => {
          if (entry.type === 'day') {
            return (
              <div className="day-divider" key={`day-${entry.timestamp}`}>
                <span>{formatDay(entry.timestamp)}</span>
              </div>
            );
          }
          const isLastOwn = entry.message.id === lastOwnMessageId;
          return (
            <MessageItem
              key={entry.message.id}
              message={entry.message}
              compact={entry.compact}
              meId={me?.id ?? ''}
              canManage={canManage}
              community={communityForChannel}
              readers={isLastOwn && currentConversation ? readers : []}
              onReply={() => setReply(entry.message)}
              onJumpTo={scrollToMessage}
            />
          );
        })}
      </div>

      {jumpVisible && (
        <button type="button" className="jump-latest" onClick={() => {
          const node = scroller.current;
          if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
          setJumpVisible(false);
        }}>
          Jump to latest
        </button>
      )}

      <div className="typing-bar" aria-live="polite">
        {typing.length > 0 && (
          <span>
            <span className="typing-dots"><i /><i /><i /></span>
            {typing.length === 1
              ? `${typing[0].name} is typing…`
              : typing.length === 2
                ? `${typing[0].name} and ${typing[1].name} are typing…`
                : 'Several people are typing…'}
          </span>
        )}
      </div>

      {canSend ? (
        <Composer scope={scope} channel={channel} onSent={() => { bottomRef.current = true; }} />
      ) : (
        <div className="composer-disabled">You do not have permission to send messages in this channel.</div>
      )}

      {searching && null}
    </div>
  );
}

function peerAvatar(conversation: Conversation, meId: string) {
  const other = conversation.members.find((member) => member.userId !== meId);
  return other?.avatarUrl ?? null;
}
function peerPresence(conversation: Conversation, meId: string) {
  const other = conversation.members.find((member) => member.userId !== meId);
  return other?.presence;
}

type TimelineEntry =
  | { type: 'day'; timestamp: number }
  | { type: 'message'; message: Message; compact: boolean };

function buildTimeline(messages: Message[], meId: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let lastDay = '';
  let lastAuthor = '';
  let lastTime = 0;
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (dayKey !== lastDay) {
      out.push({ type: 'day', timestamp: message.createdAt });
      lastDay = dayKey;
      lastAuthor = '';
    }
    const compact =
      lastAuthor === message.author.id &&
      message.createdAt - lastTime < 5 * 60 * 1000 &&
      !message.replyTo;
    out.push({ type: 'message', message, compact });
    lastAuthor = message.author.id;
    lastTime = message.createdAt;
    void meId;
  }
  return out;
}
