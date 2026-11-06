import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WebSocket } from 'ws';

import { config, isGoogleEnabled, isMailEnabled } from './config.ts';
import { all, get, run } from './db.ts';
import {
  attachAuth,
  findSession,
  type AuthCtx,
  type Env,
  publicUser,
  requestToken,
  sameOriginGuard,
  sessionCleanup,
  SESSION_COOKIE,
} from './auth.ts';
import { hub } from './realtime.ts';
import { channelAccess, channelAudience, conversationAudience, isCommunityMember, presenceAudience } from './access.ts';
import {
  communityAudienceIds,
  communityPayload,
  communitySummaries,
  presenceFor,
  unreadMap,
  userConversations,
} from './state.ts';
import { PERMISSIONS } from './permissions.ts';
import { now, uid } from './ids.ts';
import authRoutes from './routes/auth.ts';
import meRoutes from './routes/me.ts';
import communityRoutes from './routes/communities.ts';
import channelRoutes from './routes/channels.ts';
import conversationRoutes from './routes/conversations.ts';
import messageRoutes from './routes/messages.ts';
import uploadRoutes from './routes/uploads.ts';
import searchRoutes from './routes/search.ts';
import pushRoutes from './routes/push.ts';

const app = new Hono<Env>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

app.use('*', async (c, next) => {
  await next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(key, value);
});

app.use('/api/*', async (c, next) => {
  const isUpload = c.req.path === '/api/uploads' && c.req.method === 'POST';
  const limit = isUpload ? config.maxUploadBytes + 2 * 1024 * 1024 : 512 * 1024;
  const length = Number(c.req.header('content-length') || 0);
  if (length > limit) return c.json({ error: 'Payload too large' }, 413);
  await next();
});

app.use('/api/*', attachAuth);
app.use('/api/*', sameOriginGuard);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    name: 'Fluenta',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    users: Number(get('SELECT COUNT(*) AS n FROM users')?.n ?? 0),
    mail: isMailEnabled(),
    google: isGoogleEnabled(),
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api/communities', communityRoutes);
app.route('/api/channels', channelRoutes);
app.route('/api/conversations', conversationRoutes);
app.route('/api/messages', messageRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/push', pushRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error('[http]', c.req.method, c.req.path, err);
  return c.json({ error: 'Something went wrong on the server' }, 500);
});

// ---- WebSocket ------------------------------------------------------------

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

app.use('/ws', async (c, next) => {
  const queryToken = c.req.query('token');
  if (queryToken) {
    const session = findSession(queryToken);
    if (session) {
      c.set('auth', { user: session.user, sessionId: session.sessionId, token: queryToken } satisfies AuthCtx);
    }
  }
  await attachAuth(c, next);
});

app.use('/ws', async (c, next) => {
  if (!c.get('auth')) return c.text('Unauthorized', 401);
  await next();
});

type ClientCounter = { count: number; reset: number };
const counters = new WeakMap<WebSocket, ClientCounter>();

function overBudget(raw: WebSocket): boolean {
  const ts = Date.now();
  let counter = counters.get(raw);
  if (!counter || counter.reset < ts) {
    counter = { count: 0, reset: ts + 10_000 };
    counters.set(raw, counter);
  }
  counter.count += 1;
  return counter.count > 120;
}

function readyPayload(userId: string) {
  const user = get<{ id: string; email: string; username: string; display_name: string; avatar_id: string | null; bio: string | null; custom_status: string | null; presence: string; created_at: number; updated_at: number; password_hash: string | null }>(
    'SELECT * FROM users WHERE id = ?',
    userId,
  );
  const communities = all<{
    id: string;
    name: string;
    description: string;
    icon_id: string | null;
    owner_id: string;
    invite_code: string;
    created_at: number;
  }>(
    `SELECT c.* FROM communities c JOIN community_members m ON m.community_id = c.id
     WHERE m.user_id = ? ORDER BY c.created_at`,
    userId,
  ).map((c) => communityPayload(c, userId));
  return {
    op: 'ready',
    user: user ? { ...publicUser(user), presence: presenceFor(userId, user.presence) } : null,
    communities,
    summaries: communitySummaries(userId),
    conversations: userConversations(userId),
    unread: unreadMap(userId),
    voice: hub.allVoiceRooms(),
    serverTime: Date.now(),
  };
}

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    const auth = c.get('auth')!;
    const userId = auth.user.id;
    let client: ReturnType<typeof hub.register> | null = null;

    return {
      onOpen(_evt, ws) {
        const raw = ws.raw as unknown as WebSocket;
        const wasOffline = !hub.isOnline(userId);
        client = hub.register(userId, raw, uid('ws_'));
        hub.sendClient(client, readyPayload(userId));
        if (wasOffline) {
          const stored = get<{ presence: string }>('SELECT presence FROM users WHERE id = ?', userId);
          hub.broadcast(presenceAudience(userId), {
            op: 'presence',
            userId,
            presence: presenceFor(userId, stored?.presence ?? 'online'),
          });
        }
      },

      onMessage(evt, ws) {
        const raw = ws.raw as unknown as WebSocket;
        if (!client) return;
        if (overBudget(raw)) {
          hub.sendClient(client, { op: 'rate_limited' });
          return;
        }
        let msg: {
          op?: string;
          channelId?: string;
          conversationId?: string;
          targetUserId?: string;
          data?: unknown;
          muted?: boolean;
          video?: boolean;
          sharing?: boolean;
          t?: number;
        };
        try {
          msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '{}');
        } catch {
          return;
        }

        switch (msg.op) {
          case 'ping':
            hub.sendClient(client, { op: 'pong', t: msg.t ?? Date.now() });
            return;

          case 'typing': {
            if (msg.channelId) {
              const access = channelAccess(msg.channelId, userId);
              if (!access || access.channel.type !== 'text') return;
              hub.markTyping(`ch:${msg.channelId}`, userId);
              hub.broadcastRaw(
                channelAudience(msg.channelId),
                JSON.stringify({ op: 'typing', channelId: msg.channelId, userId, displayName: auth.user.display_name }),
                userId,
              );
            } else if (msg.conversationId) {
              if (!get('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?', msg.conversationId, userId)) return;
              hub.markTyping(`dm:${msg.conversationId}`, userId);
              hub.broadcastRaw(
                conversationAudience(msg.conversationId),
                JSON.stringify({ op: 'typing', conversationId: msg.conversationId, userId, displayName: auth.user.display_name }),
                userId,
              );
            }
            return;
          }

          case 'voice:join': {
            const channelId = msg.channelId;
            if (!channelId) return;
            const access = channelAccess(channelId, userId);
            if (!access || access.channel.type !== 'voice') return;
            if ((access.permissions & PERMISSIONS.CONNECT_VOICE) !== PERMISSIONS.CONNECT_VOICE) {
              hub.sendClient(client, { op: 'error', message: 'You cannot join that voice channel' });
              return;
            }
            const previous = hub.voiceChannelOf(userId);
            if (previous && previous !== channelId) {
              hub.leaveVoice(previous, userId);
              hub.broadcast(channelAudience(previous), { op: 'voice:leave', channelId: previous, userId });
            }
            const peers = hub.joinVoice(client, channelId, {
              muted: Boolean(msg.muted),
              video: Boolean(msg.video),
              sharing: Boolean(msg.sharing),
            });
            hub.sendClient(client, {
              op: 'voice:peers',
              channelId,
              peers: peers.filter((p) => p.userId !== userId),
            });
            hub.broadcast(channelAudience(channelId), {
              op: 'voice:join',
              channelId,
              peer: peers.find((p) => p.userId === userId),
            });
            return;
          }

          case 'voice:leave': {
            const channelId = hub.voiceChannelOf(userId);
            if (!channelId) return;
            hub.leaveVoice(channelId, userId);
            hub.broadcast(channelAudience(channelId), { op: 'voice:leave', channelId, userId });
            return;
          }

          case 'voice:state': {
            const channelId = hub.voiceChannelOf(userId);
            if (!channelId) return;
            const peer = hub.updateVoice(channelId, userId, {
              muted: Boolean(msg.muted),
              video: Boolean(msg.video),
              sharing: Boolean(msg.sharing),
            });
            if (peer) {
              hub.broadcast(channelAudience(channelId), { op: 'voice:state', channelId, peer });
            }
            return;
          }

          case 'voice:signal': {
            const fromChannel = hub.voiceChannelOf(userId);
            if (!fromChannel || !msg.targetUserId) return;
            if (!hub.voicePeers(fromChannel).some((p) => p.userId === msg.targetUserId)) return;
            hub.send(msg.targetUserId, { op: 'voice:signal', fromUserId: userId, channelId: fromChannel, data: msg.data });
            return;
          }

          default:
            return;
        }
      },

      onClose(_evt, ws) {
        const raw = ws.raw as unknown as WebSocket;
        const voiceChannel = hub.voiceChannelOf(userId);
        const removed = hub.unregister(raw);
        if (!removed) return;
        if (voiceChannel) {
          const stillInVoice = hub.voicePeers(voiceChannel).some((p) => p.userId === userId);
          if (!stillInVoice) {
            hub.broadcast(channelAudience(voiceChannel), { op: 'voice:leave', channelId: voiceChannel, userId });
          }
        }
        if (!hub.isOnline(userId)) {
          setTimeout(() => {
            if (hub.isOnline(userId)) return;
            hub.broadcast(presenceAudience(userId), { op: 'presence', userId, presence: 'offline' });
          }, 2500);
        }
      },
    };
  }),
);

// ---- static SPA -----------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

app.get('*', (c) => {
  const pathname = decodeURIComponent(c.req.path);
  if (pathname.startsWith('/api/') || pathname === '/ws') return c.json({ error: 'Not found' }, 404);

  const normalized = path.normalize(pathname).replace(/^([.][.][/\\])+/, '');
  let file = path.join(config.publicDir, normalized);
  if (!file.startsWith(config.publicDir)) return c.json({ error: 'Not found' }, 404);

  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!exists) {
    if (path.extname(normalized)) return c.json({ error: 'Not found' }, 404);
    file = path.join(config.publicDir, 'index.html');
    if (!fs.existsSync(file)) {
      return c.text('Fluenta API is running. Build the web client with `npm run build` first.', 200);
    }
  }

  const ext = path.extname(file).toLowerCase();
  const isHashed = normalized.startsWith('/assets/');
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (path.basename(file) === 'sw.js') headers['service-worker-allowed'] = '/';
  return new Response(fs.readFileSync(file), { headers });
});

// ---- lifecycle ------------------------------------------------------------

sessionCleanup();
setInterval(() => hub.heartbeat(), 25_000).unref();
setInterval(() => {
  sessionCleanup();
  const cutoff = Date.now() - 30 * 86_400_000;
  run('DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?', cutoff);
}, 6 * 60 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Fluenta listening on http://${config.host}:${info.port}`);
  if (!isMailEnabled()) console.log('[config] SMTP not configured — password reset links go to data/outbox/');
  if (!isGoogleEnabled()) console.log('[config] GOOGLE_CLIENT_ID/SECRET not set — Google sign-in hidden');
  if (config.appOrigin) console.log(`[config] public origin ${config.appOrigin}`);
});
injectWebSocket(server);

const shutdown = () => {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server };
