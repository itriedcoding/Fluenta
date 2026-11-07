import { useSyncExternalStore } from 'react';
import { storageGet, storageSet } from './util';
import { isNewerVersion, versionParts } from './version';

export { isNewerVersion, versionParts };

/**
 * Android auto-update, wired to this project's GitHub Releases.
 *
 * The web client asks GitHub for the newest published release, compares it with
 * the installed APK version reported by the native bridge, then hands the APK
 * URL to DownloadManager. Nothing here is simulated: if GitHub has no release or
 * the network is down, the UI says so.
 */
export const GITHUB_REPO = 'itriedcoding/Fluenta';
export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CACHE_KEY = 'fluenta:update-cache';
const PREFS_KEY = 'fluenta:update-prefs';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export type AppInfo = {
  version: string;
  build: number;
  platform: 'android' | 'web' | 'desktop';
  native: boolean;
};

export type ReleaseInfo = {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  htmlUrl: string;
  apkUrl: string | null;
  apkSize: number | null;
};

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unsupported'
  | 'error';

export type UpdateState = {
  status: UpdateStatus;
  info: AppInfo | null;
  release: ReleaseInfo | null;
  progress: number;
  error: string | null;
  lastChecked: number | null;
  auto: boolean;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; size?: number; browser_download_url?: string }[];
};

type NativePlugin = {
  getInfo(): Promise<{ versionName?: string; versionCode?: number; platform?: string }>;
  installUpdate(options: { url: string; version: string }): Promise<void>;
  openInstallSettings(): Promise<void>;
  changeServer(): Promise<void>;
  probeServer(options: { url: string }): Promise<{ ok: boolean; name?: string; version?: string; error?: string }>;
  setServer(options: { url: string }): Promise<{ ok: boolean; error?: string }>;
  addListener(event: string, callback: (data: Record<string, unknown>) => void): Promise<{ remove(): Promise<void> }>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
};

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** The native bridge, or null when the same client runs in a browser. */
export function nativePlugin(): NativePlugin | null {
  const plugins = capacitor()?.Plugins as Record<string, NativePlugin> | undefined;
  return plugins?.FluentaNative ?? null;
}

export function isNativeApp(): boolean {
  const cap = capacitor();
  return Boolean(cap && (cap.isNativePlatform?.() ?? false) && nativePlugin());
}

function prefs(): { auto: boolean; lastCheck: number } {
  const saved = storageGet<{ auto?: boolean; lastCheck?: number }>(PREFS_KEY, {});
  return { auto: saved.auto !== false, lastCheck: Number(saved.lastCheck ?? 0) };
}

let state: UpdateState = {
  status: 'idle',
  info: null,
  release: null,
  progress: 0,
  error: null,
  lastChecked: prefs().lastCheck || null,
  auto: prefs().auto,
};
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdates(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

let infoPromise: Promise<AppInfo> | null = null;

export function getAppInfo(): Promise<AppInfo> {
  if (state.info) return Promise.resolve(state.info);
  if (infoPromise) return infoPromise;
  infoPromise = (async () => {
    const plugin = nativePlugin();
    if (plugin) {
      try {
        const info = await plugin.getInfo();
        const value: AppInfo = {
          version: info.versionName ?? '0.0.0',
          build: Number(info.versionCode ?? 0),
          platform: 'android',
          native: true,
        };
        set({ info: value });
        return value;
      } catch {
        /* fall through to the web description */
      }
    }
    let version = 'unknown';
    try {
      const health = await fetch('/api/health', { headers: { accept: 'application/json' } });
      if (health.ok) version = String(((await health.json()) as { version?: string }).version ?? 'unknown');
    } catch {
      /* offline: keep "unknown" rather than inventing a version */
    }
    const value: AppInfo = {
      version,
      build: 0,
      platform: /electron/i.test(navigator.userAgent) ? 'desktop' : 'web',
      native: false,
    };
    set({ info: value });
    return value;
  })().finally(() => {
    infoPromise = null;
  });
  return infoPromise;
}

async function fetchLatestRelease(force = false): Promise<ReleaseInfo> {
  const cache = storageGet<{ etag?: string; release?: ReleaseInfo }>(CACHE_KEY, {});
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (cache.etag && !force) headers['if-none-match'] = cache.etag;

  let response: Response;
  try {
    response = await fetch(LATEST_RELEASE_API, { headers });
  } catch {
    throw new Error('Could not reach GitHub. Check your connection and try again.');
  }
  if (response.status === 304 && cache.release) return cache.release;
  if (response.status === 404) throw new Error('This project has no published releases yet.');
  if (response.status === 403) {
    throw new Error('GitHub rate limit reached. Try again in a few minutes.');
  }
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);

  const data = (await response.json()) as GitHubRelease;
  if (data.draft || data.prerelease) throw new Error('The newest release is a pre-release.');
  const tag = String(data.tag_name ?? '');
  const assets = data.assets ?? [];
  const apk = assets.find((asset) => (asset.name ?? '').toLowerCase().endsWith('.apk'));
  const release: ReleaseInfo = {
    version: tag.replace(/^v/i, '') || '0.0.0',
    tag,
    name: String(data.name ?? tag),
    notes: String(data.body ?? '').trim(),
    publishedAt: String(data.published_at ?? ''),
    htmlUrl: String(data.html_url ?? RELEASES_PAGE),
    apkUrl: apk?.browser_download_url ?? null,
    apkSize: typeof apk?.size === 'number' ? apk.size : null,
  };
  const etag = response.headers.get('etag') ?? undefined;
  storageSet(CACHE_KEY, { etag, release });
  return release;
}

export async function checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateState> {
  if (state.status === 'checking' || state.status === 'downloading') return state;
  const plugin = nativePlugin();
  const info = await getAppInfo();
  if (!plugin || info.platform !== 'android') {
    set({ status: 'unsupported', release: null, error: null });
    return state;
  }

  set({ status: 'checking', error: null });
  const startedAt = Date.now();
  try {
    const release = await fetchLatestRelease(options.force ?? false);
    const lastChecked = Date.now();
    const saved = prefs();
    storageSet(PREFS_KEY, { ...saved, lastCheck: lastChecked });
    if (!release.apkUrl) {
      set({
        status: 'error',
        release,
        lastChecked,
        error: 'That release has no APK attached yet.',
      });
      return state;
    }
    set({
      status: isNewerVersion(release.version, info.version) ? 'available' : 'current',
      release,
      lastChecked,
      error: null,
      progress: 0,
    });
    return state;
  } catch (err) {
    set({
      status: 'error',
      lastChecked: Date.now(),
      error: err instanceof Error ? err.message : 'Could not check for updates.',
    });
    return state;
  } finally {
    void startedAt;
  }
}

/** Called once when the app boots: at most one check every six hours. */
let autoCheckStarted = false;
export async function maybeAutoCheckUpdates(): Promise<void> {
  if (autoCheckStarted) return;
  autoCheckStarted = true;
  if (!isNativeApp()) return;
  const info = await getAppInfo();
  if (info.platform !== 'android') return;
  const saved = prefs();
  if (!saved.auto) return;
  if (saved.lastCheck && Date.now() - saved.lastCheck < CHECK_INTERVAL) {
    // Still show a cached "available" result without a network round trip.
    return;
  }
  await checkForUpdates();
}

let listenerAttached = false;

async function attachDownloadListener(plugin: NativePlugin) {
  if (listenerAttached) return;
  listenerAttached = true;
  await plugin.addListener('update', (data) => {
    const status = String(data.status ?? '');
    if (status === 'downloading') {
      set({ status: 'downloading', progress: Number(data.progress ?? 0) });
    } else if (status === 'complete') {
      set({ status: 'ready', progress: 100 });
    } else if (status === 'failed') {
      set({
        status: 'error',
        error: String(data.message ?? 'The update download failed. Open the release page to download it manually.'),
      });
    } else if (status === 'installing') {
      set({ status: 'ready', progress: 100 });
    }
  });
}

export async function installUpdate(): Promise<void> {
  const plugin = nativePlugin();
  const release = state.release;
  if (!plugin) {
    set({ status: 'error', error: 'Automatic installs only work in the Android app.' });
    return;
  }
  if (!release?.apkUrl) {
    set({ status: 'error', error: 'That release has no APK attached yet.' });
    return;
  }
  set({ status: 'downloading', progress: 0, error: null });
  await attachDownloadListener(plugin);
  try {
    await plugin.installUpdate({ url: release.apkUrl, version: release.version });
  } catch (err) {
    set({
      status: 'error',
      error: err instanceof Error ? err.message : 'Could not start the download.',
    });
  }
}

export function setAutoUpdate(enabled: boolean): void {
  storageSet(PREFS_KEY, { ...prefs(), auto: enabled });
  set({ auto: enabled });
  if (enabled) void checkForUpdates();
}

export async function changeServer(): Promise<void> {
  const plugin = nativePlugin();
  if (!plugin) return;
  await plugin.changeServer();
}
