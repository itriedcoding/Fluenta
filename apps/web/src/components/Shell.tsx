import { useEffect } from 'react';
import { channelOf, joinInvite, setMobileView, toastError, useStore } from '../lib/store';
import { navigate } from '../App';
import { ServerRail } from './ServerRail';
import { Sidebar } from './Sidebar';
import { Chat } from './Chat';
import { Members } from './Members';
import { SearchPalette } from './SearchPalette';
import { Settings } from './Settings';
import { Modals } from './Modals';
import { VoiceRoom } from './VoiceRoom';
import { Icon } from './ui';
import { installUpdate, useUpdates } from '../lib/updater';

function UpdatePill() {
  const updates = useUpdates();
  if (updates.status === 'available' && updates.release) {
    return (
      <button type="button" className="update-pill" onClick={() => void installUpdate()}>
        <Icon name="download" size={15} />
        <span>Fluenta {updates.release.version} is ready</span>
        <strong>Update</strong>
      </button>
    );
  }
  if (updates.status === 'downloading') {
    return (
      <div className="update-pill downloading">
        <span className="status-pip connecting" />
        <span>Downloading update · {Math.round(updates.progress)}%</span>
      </div>
    );
  }
  if (updates.status === 'ready') {
    return (
      <div className="update-pill ready">
        <Icon name="check" size={15} />
        <span>Finish the update in Android's installer</span>
      </div>
    );
  }
  return null;
}

export function Shell({ inviteCode }: { inviteCode: string | null }) {
  const communities = useStore((state) => state.communities);
  const conversations = useStore((state) => state.conversations);
  const active = useStore((state) => state.active);
  const mobileView = useStore((state) => state.mobileView);
  const memberList = useStore((state) => state.memberList);
  const overlay = useStore((state) => state.overlay);
  const connection = useStore((state) => state.connection);

  useEffect(() => {
    if (!inviteCode) return;
    joinInvite(inviteCode)
      .catch((err) => toastError(err))
      .finally(() => navigate('/'));
  }, [inviteCode]);

  const activeChannel = active?.kind === 'channel' ? channelOf(active.id) : null;
  const activeCommunity = activeChannel
    ? communities.find((community) => community.channels.some((channel) => channel.id === activeChannel.id)) ?? null
    : null;
  const activeConversation =
    active?.kind === 'conversation' ? conversations.find((conversation) => conversation.id === active.id) ?? null : null;

  return (
    <div className="app-shell">
      <ServerRail activeCommunityId={activeCommunity?.id ?? null} />
      <div className={`workspace ${mobileView === 'chat' ? 'show-chat' : 'show-sidebar'}`}>
        <Sidebar community={activeCommunity} conversation={activeConversation} />
        <main className="chat-area">
          {activeChannel ? (
            <Chat key={activeChannel.id} channel={activeChannel} community={activeCommunity} />
          ) : activeConversation ? (
            <Chat key={activeConversation.id} conversation={activeConversation} />
          ) : (
            <div className="welcome-pane">
              <div className="welcome-glow" />
              <div className="welcome-inner">
                <span className="brand-mark brand-mark-lg">F</span>
                <h1>Pick up a conversation</h1>
                <p>
                  Choose a channel on the left, open a direct message, or start something new. Everything
                  stays in sync across web, desktop and Android.
                </p>
                <div className="welcome-actions">
                  <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
                    <Icon name="compass" size={16} /> Browse direct messages
                  </button>
                </div>
                {connection !== 'online' && (
                  <p className="connection-note">
                    <span className={`status-pip ${connection}`} /> {connection === 'connecting' ? 'Connecting…' : 'Offline — retrying'}
                  </p>
                )}
              </div>
            </div>
          )}
        </main>
        {memberList && activeCommunity && activeChannel?.type === 'text' && (
          <Members community={activeCommunity} channel={activeChannel} />
        )}
      </div>

      <button
        type="button"
        className="mobile-back"
        onClick={() => setMobileView('sidebar')}
        aria-label="Back to channels"
      >
        <Icon name="chevronLeft" size={20} />
      </button>

      <UpdatePill />

      {overlay === 'search' && <SearchPalette />}
      {overlay === 'settings' && <Settings />}
      <Modals />
      <VoiceRoom />
    </div>
  );
}
