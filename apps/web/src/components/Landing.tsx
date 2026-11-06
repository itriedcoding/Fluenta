import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { signIn, signUp, useStore } from '../lib/store';
import { Icon, Spinner } from './ui';

type Mode = 'signin' | 'signup' | 'forgot';

type InvitePreview = {
  communityId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  memberCount: number;
};

export function Landing({ invitePath }: { invitePath: string | null }) {
  const authConfig = useStore((state) => state.authConfig);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'google_failed') {
      setError('Google sign-in could not be completed. Please try again or use your email.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!invitePath) return;
    api<{ invite: InvitePreview }>(`/api/auth/invite-preview/${encodeURIComponent(invitePath)}`)
      .then((data) => {
        setInvite(data.invite);
        setMode('signup');
      })
      .catch((err) => setInviteError(err instanceof ApiError ? err.message : 'That invite link is not valid'));
  }, [invitePath]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else if (mode === 'signup') {
        await signUp({
          email: email.trim(),
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
        });
      } else {
        const result = await api<{ delivery: string }>('/api/auth/forgot-password', {
          method: 'POST',
          body: { email: email.trim() },
        });
        setNotice(
          result.delivery === 'email'
            ? 'If that address has an account, a reset link is on its way.'
            : 'This server has no email service configured yet, so reset links are written to the server log. Ask your admin, or sign in with Google if it is enabled.',
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="brand brand-lg">
          <span className="brand-mark">F</span>
          <span className="brand-name">Fluenta</span>
        </div>

        <h1 className="hero-title">
          Conversations that move
          <span className="hero-accent"> at your speed.</span>
        </h1>
        <p className="hero-sub">
          Lightweight communities, direct messages, voice rooms and screen sharing — one fast app for web,
          desktop and Android. No bloat, no noise.
        </p>

        <ul className="hero-points">
          <li>
            <span className="point-icon"><Icon name="sparkle" size={16} /></span>
            <div>
              <strong>Real-time by design</strong>
              <p>Messages, typing and read receipts land instantly over a single WebSocket.</p>
            </div>
          </li>
          <li>
            <span className="point-icon"><Icon name="volume" size={16} /></span>
            <div>
              <strong>Voice, video, screen share</strong>
              <p>Peer-to-peer WebRTC rooms that start in one click and cost almost nothing.</p>
            </div>
          </li>
          <li>
            <span className="point-icon"><Icon name="shield" size={16} /></span>
            <div>
              <strong>Yours to own</strong>
              <p>Self-hostable backend, hashed passwords, scoped sessions and role-based permissions.</p>
            </div>
          </li>
        </ul>

        <div className="hero-stats">
          <div><strong>WebRTC</strong><span>peer-to-peer voice &amp; video</span></div>
          <div><strong>1 backend</strong><span>web · desktop · Android</span></div>
          <div><strong>SQLite</strong><span>zero-config, self-hosted</span></div>
        </div>
      </section>

      <section className="landing-panel">
        <div className="auth-card">
          <header className="auth-head">
            <h2>
              {mode === 'signin' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset your password'}
            </h2>
            <p>
              {mode === 'signin'
                ? 'Sign in to pick up where you left off.'
                : mode === 'signup'
                  ? 'One minute to set up. Free forever on your own server.'
                  : 'We will email you a secure link that expires in one hour.'}
            </p>
          </header>

          {invite && (
            <div className="invite-banner">
              {invite.iconUrl ? (
                <img src={invite.iconUrl} alt="" className="invite-icon" />
              ) : (
                <span className="invite-icon invite-icon-fallback">{invite.name.slice(0, 1).toUpperCase()}</span>
              )}
              <div>
                <strong>You are invited to {invite.name}</strong>
                <span>{invite.memberCount} member{invite.memberCount === 1 ? '' : 's'} · sign up or sign in to join</span>
              </div>
            </div>
          )}
          {inviteError && <p className="auth-error">{inviteError}</p>}

          {mode !== 'forgot' && (
            <div className="auth-tabs">
              <button
                type="button"
                className={mode === 'signin' ? 'auth-tab active' : 'auth-tab'}
                onClick={() => switchMode('signin')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={mode === 'signup' ? 'auth-tab active' : 'auth-tab'}
                onClick={() => switchMode('signup')}
              >
                Create account
              </button>
            </div>
          )}

          <form className="auth-form" onSubmit={submit}>
            {mode === 'signup' && (
              <>
                <label className="field">
                  <span className="field-label">Display name</span>
                  <input
                    className="input"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Alex Rivera"
                    autoComplete="name"
                    maxLength={40}
                    required
                  />
                </label>
                <label className="field">
                  <span className="field-label">Username</span>
                  <input
                    className="input"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    placeholder="alex"
                    autoComplete="username"
                    pattern="[-a-zA-Z0-9._]{3,24}"
                    title="3-24 characters: letters, numbers, dot, dash, underscore"
                    required
                  />
                  <span className="field-hint">Letters, numbers, dot, dash or underscore.</span>
                </label>
              </>
            )}

            <label className="field">
              <span className="field-label">Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>

            {mode !== 'forgot' && (
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={mode === 'signup' ? 8 : 1}
                  required
                />
              </label>
            )}

            {error && <p className="auth-error" role="alert">{error}</p>}
            {notice && <p className="auth-notice">{notice}</p>}

            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? <Spinner size={16} /> : null}
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
            </button>

            {authConfig.google && mode !== 'forgot' && (
              <>
                <div className="divider"><span>or</span></div>
                <a className="btn btn-ghost btn-block google-btn" href="/api/auth/google/start">
                  <Icon name="google" size={18} />
                  Continue with Google
                </a>
              </>
            )}

            <div className="auth-links">
              {mode === 'signin' && (
                <button type="button" className="link-btn" onClick={() => switchMode('forgot')}>
                  Forgot password?
                </button>
              )}
              {mode === 'forgot' && (
                <button type="button" className="link-btn" onClick={() => switchMode('signin')}>
                  Back to sign in
                </button>
              )}
              {mode === 'signup' && !authConfig.registrationOpen && (
                <span className="auth-hint">Registration is currently closed on this server.</span>
              )}
            </div>
          </form>

          <p className="auth-foot">
            By continuing you agree to keep it kind. Fluenta stores only what it needs to run your
            conversations.
          </p>
        </div>
      </section>
    </div>
  );
}
