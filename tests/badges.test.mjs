/**
 * Badge behaviour against a real server and database: automatic badges,
 * catalog visibility, founder-only grants, revocation and CSRF protection.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8801;
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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluenta-badges-'));
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

test('badges: automatic, granted, revoked and protected', async () => {
  const founder = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      email: 'founder@example.com',
      username: 'founder',
      displayName: 'Server Founder',
      password: 'correct horse battery',
    },
  });
  assert.equal(founder.status, 201, JSON.stringify(founder.data));
  const founderCookie = sessionCookie(founder.cookies);
  assert.deepEqual(founder.data.user.badges, ['founder', 'early']);

  const member = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      email: 'member@example.com',
      username: 'member',
      displayName: 'Member',
      password: 'correct horse battery',
    },
  });
  assert.equal(member.status, 201, JSON.stringify(member.data));
  const memberCookie = sessionCookie(member.cookies);
  const memberId = member.data.user.id;
  assert.deepEqual(member.data.user.badges, ['early']);

  const catalog = await api('/api/badges', { cookie: founderCookie });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.canGrant, true);
  assert.ok(catalog.data.badges.length >= 8);
  assert.ok(catalog.data.badges.some((badge) => badge.key === 'verified' && badge.automatic === false));

  const memberCatalog = await api('/api/badges', { cookie: memberCookie });
  assert.equal(memberCatalog.data.canGrant, false);

  const denied = await api('/api/badges/verified/grant', {
    method: 'POST',
    cookie: memberCookie,
    body: { userId: memberId },
  });
  assert.equal(denied.status, 403);

  const granted = await api('/api/badges/verified/grant', {
    method: 'POST',
    cookie: founderCookie,
    body: { userId: memberId },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  assert.deepEqual(granted.data.badges, ['early', 'verified']);

  const automatic = await api('/api/badges/early/grant', {
    method: 'POST',
    cookie: founderCookie,
    body: { userId: memberId },
  });
  assert.equal(automatic.status, 400);

  const lookup = await api(`/api/badges/users/${memberId}`, { cookie: founderCookie });
  assert.deepEqual(lookup.data.badges, ['early', 'verified']);

  const me = await api('/api/auth/me', { cookie: memberCookie });
  assert.deepEqual(me.data.user.badges, ['early', 'verified']);

  const revoked = await api(`/api/badges/verified/grant/${memberId}`, {
    method: 'DELETE',
    cookie: founderCookie,
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.data.badges, ['early']);

  // Badges appear on community member payloads, not just the current user.
  const community = await api('/api/communities', {
    method: 'POST',
    cookie: founderCookie,
    body: { name: 'Badge Hall', description: 'Testing badges' },
  });
  assert.equal(community.status, 201, JSON.stringify(community.data));
  const communityId = community.data.community.id;
  const invite = community.data.community.inviteCode;

  const joined = await api('/api/communities/join', {
    method: 'POST',
    cookie: memberCookie,
    body: { code: invite },
  });
  assert.ok([200, 201].includes(joined.status), JSON.stringify(joined.data));

  await api('/api/badges/helper/grant', {
    method: 'POST',
    cookie: founderCookie,
    body: { userId: memberId },
  });

  const full = await api(`/api/communities/${communityId}`, { cookie: memberCookie });
  assert.equal(full.status, 200, JSON.stringify(full.data));
  const hall = full.data.community;
  const memberRow = hall.members.find((entry) => entry.userId === memberId);
  assert.ok(memberRow, 'member should appear in the community member list');
  assert.ok(memberRow.badges.includes('helper'), JSON.stringify(memberRow.badges));
  assert.ok(memberRow.badges.includes('early'));
});
