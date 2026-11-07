import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  changePassword,
  deleteAccount,
  listSessions,
  revokeSession,
  setNotificationsEnabled,
  setOverlay,
  setPresence,
  setTheme,
  signOut,
  toastError,
  updateProfile,
  uploadAvatar,
  useStore,
} from '../lib/store';
import { disablePush, enablePush, pushState, registerServiceWorker } from '../lib/push';
import { voice } from '../lib/webrtc';
import { isLocalMode } from '../lib/localBackend';
import type { PresenceChoice, SessionInfo } from '../lib/types';
import { formatBytes, formatTimestamp, relativeTime } from '../lib/util';
import { Avatar, Icon, Spinner } from './ui';
import { BadgeChip, BadgeGlyph } from './BadgeChip';
import { useBadgeCatalog } from '../lib/badges';
import {
  changeServer,
  checkForUpdates,
  getAppInfo,
  installUpdate,
  isNativeApp,
  setAutoUpdate,
  useUpdates,
} from '../lib/updater';
import { cx } from '../lib/util';

type Section = 'profile' | 'badges' | 'account' | 'notifications' | 'voice' | 'sessions' | 'appearance' | 'updates';

const SECTIONS: {
  id: Section;
  label: string;
  icon: 'users' | 'shield' | 'bell' | 'mic' | 'lock' | 'sun' | 'sparkle' | 'download';
}[] = [
  { id: 'profile', label: 'Profile', icon: 'users' },
  { id: 'badges', label: 'Badges', icon: 'sparkle' },
  { id: 'account', label: 'Account', icon: 'shield' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'voice', label: 'Voice & video', icon: 'mic' },
  { id: 'sessions', label: 'Sessions', icon: 'lock' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'updates', label: 'App updates', icon: 'download' },
];

export function Settings() {
  const me = useStore((state) => state.me);
  const [section, setSection] = useState<Section>('profile');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlay(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!me) return null;

  return (
    <div className="settings-overlay">
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav">
          <div className="settings-nav-head">
            <span className="brand-mark">F</span>
            <span>Settings</span>
          </div>
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-nav-item ${section === entry.id ? 'active' : ''}`}
              onClick={() => setSection(entry.id)}
            >
              <Icon name={entry.icon} size={16} />
              {entry.label}
            </button>
          ))}
          <button type="button" className="settings-nav-item signout" onClick={() => void signOut()}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </nav>
        <div className="settings-content">
          <header className="settings-head">
            <h2>{SECTIONS.find((entry) => entry.id === section)?.label}</h2>
            <button type="button" className="icon-btn" onClick={() => setOverlay(null)} aria-label="Close settings">
              <Icon name="close" size={20} />
            </button>
          </header>

          {section === 'profile' && <ProfileSection />}
          {section === 'badges' && <BadgesSection />}
          {section === 'account' && <AccountSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'voice' && <VoiceSection />}
          {section === 'sessions' && <SessionsSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'updates' && <UpdatesSection />}
        </div>
      </div>
    </div>
  );
}

function ProfileSection() {
  const me = useStore((state) => state.me)!;
  const [displayName, setDisplayName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [bio, setBio] = useState(me.bio ?? '');
  const [customStatus, setCustomStatus] = useState(me.customStatus ?? '');
  const [presence, setPresenceState] = useState<PresenceChoice>(
    (me.presence === 'offline' ? 'invisible' : me.presence) as PresenceChoice,
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(me.displayName);
    setUsername(me.username);
    setBio(me.bio ?? '');
    setCustomStatus(me.customStatus ?? '');
  }, [me.displayName, me.username, me.bio, me.customStatus]);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      await updateProfile({
        displayName: displayName.trim(),
        username: username.trim(),
        bio: bio.trim(),
        customStatus: customStatus.trim(),
        presence,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="settings-section">
        <div className="icon-uploader">
          <Avatar size={72} name={me.displayName} url={me.avatarUrl} id={me.id} presence={me.presence} />
          <div className="icon-uploader-actions">
            <label className="btn btn-soft btn-sm">
              <Icon name="image" size={15} /> Upload photo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    await uploadAvatar(file);
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
            </label>
            {me.avatarUrl && (
              <button
                type="button"
                className="link-btn"
                onClick={async () => {
                  try {
                    await updateProfile({ avatarId: null });
                  } catch (err) {
                    toastError(err);
                  }
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>

        <label className="field">
          <span className="field-label">Display name</span>
          <input className="input" value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input className="input" value={username} maxLength={24} onChange={(event) => setUsername(event.target.value.toLowerCase())} />
        </label>
        <label className="field">
          <span className="field-label">Custom status</span>
          <input
            className="input"
            value={customStatus}
            maxLength={120}
            placeholder="In a meeting, shipping something…"
            onChange={(event) => setCustomStatus(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">About you</span>
          <textarea className="input textarea" rows={3} maxLength={280} value={bio} onChange={(event) => setBio(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Presence</span>
          <select className="input" value={presence} onChange={(event) => setPresenceState(event.target.value as PresenceChoice)}>
            <option value="online">Online</option>
            <option value="idle">Idle</option>
            <option value="dnd">Do not disturb</option>
            <option value="invisible">Invisible</option>
          </select>
        </label>

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !displayName.trim()}>
            {busy && <Spinner size={16} />} {saved ? 'Saved' : 'Save profile'}
          </button>
        </div>
      </section>
    </>
  );
}

function AccountSection() {
  const me = useStore((state) => state.me)!;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <section className="settings-section">
        <h3>Email</h3>
        <div className="settings-row">
          <div>
            <strong>{me.email}</strong>
            <span>Used to sign in and recover your account.</span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Change password</h3>
        {me.email && (
          <p className="settings-hint">Changing your password signs out every other device.</p>
        )}
        <label className="field">
          <span className="field-label">Current password</span>
          <input className="input" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input className="input" type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={8} />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || next.length < 8 || !current}
            onClick={async () => {
              setBusy(true);
              try {
                await changePassword(current, next);
                setCurrent('');
                setNext('');
              } catch (err) {
                toastError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner size={16} />} Update password
          </button>
        </div>
      </section>

      <section className="settings-section danger-zone">
        <h3>Delete account</h3>
        <p className="settings-hint">
          Removes your profile, messages you sent and memberships. Communities you own are deleted too.
          This cannot be undone.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (window.confirm('Delete your Fluenta account and everything in it? This cannot be undone.')) {
              void deleteAccount();
            }
          }}
        >
          Delete my account
        </button>
      </section>
    </>
  );
}

function NotificationsSection() {
  const notifications = useStore((state) => state.notifications);
  const [state, setState] = useState(pushState());
  const [busy, setBusy] = useState(false);

  return (
    <section className="settings-section">
      <h3>Push notifications</h3>
      <p className="settings-hint">
        {isLocalMode()
          ? 'This build keeps everything on your phone, so there is no push service to set up. In-app alerts appear while the app is running.'
          : 'Fluenta delivers notifications through the browser push service on web and desktop.'}
      </p>
      <div className="settings-row">
        <div>
          <strong>Device notifications</strong>
          <span>
            {state === 'unsupported'
              ? 'This browser does not support push notifications.'
              : state === 'granted'
                ? 'Permission granted. New messages reach this device even when the tab is closed.'
                : state === 'denied'
                  ? 'Blocked in your browser settings. Allow notifications for this site to enable pushes.'
                  : 'Not enabled yet.'}
          </span>
        </div>
        {state !== 'unsupported' && state !== 'denied' && (
          <button
            type="button"
            className="btn btn-soft"
            disabled={busy || state === 'granted'}
            onClick={async () => {
              setBusy(true);
              try {
                await registerServiceWorker();
                const ok = await enablePush();
                setState(pushState());
                setNotificationsEnabled(ok);
              } catch (err) {
                toastError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size={16} /> : <Icon name="bell" size={16} />} {state === 'granted' ? 'Enabled' : 'Enable'}
          </button>
        )}
        {state === 'granted' && (
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              await disablePush();
              setNotificationsEnabled(false);
              setState(pushState());
            }}
          >
            Turn off
          </button>
        )}
      </div>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={notifications}
          onChange={(event) => setNotificationsEnabled(event.target.checked)}
        />
        <span>
          <strong>In-app alerts</strong>
          <small>Show a system notification when a message arrives while the app is in the background.</small>
        </span>
      </label>

      <div className="settings-note">
        <Icon name="shield" size={15} />
        <span>Muted conversations never trigger a notification.</span>
      </div>
    </section>
  );
}

function VoiceSection() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        setDevices(list);
        const audio = list.find((device) => device.kind === 'audioinput');
        const video = list.find((device) => device.kind === 'videoinput');
        if (audio) setAudioId(audio.deviceId);
        if (video) setVideoId(video.deviceId);
      })
      .catch(() => setDevices([]));
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  async function toggleTest() {
    if (testing) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      cancelAnimationFrame(rafRef.current);
      setTesting(false);
      setLevel(0);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioId ? { deviceId: { exact: audioId } } : true,
      });
      streamRef.current = stream;
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const average = data.reduce((sum, value) => sum + value, 0) / data.length;
        setLevel(Math.min(1, average / 90));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setTesting(true);
    } catch {
      toastError('Microphone access was blocked');
    }
  }

  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const outputs = devices.filter((device) => device.kind === 'videoinput');

  return (
    <section className="settings-section">
      <h3>Devices</h3>
      <label className="field">
        <span className="field-label">Microphone</span>
        <select
          className="input"
          value={audioId}
          onChange={(event) => {
            setAudioId(event.target.value);
            voice.setPreferredDevice('audio', event.target.value || null);
          }}
        >
          {inputs.length === 0 && <option value="">No microphone detected</option>}
          {inputs.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Microphone ${index + 1}`}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Camera</span>
        <select
          className="input"
          value={videoId}
          onChange={(event) => {
            setVideoId(event.target.value);
            voice.setPreferredDevice('video', event.target.value || null);
          }}
        >
          {outputs.length === 0 && <option value="">No camera detected</option>}
          {outputs.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Camera ${index + 1}`}
            </option>
          ))}
        </select>
      </label>

      <div className="mic-test">
        <button type="button" className={`btn ${testing ? 'btn-danger' : 'btn-soft'}`} onClick={() => void toggleTest()}>
          <Icon name={testing ? 'micOff' : 'mic'} size={16} /> {testing ? 'Stop test' : 'Test microphone'}
        </button>
        <div className="mic-meter" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, index) => (
            <span
              key={index}
              className={level * 14 > index ? 'lit' : ''}
              style={level * 14 > index ? { background: index > 10 ? 'var(--accent)' : 'var(--ok)' } : undefined}
            />
          ))}
        </div>
      </div>

      <div className="settings-note">
        <Icon name="volume" size={15} />
        <span>
          Calls are peer-to-peer over WebRTC. On strict networks, set <code>window.__FLUENTA_ICE__</code> with
          your TURN server before the app loads.
        </span>
      </div>
    </section>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((err) => toastError(err));
  }, []);

  return (
    <section className="settings-section">
      <h3>Active sessions</h3>
      <p className="settings-hint">Every device signed in to your account. Revoke anything you do not recognise.</p>
      {!sessions && <Spinner size={18} />}
      <div className="session-list">
        {sessions?.map((session) => (
          <div key={session.id} className="session-row">
            <span className="session-icon">
              <Icon name="lock" size={15} />
            </span>
            <div className="session-text">
              <strong>
                {describeAgent(session.userAgent)} {session.current && <span className="tag">this device</span>}
              </strong>
              <span>
                {session.ip ?? 'unknown ip'} · last active {relativeTime(session.lastSeenAt)} · signed in{' '}
                {formatTimestamp(session.createdAt)}
              </span>
            </div>
            {!session.current && (
              <button
                type="button"
                className="btn btn-danger-ghost btn-xs"
                onClick={async () => {
                  try {
                    await revokeSession(session.id);
                    setSessions((current) => current?.filter((entry) => entry.id !== session.id) ?? null);
                  } catch (err) {
                    toastError(err);
                  }
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function describeAgent(agent: string | null) {
  if (!agent) return 'Unknown device';
  if (/android/i.test(agent)) return 'Android app';
  if (/electron/i.test(agent)) return 'Desktop app';
  if (/iphone|ipad/i.test(agent)) return 'iOS device';
  if (/chrome/i.test(agent)) return 'Chrome';
  if (/firefox/i.test(agent)) return 'Firefox';
  if (/safari/i.test(agent)) return 'Safari';
  return 'Web browser';
}

function BadgesSection() {
  const me = useStore((state) => state.me)!;
  const { catalog, loading, error } = useBadgeCatalog();
  const mine = me.badges ?? [];

  return (
    <>
      <section className="settings-section">
        <h3>Your badges</h3>
        <p className="settings-hint">
          Badges live on your account, so they follow you across web, desktop and Android. Automatic badges
          are earned here; everything else is granted by this server's founder.
        </p>
        {mine.length === 0 ? (
          <p className="settings-hint">No badges yet.</p>
        ) : (
          <div className="profile-badges">
            {mine.map((key) => (
              <BadgeChip key={key} badgeKey={key} showLabel size={15} />
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Every badge on this server</h3>
        {loading && !catalog && <Spinner size={18} />}
        {error && <p className="auth-error">{error}</p>}
        <div className="badge-catalog">
          {catalog?.map((badge) => {
            const earned = mine.includes(badge.key);
            return (
              <article key={badge.key} className={cx('badge-card', earned && 'earned')}>
                <span
                  className="badge-card-icon"
                  style={{ '--badge-color': badge.color } as CSSProperties}
                >
                  <BadgeGlyph icon={badge.icon} size={18} />
                </span>
                <div>
                  <strong>
                    {badge.name}
                    {earned && <span className="tag">earned</span>}
                    {badge.automatic && <span className="tag tag-muted">automatic</span>}
                  </strong>
                  <p>{badge.description}</p>
                  <small>{badge.howToEarn}</small>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

function UpdatesSection() {
  const updates = useUpdates();
  const info = updates.info;
  const native = isNativeApp();
  const local = isLocalMode();

  useEffect(() => {
    void getAppInfo();
  }, []);

  const release = updates.release;
  const published = release?.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : null;

  return (
    <>
      <section className="settings-section">
        <h3>Installed app</h3>
        <div className="settings-row">
          <div>
            <strong>Fluenta {info ? info.version : '…'}</strong>
            <span>
              {info?.platform === 'android'
                ? `Android build ${info.build}`
                : info?.platform === 'desktop'
                  ? 'Desktop shell'
                  : 'Web client'}
            </span>
          </div>
          <span className={cx('tag', native ? 'tag-live' : 'tag-muted')}>{native ? 'Android app' : 'Browser'}</span>
        </div>
        <p className="settings-hint">
          Automatic updates are delivered from this project's GitHub releases. The app checks once every six
          hours, downloads the APK over HTTPS and hands it to Android's package installer.
        </p>
      </section>

      <section className="settings-section">
        <h3>Updates</h3>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={updates.auto}
            disabled={!native}
            onChange={(event) => setAutoUpdate(event.target.checked)}
          />
          <span>
            <strong>Check for updates automatically</strong>
            <small>At most once every six hours, only in the Android app.</small>
          </span>
        </label>

        <div className="settings-row">
          <div>
            <strong>
              {updates.status === 'checking'
                ? 'Checking…'
                : updates.status === 'current'
                  ? 'You are up to date'
                  : updates.status === 'available'
                    ? 'Update available'
                    : updates.status === 'downloading'
                      ? 'Downloading update'
                      : updates.status === 'ready'
                        ? 'Ready to install'
                        : updates.status === 'unsupported'
                          ? 'Updates are for the Android app'
                          : updates.status === 'error'
                            ? 'Update check failed'
                            : 'Not checked yet'}
            </strong>
            <span>
              {updates.lastChecked
                ? `Last checked ${relativeTime(updates.lastChecked)}`
                : native
                  ? 'Never checked on this device.'
                  : 'This browser copy updates with the server it is loaded from.'}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-soft"
            disabled={updates.status === 'checking' || updates.status === 'downloading' || !native}
            onClick={() => void checkForUpdates({ force: true })}
          >
            {updates.status === 'checking' ? <Spinner size={16} /> : <Icon name="download" size={16} />} Check now
          </button>
        </div>

        {updates.error && <p className="auth-error">{updates.error}</p>}

        {release && updates.status !== 'current' && (
          <article className="update-card">
            <header>
              <div>
                <strong>Fluenta {release.version}</strong>
                <span>
                  {published ? `Released ${published}` : 'Release'}
                  {release.apkSize ? ` · ${formatBytes(release.apkSize)}` : ''}
                </span>
              </div>
              <span className="tag">latest</span>
            </header>
            {release.notes && <pre className="update-notes">{release.notes}</pre>}
            {updates.status === 'downloading' && (
              <div className="update-progress" role="progressbar" aria-valuenow={updates.progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.max(4, updates.progress)}%` }} />
                <small>{updates.progress > 0 ? `${Math.round(updates.progress)}%` : 'Starting download…'}</small>
              </div>
            )}
            <div className="settings-actions">
              {updates.status === 'available' && (
                <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}>
                  <Icon name="download" size={16} /> Download &amp; install
                </button>
              )}
              {updates.status === 'ready' && (
                <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}>
                  <Icon name="download" size={16} /> Install again
                </button>
              )}
              <a className="btn btn-ghost" href={release.htmlUrl} target="_blank" rel="noreferrer">
                <Icon name="link" size={15} /> Release page
              </a>
            </div>
          </article>
        )}

        {updates.status === 'ready' && (
          <div className="settings-note">
            <Icon name="check" size={15} />
            <span>Android's installer is open. Confirm the update there to finish.</span>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Where your data lives</h3>
        <div className="settings-row">
          <div>
            <strong>{local ? 'On this device' : window.location.host}</strong>
            <span>
              {local
                ? 'Your account, communities, messages and uploads are stored in this app on your phone. Nothing is sent to a server.'
                : 'This app talks to the Fluenta server that served it.'}
            </span>
          </div>
          {native && !local && (
            <button type="button" className="btn btn-soft" onClick={() => void changeServer()}>
              Change server
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function AppearanceSection() {
  const theme = useStore((state) => state.theme);
  return (
    <section className="settings-section">
      <h3>Theme</h3>
      <p className="settings-hint">Fluenta ships with a deep black theme and a crisp light theme. Both use the same dark-red accent.</p>
      <div className="theme-choices">
        <button type="button" className={`theme-choice ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>
          <span className="theme-swatch theme-dark">
            <span className="swatch-bar" />
            <span className="swatch-line" />
            <span className="swatch-line short" />
          </span>
          Dark
          {theme === 'dark' && <Icon name="check" size={14} />}
        </button>
        <button type="button" className={`theme-choice ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>
          <span className="theme-swatch theme-light">
            <span className="swatch-bar" />
            <span className="swatch-line" />
            <span className="swatch-line short" />
          </span>
          Light
          {theme === 'light' && <Icon name="check" size={14} />}
        </button>
      </div>
      <div className="settings-note">
        <Icon name="sparkle" size={15} />
        <span>Animations respect your system “reduce motion” preference.</span>
      </div>
    </section>
  );
}
