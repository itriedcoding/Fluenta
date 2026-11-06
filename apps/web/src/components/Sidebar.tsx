import { useState } from 'react';
import {
  joinVoice,
  leaveVoice,
  openModal,
  permissionFor,
  PERM,
  selectScope,
  setMobileView,
  setOverlay,
  useStore,
} from '../lib/store';
import { voice } from '../lib/webrtc';
import { conversationTitle, cx } from '../lib/util';
import { Avatar, Badge, Icon } from './ui';
import type { Channel, Community, Conversation, VoicePeer } from '../lib/types';

export function Sidebar({
  community,
  conversation,
}: {
  community: Community | null;
  conversation: Conversation | null;
}) {
  const me = useStore((state) => state.me);
  const conversations = useStore((state) => state.conversations);
  const unread = useStore((state) => state.unread);
  const active = useStore((state) => state.active);
  const voiceRooms = useStore((state) => state.voiceRooms);
  const voiceSession = useStore((state) => state.voiceSession);

  return (
    <aside className="sidebar">
      {community ? (
        <>
          <header className="sidebar-header">
            <h2 title={community.name}>{community.name}</h2>
            <div className="sidebar-actions">
              <button
                type="button"
                className="icon-btn"
                title="Create channel"
                onClick={() => openModal({ kind: 'create-channel', communityId: community.id })}
              >
                <Icon name="plus" size={18} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Community settings"
                onClick={() =>
                  permissionFor(community, PERM.MANAGE_SERVER)
                    ? openModal({ kind: 'community-settings', communityId: community.id })
                    : openModal({ kind: 'invite', communityId: community.id })
                }
              >
                <Icon name="settings" size={18} />
              </button>
            </div>
          </header>

          <div className="sidebar-scroll">
            <ChannelGroup
              community={community}
              title="Text channels"
              channels={community.channels.filter((channel) => channel.type === 'text')}
              unread={unread}
              activeId={active?.kind === 'channel' ? active.id : null}
            />
            <ChannelGroup
              community={community}
              title="Voice channels"
              channels={community.channels.filter((channel) => channel.type === 'voice')}
              unread={unread}
              activeId={active?.kind === 'channel' ? active.id : null}
              voiceRooms={voiceRooms}
              voiceChannelId={voiceSession.channelId}
            />
            <div className="sidebar-invite">
              <button
                type="button"
                className="btn btn-soft btn-block"
                onClick={() => openModal({ kind: 'invite', communityId: community.id })}
              >
                <Icon name="link" size={16} /> Invite people
              </button>
              <p>{community.memberCount} member{community.memberCount === 1 ? '' : 's'}</p>
            </div>
          </div>
        </>
      ) : (
        <>
          <header className="sidebar-header">
            <h2>Direct messages</h2>
            <div className="sidebar-actions">
              <button
                type="button"
                className="icon-btn"
                title="New conversation"
                onClick={() => openModal({ kind: 'create-group' })}
              >
                <Icon name="plus" size={18} />
              </button>
              <button type="button" className="icon-btn" title="Search" onClick={() => setOverlay('search')}>
                <Icon name="search" size={18} />
              </button>
            </div>
          </header>
          <div className="sidebar-scroll">
            {conversations.length === 0 ? (
              <div className="sidebar-empty">
                <p>No conversations yet.</p>
                <button type="button" className="btn btn-soft btn-block" onClick={() => openModal({ kind: 'create-group' })}>
                  Start a conversation
                </button>
              </div>
            ) : (
              <ul className="dm-list">
                {conversations.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={cx('dm-item', conversation?.id === entry.id && 'active')}
                      onClick={() => {
                        selectScope({ kind: 'conversation', id: entry.id });
                        setMobileView('chat');
                      }}
                    >
                      {entry.type === 'dm' && me ? (
                        <Avatar
                          size={34}
                          name={conversationPeerName(entry, me.id)}
                          url={conversationPeerAvatar(entry, me.id)}
                          id={conversationPeerId(entry, me.id)}
                          presence={conversationPeerPresence(entry, me.id)}
                        />
                      ) : (
                        <span className="dm-group-icon">
                          <Icon name="users" size={16} />
                        </span>
                      )}
                      <span className="dm-text">
                        <span className="dm-name">
                          {me ? conversationTitle(entry, me.id) : entry.name}
                          <Badge count={unread[`dm:${entry.id}`] ?? 0} />
                        </span>
                        <span className="dm-preview">
                          {entry.lastMessage
                            ? `${entry.lastMessage.authorId === me?.id ? 'You: ' : ''}${entry.lastMessage.content}`
                            : 'No messages yet'}
                        </span>
                      </span>
                      {entry.muted && <Icon name="bell" size={13} className="dm-muted" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <UserPanel community={community} />
    </aside>
  );
}

function conversationPeer(conversation: Conversation, meId: string) {
  return conversation.members.find((member) => member.userId !== meId) ?? conversation.members[0];
}
function conversationPeerName(conversation: Conversation, meId: string) {
  return conversationPeer(conversation, meId)?.displayName ?? 'Direct message';
}
function conversationPeerAvatar(conversation: Conversation, meId: string) {
  return conversationPeer(conversation, meId)?.avatarUrl ?? null;
}
function conversationPeerId(conversation: Conversation, meId: string) {
  return conversationPeer(conversation, meId)?.userId ?? conversation.id;
}
function conversationPeerPresence(conversation: Conversation, meId: string) {
  return conversationPeer(conversation, meId)?.presence ?? 'offline';
}

function ChannelGroup({
  community,
  title,
  channels,
  unread,
  activeId,
  voiceRooms,
  voiceChannelId,
}: {
  community: Community;
  title: string;
  channels: Channel[];
  unread: Record<string, number>;
  activeId: string | null;
  voiceRooms?: Record<string, VoicePeer[]>;
  voiceChannelId?: string | null;
}) {
  const collapsedKey = `fluenta:collapsed:${community.id}:${title}`;
  const [collapsed, setCollapsed] = useCollapsed(collapsedKey);
  if (channels.length === 0) return null;

  return (
    <section className="channel-group">
      <button type="button" className="channel-group-head" onClick={() => setCollapsed(!collapsed)}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        <span>{title}</span>
        <span className="channel-group-count">{channels.length}</span>
      </button>
      {!collapsed && (
        <ul className="channel-list">
          {channels.map((channel) => {
            const peers = channel.type === 'voice' ? voiceRooms?.[channel.id] ?? [] : [];
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={cx(
                    'channel-item',
                    activeId === channel.id && 'active',
                    voiceChannelId === channel.id && 'voice-active',
                  )}
                  onClick={() => {
                    if (channel.type === 'voice') {
                      if (voiceChannelId === channel.id) return;
                      void joinVoice(channel.id);
                    } else {
                      selectScope({ kind: 'channel', id: channel.id });
                      setMobileView('chat');
                    }
                  }}
                >
                  <Icon name={channel.type === 'voice' ? 'volume' : 'hash'} size={16} />
                  <span className="channel-name">{channel.name}</span>
                  {channel.isPrivate && <Icon name="lock" size={12} />}
                  <Badge count={unread[`ch:${channel.id}`] ?? 0} />
                  {channel.slowmode > 0 && <span className="channel-slow" title={`Slow mode ${channel.slowmode}s`}>⏱</span>}
                </button>
                {peers.length > 0 && (
                  <ul className="voice-peers">
                    {peers.map((peer) => (
                      <li key={peer.userId}>
                        <span className="voice-peer-dot" />
                        <span className="voice-peer-name">
                          {peer.userId === voiceChannelId ? 'You' : peerName(community, peer.userId)}
                        </span>
                        {peer.muted && <Icon name="micOff" size={11} />}
                        {peer.sharing && <Icon name="screen" size={11} />}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function peerName(community: Community, userId: string) {
  const member = community.members.find((m) => m.userId === userId);
  return member?.nickname || member?.displayName || 'Someone';
}

function useCollapsed(key: string): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  return [
    collapsed,
    (value: boolean) => {
      setCollapsed(value);
      try {
        localStorage.setItem(key, value ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
  ];
}

function UserPanel({ community }: { community: Community | null }) {
  const me = useStore((state) => state.me);
  const voiceSession = useStore((state) => state.voiceSession);
  const voiceRooms = useStore((state) => state.voiceRooms);
  const channel = voiceSession.channelId && community ? community.channels.find((c) => c.id === voiceSession.channelId) : null;

  if (!me) return null;
  const participants = voiceSession.channelId ? voiceRooms[voiceSession.channelId]?.length ?? 0 : 0;

  return (
    <div className="user-panel">
      {voiceSession.joined && voiceSession.channelId && (
        <div className="voice-connected">
          <div className="voice-connected-text">
            <span className="live-pip" />
            <div>
              <strong>{voiceSession.error ? 'Mic blocked' : 'Voice connected'}</strong>
              <span>{channel ? `#${channel.name}` : 'Voice channel'} · {participants + 1} in room</span>
            </div>
          </div>
          <div className="voice-connected-actions">
            <button
              type="button"
              className={cx('icon-btn', voiceSession.muted && 'danger')}
              title={voiceSession.muted ? 'Unmute' : 'Mute'}
              onClick={() => voice.toggleMute()}
            >
              <Icon name={voiceSession.muted ? 'micOff' : 'mic'} size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Disconnect"
              onClick={() => leaveVoice()}
            >
              <Icon name="phoneOff" size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="user-panel-main">
        <button
          type="button"
          className="user-panel-profile"
          onClick={() => me && openModal({ kind: 'profile', userId: me.id })}
        >
          <Avatar name={me.displayName} url={me.avatarUrl} id={me.id} size={34} presence={me.presence} />
          <span className="user-panel-text">
            <strong>{me.displayName}</strong>
            <span>{me.customStatus || `@${me.username}`}</span>
          </span>
        </button>
        <div className="user-panel-actions">
          <button
            type="button"
            className={cx('icon-btn', voiceSession.muted && 'danger')}
            title={voiceSession.muted ? 'Unmute' : 'Mute'}
            onClick={() => (voiceSession.joined ? voice.toggleMute() : undefined)}
            disabled={!voiceSession.joined}
          >
            <Icon name={voiceSession.muted ? 'micOff' : 'mic'} size={17} />
          </button>
          <button
            type="button"
            className={cx('icon-btn', voiceSession.deafened && 'danger')}
            title={voiceSession.deafened ? 'Undeafen' : 'Deafen'}
            onClick={() => (voiceSession.joined ? voice.toggleDeafen() : undefined)}
            disabled={!voiceSession.joined}
          >
            <Icon name="headphones" size={17} />
          </button>
          <button type="button" className="icon-btn" title="Settings" onClick={() => setOverlay('settings')}>
            <Icon name="settings" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
