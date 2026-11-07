/**
 * Server mode.
 *
 * The Android app can be built against a real Fluenta backend by setting
 * `FLUENTA_SERVER_URL` when the bundle is built. In that case every API call,
 * upload and the realtime socket go to that server, authenticated with a bearer
 * session token, and the on-device database is not installed at all.
 *
 * With no URL configured the app keeps running fully on-device, which is what
 * the plain web build and the default APK do.
 */
const TOKEN_KEY = 'fluenta:server-token';

function fromWindow(): string {
  if (typeof window === 'undefined') return '';
  const value = (window as unknown as { __FLUENTA_SERVER__?: string }).__FLUENTA_SERVER__;
  return typeof value === 'string' ? value.trim() : '';
}

function fromEnv(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (env.VITE_FLUENTA_SERVER ?? '').trim();
}

/** Canonical server origin without a trailing slash, or '' for on-device mode. */
export function serverBase(): string {
  const raw = fromWindow() || fromEnv();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function isServerMode(): boolean {
  return serverBase() !== '';
}

export function serverToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function rememberServerToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: the session simply won't survive a reload */
  }
}

export function forgetServerToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Absolute websocket URL (with the session token) for server mode. */
export function serverSocketUrl(): string | null {
  const base = serverBase();
  if (!base) return null;
  const ws = base.replace(/^http/i, 'ws');
  const token = serverToken();
  return `${ws}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/**
 * The server returns root-relative media URLs (`/api/uploads/...`). The Android
 * bundle is served from the WebView origin, so those have to be resolved against
 * the configured backend before React renders them.
 */
export function rewriteServerUrls<T>(value: T): T {
  const base = serverBase();
  if (!base) return value;
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return input.startsWith('/api/') ? `${base}${input}` : input;
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      for (const key of Object.keys(record)) record[key] = walk(record[key]);
      return record;
    }
    return input;
  };
  return walk(value) as T;
}
