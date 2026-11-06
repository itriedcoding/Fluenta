import { useEffect, useRef, useState } from 'react';
import { leaveVoice, useStore } from '../lib/store';
import { voice } from '../lib/webrtc';
import { cx } from '../lib/util';
import { Avatar, Icon } from './ui';

export function VoiceRoom() {
  const session = useStore((state) => state.voiceSession);
  const rooms = useStore((state) => state.voiceRooms);
  const communities = useStore((state) => state.communities);
  const people = useStore((state) => state.people);
  const me = useStore((state) => state.me);
  const [expanded, setExpanded] = useState(false);
  const screenStream = voice.getScreenStream();

  if (!session.joined && !session.connecting) return null;

  const channel = session.channelId
    ? communities.flatMap((community) => community.channels).find((entry) => entry.id === session.channelId)
    : null;
  const peers = session.channelId ? rooms[session.channelId] ?? [] : [];
  const others = peers.filter((peer) => peer.userId !== me?.id);
  const resharing = peers.find((peer) => peer.sharing && peer.userId !== me?.id);

  return (
    <div className={cx('voice-room', expanded && 'expanded')}>
      <header className="voice-room-head">
        <div className="voice-room-title">
          <span className={session.connecting ? 'status-pip connecting' : 'live-pip'} />
          <div>
            <strong>{channel ? `#${channel.name}` : 'Voice room'}</strong>
            <span>{others.length + 1} connected</span>
          </div>
        </div>
        <div className="voice-room-head-actions">
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => setExpanded((value) => !value)} title={expanded ? 'Minimise' : 'Expand'}>
            <Icon name="users" size={15} />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => setExpanded(false)} title="Minimise">
            <Icon name="chevronDown" size={15} />
          </button>
        </div>
      </header>

      {session.error && (
        <div className="voice-error">
          <Icon name="micOff" size={16} />
          <span>{session.error}</span>
        </div>
      )}

      {session.connecting ? (
        <p className="voice-connecting">Joining and requesting your microphone…</p>
      ) : (
        <>
          {session.sharing && screenStream && (
            <div className="voice-share">
              <VideoStream stream={screenStream} muted />
              <span className="voice-share-label">You are sharing your screen</span>
            </div>
          )}
          {resharing && (
            <div className="voice-share">
              <VideoStream stream={session.participants[resharing.userId] ?? null} muted={false} />
              <span className="voice-share-label">{people[resharing.userId]?.displayName ?? 'Someone'} is sharing</span>
            </div>
          )}

          <div className="voice-tiles">
            <div className="voice-tile">
              {session.camera && session.localStream ? (
                <VideoStream stream={session.localStream} muted mirror />
              ) : (
                <span className="voice-tile-avatar">
                  <Avatar size={44} name={me?.displayName ?? 'You'} url={me?.avatarUrl} id={me?.id} />
                </span>
              )}
              <span className="voice-tile-name">
                {session.muted && <Icon name="micOff" size={11} />} You
              </span>
            </div>

            {others.map((peer) => {
              const person = people[peer.userId];
              const stream = session.participants[peer.userId] ?? null;
              return (
                <div key={peer.userId} className={cx('voice-tile', peer.video && stream && 'has-video')}>
                  {peer.video && stream ? (
                    <VideoStream stream={stream} />
                  ) : (
                    <span className="voice-tile-avatar">
                      <Avatar size={44} name={person?.displayName ?? 'Participant'} url={person?.avatarUrl} id={peer.userId} />
                    </span>
                  )}
                  <span className="voice-tile-name">
                    {peer.muted && <Icon name="micOff" size={11} />}
                    {peer.sharing && <Icon name="screen" size={11} />}
                    {person?.displayName ?? 'Participant'}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="voice-controls">
        <button
          type="button"
          className={cx('voice-btn', session.muted && 'active')}
          onClick={() => voice.toggleMute()}
          title={session.muted ? 'Unmute microphone' : 'Mute microphone'}
        >
          <Icon name={session.muted ? 'micOff' : 'mic'} size={18} />
        </button>
        <button
          type="button"
          className={cx('voice-btn', session.camera && 'active')}
          onClick={() => void voice.toggleCamera()}
          title={session.camera ? 'Turn camera off' : 'Turn camera on'}
        >
          <Icon name={session.camera ? 'camera' : 'cameraOff'} size={18} />
        </button>
        <button
          type="button"
          className={cx('voice-btn', session.sharing && 'active')}
          onClick={() => void voice.toggleShare()}
          title={session.sharing ? 'Stop sharing' : 'Share your screen'}
        >
          <Icon name="screen" size={18} />
        </button>
        <button
          type="button"
          className={cx('voice-btn', session.deafened && 'active')}
          onClick={() => voice.toggleDeafen()}
          title={session.deafened ? 'Undeafen' : 'Deafen'}
        >
          <Icon name="headphones" size={18} />
        </button>
        <button type="button" className="voice-btn leave" onClick={() => leaveVoice()} title="Leave call">
          <Icon name="phoneOff" size={18} />
        </button>
      </div>
    </div>
  );
}

function VideoStream({ stream, muted, mirror }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.srcObject = stream;
    if (stream) void node.play().catch(() => {});
  }, [stream]);

  return (
    <video
      ref={ref}
      className={cx('voice-video', mirror && 'mirror')}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}
