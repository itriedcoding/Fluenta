import { openModal, selectScope, useStore } from '../lib/store';
import { navigate } from '../App';
import { Avatar, Icon } from './ui';

export function ServerRail({ activeCommunityId }: { activeCommunityId: string | null }) {
  const communities = useStore((state) => state.communities);
  const conversations = useStore((state) => state.conversations);
  const active = useStore((state) => state.active);
  const unread = useStore((state) => state.unread);
  const me = useStore((state) => state.me);

  const homeActive = active?.kind === 'conversation';
  const dmUnread = Object.entries(unread).reduce(
    (sum, [key, count]) => (key.startsWith('dm:') ? sum + count : sum),
    0,
  );

  function goHome() {
    if (conversations.length > 0) {
      const current = conversations.find((conversation) => conversation.id === active?.id);
      selectScope({ kind: 'conversation', id: current?.id ?? conversations[0].id });
    } else {
      openModal({ kind: 'create-group' });
    }
    navigate('/');
  }

  return (
    <nav className="rail" aria-label="Spaces">
      <button
        type="button"
        className={`rail-home ${homeActive ? 'active' : ''}`}
        onClick={goHome}
        title="Direct messages"
      >
        <span className="brand-mark">F</span>
        {dmUnread > 0 && <span className="rail-dot" />}
      </button>

      <span className="rail-sep" />

      <div className="rail-list">
        {communities.map((community) => {
          const communityUnread = community.channels.reduce(
            (sum, channel) => sum + (unread[`ch:${channel.id}`] ?? 0),
            0,
          );
          return (
            <button
              key={community.id}
              type="button"
              className={`rail-item ${activeCommunityId === community.id ? 'active' : ''}`}
              title={community.name}
              onClick={() => {
                const target =
                  community.channels.find((channel) => channel.id === active?.id) ??
                  community.channels.find((channel) => channel.type === 'text') ??
                  community.channels[0];
                if (target) selectScope({ kind: 'channel', id: target.id });
              }}
            >
              {community.iconUrl ? (
                <img src={community.iconUrl} alt="" className="rail-icon" />
              ) : (
                <span className="rail-icon rail-icon-fallback">{community.name.slice(0, 1).toUpperCase()}</span>
              )}
              {communityUnread > 0 && <span className="rail-dot" />}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="rail-add"
        title="Create a community"
        onClick={() => openModal({ kind: 'create-community' })}
      >
        <Icon name="plus" size={18} />
      </button>

      <button
        type="button"
        className="rail-add"
        title="Join with an invite"
        onClick={() => openModal({ kind: 'create-community' })}
      >
        <Icon name="compass" size={18} />
      </button>

      <div className="rail-spacer" />

      {me && (
        <button type="button" className="rail-avatar" onClick={() => openModal({ kind: 'profile', userId: me.id })}>
          <Avatar name={me.displayName} url={me.avatarUrl} id={me.id} size={36} presence={me.presence} />
        </button>
      )}
    </nav>
  );
}
