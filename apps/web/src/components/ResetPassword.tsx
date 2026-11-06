import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { navigate } from '../App';
import { Icon, Spinner } from './ui';

export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
      setTimeout(() => {
        window.location.href = '/';
      }, 1200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span className="brand-name">Fluenta</span>
        </div>
        <header className="auth-head">
          <h2>Choose a new password</h2>
          <p>Pick something at least 8 characters long. All other sessions will be signed out.</p>
        </header>

        {!token && <p className="auth-error">This link is missing its token. Request a new reset email.</p>}
        {done ? (
          <p className="auth-notice">
            <Icon name="check" size={16} /> Password updated. Taking you to sign in…
          </p>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">New password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Confirm password</span>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={busy || !token}>
              {busy && <Spinner size={16} />} Update password
            </button>
            <button type="button" className="link-btn" onClick={() => navigate('/')}>
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
