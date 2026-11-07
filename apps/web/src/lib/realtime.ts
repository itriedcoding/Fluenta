import { rewriteServerUrls, serverSocketUrl } from './serverConfig';

export type RealtimeEvent = Record<string, unknown> & { op: string };
export type ConnectionStatus = 'connecting' | 'online' | 'offline';

type StatusListener = (status: ConnectionStatus) => void;

let socket: WebSocket | null = null;
let handler: ((event: RealtimeEvent) => void) | null = null;
let statusListener: StatusListener | null = null;
let status: ConnectionStatus = 'offline';
let retries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let closedByUs = false;

function setStatus(next: ConnectionStatus) {
  if (next === status) return;
  status = next;
  statusListener?.(next);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  closedByUs = false;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  // In server mode the socket lives on the configured backend and authenticates
  // with the session token, because the APK runs on its own origin.
  const url = serverSocketUrl() ?? `${protocol}://${location.host}/ws`;
  setStatus('connecting');
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    retries = 0;
    setStatus('online');
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping', t: Date.now() }));
    }, 25_000);
  };

  ws.onmessage = (message) => {
    try {
      const parsed = rewriteServerUrls(JSON.parse(message.data as string)) as RealtimeEvent;
      handler?.(parsed);
    } catch {
      /* ignore malformed frames */
    }
  };

  ws.onclose = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    setStatus('offline');
    if (closedByUs) return;
    retries += 1;
    const delay = Math.min(12_000, 600 * 2 ** Math.min(retries, 4));
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => ws.close();
}

export const realtime = {
  connect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect();
  },
  disconnect() {
    closedByUs = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    socket?.close();
    socket = null;
    setStatus('offline');
  },
  send(payload: Record<string, unknown>): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  },
  status: () => status,
  onEvent(listener: (event: RealtimeEvent) => void) {
    handler = listener;
  },
  onStatus(listener: StatusListener) {
    statusListener = listener;
    listener(status);
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && status === 'offline') {
      retries = 0;
      connect();
    }
  });
  window.addEventListener('online', () => {
    retries = 0;
    connect();
  });
}
