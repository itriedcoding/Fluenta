/**
 * End-to-end API + realtime tests. Spawns a real Fluenta server against a
 * throwaway database and exercises auth, communities, messaging, uploads,
 * search, permissions and WebSocket sync/signaling.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

function waitForHealth(timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return resolve(await res.json());
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function sessionCookie(cookies) {
  const raw = cookies.find((c) => c.startsWith('fluenta_session='));
  assert.ok(raw, 'expected a session cookie');
  return raw.split(';')[0];
}

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, cookies: res.headers.getSetCookie?.() ?? [] };
}

function openSocket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
    const events = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      events.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        events,
        send: (payload) => ws.send(JSON.stringify(payload)),
        waitFor(match, timeout = 4000) {
          const existing = events.find(match);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timed out waiting for ${match}`)), timeout);
            waiters.push({
              match,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluenta-test-'));
  child = spawn(process.execPath, ['apps/server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', FLUENTA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('ExperimentalWarning')) process.stderr.write(`[server] ${text}`);
  });
  await waitForHealth();
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('signup, session and profile', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'alice@example.com', username: 'alice', displayName: 'Alice', password: 'correct horse battery' },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.data));
  assert.equal(signup.data.user.username, 'alice');

  const cookie = sessionCookie(signup.cookies);
  const me = await api('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'alice@example.com');

  const duplicate = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'alice@example.com', username: 'alice2', displayName: 'Alice 2', password: 'correct horse battery' },
  });
  assert.equal(duplicate.status, 409);

  const weak = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'weak@example.com', username: 'weakling', displayName: 'Weak', password: 'short' },
  });
  assert.equal(weak.status, 400);

  const profile = await api('/api/me', {
    method: 'PATCH',
    cookie,
    body: { displayName: 'Alice A.', customStatus: 'Heads down', bio: 'Building things', presence: 'dnd' },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.user.displayName, 'Alice A.');
  assert.equal(profile.data.user.customStatus, 'Heads down');

  const wrongLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'nope' },
  });
  assert.equal(wrongLogin.status, 401);

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'ALICE@example.com', password: 'correct horse battery' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  const reset = await api('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'alice@example.com' },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.ok, true);
  const outbox = fs.readdirSync(path.join(dataDir, 'outbox'));
  assert.ok(outbox.length >= 1, 'reset email should land in the outbox when SMTP is absent');
  const mail = fs.readFileSync(path.join(dataDir, 'outbox', outbox[0]), 'utf8');
  const token = /reset\?token=([A-Za-z0-9_-]+)/.exec(mail)?.[1];
  assert.ok(token, 'reset link should contain a token');

  const changed = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token, password: 'a brand new password' },
  });
  assert.equal(changed.status, 200);
  const relogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  assert.equal(relogin.status, 200);
});

test('communities, invitations, channels and roles', async () => {
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);
  const bob = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'bob@example.com', username: 'bob', displayName: 'Bob', password: 'bob password 123' },
  });
  const bobCookie = sessionCookie(bob.cookies);

  const created = await api('/api/communities', {
    method: 'POST',
    cookie: aliceCookie,
    body: { name: 'Design Guild', description: 'Where design happens' },
  });
  assert.equal(created.status, 201);
  const community = created.data.community;
  assert.equal(community.name, 'Design Guild');
  assert.equal(community.channels.length, 2);
  assert.ok(community.roles.some((r) => r.isDefault));

  const preview = await api(`/api/communities/invites/${community.inviteCode}`, { cookie: bobCookie });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.invite.name, 'Design Guild');

  const joined = await api('/api/communities/join', {
    method: 'POST',
    cookie: bobCookie,
    body: { code: community.inviteCode },
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.community.members.length, 2);

  // Bob is a member but not an admin
  const denied = await api(`/api/communities/${community.id}/channels`, {
    method: 'POST',
    cookie: bobCookie,
    body: { name: 'secret' },
  });
  assert.equal(denied.status, 403);

  const channel = await api(`/api/communities/${community.id}/channels`, {
    method: 'POST',
    cookie: aliceCookie,
    body: { name: 'Show and Tell', topic: 'Share your work', type: 'text' },
  });
  assert.equal(channel.status, 201);
  const newChannel = channel.data.community.channels.find((ch) => ch.name === 'show-and-tell');
  assert.ok(newChannel);
  assert.equal(newChannel.topic, 'Share your work');

  const role = await api(`/api/communities/${community.id}/roles`, {
    method: 'POST',
    cookie: aliceCookie,
    body: { name: 'Designer', color: '#8b1e2d', permissions: 1 << 6 },
  });
  assert.equal(role.status, 201);
  const designer = role.data.community.roles.find((r) => r.name === 'Designer');
  assert.ok(designer);
  assert.equal(designer.permissions, 1 << 6);

  const assigned = await api(`/api/communities/${community.id}/members/${bob.data.user.id}/roles`, {
    method: 'PUT',
    cookie: aliceCookie,
    body: { roleIds: [designer.id] },
  });
  assert.equal(assigned.status, 200);
  assert.ok(
    assigned.data.community.members.find((m) => m.userId === bob.data.user.id).roles.includes(designer.id),
  );

  const inviteRotated = await api(`/api/communities/${community.id}/invites`, {
    method: 'POST',
    cookie: aliceCookie,
  });
  assert.equal(inviteRotated.status, 200);
  assert.notEqual(inviteRotated.data.inviteCode, community.inviteCode);

  const stale = await api('/api/communities/join', {
    method: 'POST',
    cookie: bobCookie,
    body: { code: community.inviteCode },
  });
  assert.equal(stale.status, 404);
});

test('messaging, replies, edits, reactions, receipts and search', async () => {
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);
  const aliceId = alice.data.user.id;
  const bob = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'bob@example.com', password: 'bob password 123' },
  });
  const bobCookie = sessionCookie(bob.cookies);
  const bobId = bob.data.user.id;

  const communities = await api('/api/communities', { cookie: aliceCookie });
  const communityId = communities.data.communities[0].id;
  const detail = await api(`/api/communities/${communityId}`, { cookie: aliceCookie });
  const channel = detail.data.community.channels.find((ch) => ch.type === 'text');

  const aliceSocket = await openSocket(aliceCookie);
  const bobSocket = await openSocket(bobCookie);
  await aliceSocket.waitFor((m) => m.op === 'ready');
  await bobSocket.waitFor((m) => m.op === 'ready');

  const sent = await api(`/api/channels/${channel.id}/messages`, {
    method: 'POST',
    cookie: aliceCookie,
    body: { content: 'Hello **Fluenta**, this is the first message' },
  });
  assert.equal(sent.status, 201);
  const message = sent.data.message;
  assert.equal(message.author.id, aliceId);

  const delivered = await bobSocket.waitFor((m) => m.op === 'message:new' && m.message.id === message.id);
  assert.equal(delivered.message.content, 'Hello **Fluenta**, this is the first message');

  const reply = await api(`/api/channels/${channel.id}/messages`, {
    method: 'POST',
    cookie: bobCookie,
    body: { content: 'Replying to the first message', replyToId: message.id },
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.message.replyTo.id, message.id);
  assert.equal(reply.data.message.replyTo.author.displayName, 'Alice A.');
  await aliceSocket.waitFor((m) => m.op === 'message:new' && m.message.id === reply.data.message.id);

  const edited = await api(`/api/messages/${message.id}`, {
    method: 'PATCH',
    cookie: aliceCookie,
    body: { content: 'Hello Fluenta, edited' },
  });
  assert.equal(edited.status, 200);
  const updated = await bobSocket.waitFor((m) => m.op === 'message:update' && m.message.id === message.id);
  assert.equal(updated.message.content, 'Hello Fluenta, edited');

  const notMine = await api(`/api/messages/${message.id}`, {
    method: 'PATCH',
    cookie: bobCookie,
    body: { content: 'hijack' },
  });
  assert.equal(notMine.status, 403);

  const reacted = await api(`/api/messages/${message.id}/reactions/${encodeURIComponent('🔥')}`, {
    method: 'PUT',
    cookie: bobCookie,
  });
  assert.equal(reacted.status, 200);
  await aliceSocket.waitFor((m) => m.op === 'reaction' && m.messageId === message.id && m.emoji === '🔥');

  const fetched = await api(`/api/channels/${channel.id}/messages`, { cookie: aliceCookie });
  const withReaction = fetched.data.messages.find((m) => m.id === message.id);
  assert.equal(withReaction.reactions[0].emoji, '🔥');
  assert.equal(withReaction.reactions[0].count, 1);

  await api(`/api/channels/${channel.id}/read`, { method: 'POST', cookie: bobCookie });
  await aliceSocket.waitFor((m) => m.op === 'read' && m.userId === bobId && m.channelId === channel.id);
  const reread = await api(`/api/channels/${channel.id}/messages`, { cookie: aliceCookie });
  assert.ok(
    reread.data.messages.find((m) => m.id === message.id).readBy.includes(bobId),
    'read receipt should reference bob',
  );

  const search = await api('/api/search?q=first', { cookie: bobCookie });
  assert.equal(search.status, 200);
  assert.ok(search.data.messages.length >= 1);
  assert.ok(search.data.messages[0].snippet.length > 0);

  const userSearch = await api('/api/search?q=ali', { cookie: bobCookie });
  assert.ok(userSearch.data.users.some((u) => u.username === 'alice'));

  const removed = await api(`/api/messages/${message.id}`, { method: 'DELETE', cookie: aliceCookie });
  assert.equal(removed.status, 200);
  const tombstone = await bobSocket.waitFor((m) => m.op === 'message:delete' && m.id === message.id);
  assert.equal(tombstone.id, message.id);

  aliceSocket.close();
  bobSocket.close();
});

test('direct messages and unread counts', async () => {
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);
  const bob = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'bob@example.com', password: 'bob password 123' },
  });
  const bobCookie = sessionCookie(bob.cookies);

  const dm = await api('/api/conversations', {
    method: 'POST',
    cookie: aliceCookie,
    body: { type: 'dm', userIds: [bob.data.user.id] },
  });
  assert.equal(dm.status, 201);
  const conversationId = dm.data.conversation.id;

  const again = await api('/api/conversations', {
    method: 'POST',
    cookie: aliceCookie,
    body: { type: 'dm', userIds: [bob.data.user.id] },
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.conversation.id, conversationId);

  const bobSocket = await openSocket(bobCookie);
  await bobSocket.waitFor((m) => m.op === 'ready');

  const message = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    cookie: aliceCookie,
    body: { content: 'hey bob, private chat' },
  });
  assert.equal(message.status, 201);
  await bobSocket.waitFor((m) => m.op === 'message:new' && m.message.conversationId === conversationId);

  const list = await api('/api/conversations', { cookie: bobCookie });
  const entry = list.data.conversations.find((c) => c.id === conversationId);
  assert.equal(entry.unread, 1);
  assert.equal(entry.members.length, 2);

  await api(`/api/conversations/${conversationId}/read`, { method: 'POST', cookie: bobCookie });
  const after = await api('/api/conversations', { cookie: bobCookie });
  assert.equal(after.data.conversations.find((c) => c.id === conversationId).unread, 0);

  const outsider = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: 'carol@example.com', username: 'carol', displayName: 'Carol', password: 'carol password 123' },
  });
  const carolCookie = sessionCookie(outsider.cookies);
  const forbidden = await api(`/api/conversations/${conversationId}/messages`, { cookie: carolCookie });
  assert.equal(forbidden.status, 404);

  const privateDm = await api('/api/conversations', {
    method: 'POST',
    cookie: carolCookie,
    body: { type: 'dm', userIds: [alice.data.user.id] },
  });
  assert.equal(privateDm.status, 403, 'strangers cannot open a DM');

  bobSocket.close();
});

test('file uploads and attachments', async () => {
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);

  // 1x1 transparent PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const uploadRes = await fetch(`${BASE}/api/uploads`, { method: 'POST', headers: { cookie: aliceCookie }, body: form });
  const upload = await uploadRes.json();
  assert.equal(uploadRes.status, 201, JSON.stringify(upload));
  assert.equal(upload.upload.isImage, true);

  const raw = await fetch(`${BASE}${upload.upload.url}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/png');

  const communities = await api('/api/communities', { cookie: aliceCookie });
  const detail = await api(`/api/communities/${communities.data.communities[0].id}`, { cookie: aliceCookie });
  const channel = detail.data.community.channels.find((ch) => ch.type === 'text');

  const sent = await api(`/api/channels/${channel.id}/messages`, {
    method: 'POST',
    cookie: aliceCookie,
    body: { content: '', attachmentIds: [upload.upload.id] },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.attachments.length, 1);
  assert.equal(sent.data.message.attachments[0].name, 'pixel.png');

  const badType = new FormData();
  badType.append('file', new Blob([Buffer.from('#!/bin/sh\nrm -rf /')], { type: 'application/x-sh' }), 'evil.sh');
  const rejected = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { cookie: aliceCookie },
    body: badType,
  });
  assert.equal(rejected.status, 415);
});

test('voice channel signaling over websocket', async () => {
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);
  const bob = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'bob@example.com', password: 'bob password 123' },
  });
  const bobCookie = sessionCookie(bob.cookies);

  const communities = await api('/api/communities', { cookie: aliceCookie });
  const detail = await api(`/api/communities/${communities.data.communities[0].id}`, { cookie: aliceCookie });
  const voice = detail.data.community.channels.find((ch) => ch.type === 'voice');

  const aliceSocket = await openSocket(aliceCookie);
  const bobSocket = await openSocket(bobCookie);
  await aliceSocket.waitFor((m) => m.op === 'ready');
  await bobSocket.waitFor((m) => m.op === 'ready');

  aliceSocket.send({ op: 'voice:join', channelId: voice.id, muted: false, video: true });
  const peers = await aliceSocket.waitFor((m) => m.op === 'voice:peers' && m.channelId === voice.id);
  assert.equal(peers.peers.length, 0);

  bobSocket.send({ op: 'voice:join', channelId: voice.id, muted: true, video: false });
  const joined = await aliceSocket.waitFor(
    (m) => m.op === 'voice:join' && m.channelId === voice.id && m.peer?.userId === bob.data.user.id,
  );
  assert.equal(joined.peer.userId, bob.data.user.id);
  assert.equal(joined.peer.muted, true);

  bobSocket.send({ op: 'voice:signal', targetUserId: alice.data.user.id, data: { kind: 'offer', sdp: 'v=0' } });
  const signal = await aliceSocket.waitFor((m) => m.op === 'voice:signal');
  assert.equal(signal.fromUserId, bob.data.user.id);
  assert.equal(signal.data.kind, 'offer');

  bobSocket.send({ op: 'voice:leave' });
  await aliceSocket.waitFor((m) => m.op === 'voice:leave' && m.userId === bob.data.user.id);

  aliceSocket.close();
  bobSocket.close();
});

test('authorization boundaries', async () => {
  const carol = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'carol@example.com', password: 'carol password 123' },
  });
  const carolCookie = sessionCookie(carol.cookies);
  const alice = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a brand new password' },
  });
  const aliceCookie = sessionCookie(alice.cookies);
  const communities = await api('/api/communities', { cookie: aliceCookie });
  const detail = await api(`/api/communities/${communities.data.communities[0].id}`, { cookie: aliceCookie });
  const channel = detail.data.community.channels.find((ch) => ch.type === 'text');

  const peek = await api(`/api/channels/${channel.id}/messages`, { cookie: carolCookie });
  assert.equal(peek.status, 404);

  const post = await api(`/api/channels/${channel.id}/messages`, {
    method: 'POST',
    cookie: carolCookie,
    body: { content: 'let me in' },
  });
  assert.equal(post.status, 404);

  const anonymous = await api(`/api/channels/${channel.id}/messages`);
  assert.equal(anonymous.status, 401);

  // CSRF: cookie-authenticated mutation from another origin is refused
  const csrf = await fetch(`${BASE}/api/channels/${channel.id}/messages`, {
    method: 'POST',
    headers: { cookie: aliceCookie, 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ content: 'cross site' }),
  });
  assert.equal(csrf.status, 403);

  // rate limiting kicks in on repeated login attempts
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const attempt = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'wrong password' },
    });
    if (attempt.status === 429) limited = true;
  }
  assert.ok(limited, 'login attempts should be rate limited');
});
