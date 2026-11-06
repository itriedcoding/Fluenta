import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, transaction } from '../db.ts';
import { requireAuth, type Env } from '../auth.ts';
import { bad, cleanText } from '../util.ts';
import { now, uid } from '../ids.ts';
import {
  PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
} from '../permissions.ts';
import {
  communityRow,
  isCommunityMember,
  effectivePermissions,
  type CommunityRow,
} from '../access.ts';
import {
  communityAudienceIds,
  communityMembers,
  communityPayload,
  communitySummaries,
  presenceFor,
  conversationPayload,
} from '../state.ts';
import { hub } from '../realtime.ts';

const router = new Hono<Env>();
router.use('*', requireAuth);

const nameSchema = z.string().trim().min(1).max(80);

function can(community: CommunityRow, userId: string, permission: number) {
  return (effectivePermissions(community.id, userId) & permission) === permission;
}

function guard(c: Parameters<typeof bad>[0], community: CommunityRow | undefined, permission: number) {
  if (!community) return { error: 'Community not found' as const, status: 404 };
  const userId = c.get('auth').user.id;
  if (!isCommunityMember(community.id, userId)) return { error: 'Community not found' as const, status: 404 };
  if (!can(community, userId, permission)) return { error: 'You do not have permission to do that' as const, status: 403 };
  return null;
}

router.get('/', (c) => {
  return c.json({ communities: communitySummaries(c.get('auth').user.id) });
});

router.post('/', async (c) => {
  const parsed = z
    .object({ name: nameSchema, description: z.string().max(300).optional(), iconId: z.string().max(80).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  const userId = auth.user.id;
  if (all('SELECT 1 AS x FROM community_members WHERE user_id = ?', userId).length >= 100) {
    return bad(c, 'You have reached the community limit for one account', 400);
  }
  if (parsed.data.iconId && !get('SELECT 1 AS x FROM uploads WHERE id = ? AND owner_id = ?', parsed.data.iconId, userId)) {
    return bad(c, 'Upload not found', 404);
  }

  const id = uid('c_');
  const ts = now();
  const invite = uid().slice(0, 8);
  const generalId = uid('ch_');
  transaction(() => {
    run(
      'INSERT INTO communities (id, name, description, icon_id, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      cleanText(parsed.data.name),
      cleanText(parsed.data.description ?? ''),
      parsed.data.iconId ?? null,
      userId,
      invite,
      ts,
    );
    run('INSERT INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)', id, userId, ts);
    run(
      `INSERT INTO roles (id, community_id, name, color, permissions, position, is_default, created_at)
       VALUES (?, ?, 'Member', '#c9c9d1', ?, 0, 1, ?)`,
      uid('r_'),
      id,
      DEFAULT_MEMBER_PERMISSIONS,
      ts,
    );
    run(
      `INSERT INTO channels (id, community_id, name, type, topic, position, created_at)
       VALUES (?, ?, 'general', 'text', 'Start the conversation', 0, ?)`,
      generalId,
      id,
      ts,
    );
    run(
      `INSERT INTO channels (id, community_id, name, type, topic, position, created_at)
       VALUES (?, ?, 'Lounge', 'voice', '', 1, ?)`,
      uid('ch_'),
      id,
      ts,
    );
  });

  const community = communityRow(id)!;
  hub.send(userId, { op: 'community:join', community: communityPayload(community, userId) });
  return c.json({ community: communityPayload(community, userId) }, 201);
});

router.get('/:id', (c) => {
  const auth = c.get('auth');
  const community = communityRow(c.req.param('id'));
  if (!community || !isCommunityMember(community.id, auth.user.id)) return bad(c, 'Community not found', 404);
  return c.json({ community: communityPayload(community, auth.user.id) });
});

router.patch('/:id', async (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.MANAGE_SERVER);
  if (denied) return bad(c, denied.error, denied.status);
  const parsed = z
    .object({
      name: nameSchema.optional(),
      description: z.string().max(300).optional(),
      iconId: z.string().max(80).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  if (parsed.data.iconId && !get('SELECT 1 AS x FROM uploads WHERE id = ? AND owner_id = ?', parsed.data.iconId, auth.user.id)) {
    return bad(c, 'Upload not found', 404);
  }
  run(
    `UPDATE communities SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       icon_id = CASE WHEN ? THEN ? ELSE icon_id END
     WHERE id = ?`,
    parsed.data.name ? cleanText(parsed.data.name) : null,
    parsed.data.description !== undefined ? cleanText(parsed.data.description) : null,
    parsed.data.iconId !== undefined ? 1 : 0,
    parsed.data.iconId ?? null,
    community!.id,
  );
  hub.broadcast(communityAudienceIds(community!.id), {
    op: 'community:update',
    community: communityPayload(communityRow(community!.id)!, auth.user.id),
  });
  return c.json({ community: communityPayload(communityRow(community!.id)!, auth.user.id) });
});

router.delete('/:id', (c) => {
  const community = communityRow(c.req.param('id'));
  const auth = c.get('auth');
  if (!community || community.owner_id !== auth.user.id) return bad(c, 'Only the owner can delete a community', 403);
  const audience = communityAudienceIds(community.id);
  run('DELETE FROM communities WHERE id = ?', community.id);
  hub.broadcast(audience, { op: 'community:remove', communityId: community.id });
  return c.json({ ok: true });
});

router.post('/:id/leave', (c) => {
  const community = communityRow(c.req.param('id'));
  const auth = c.get('auth');
  if (!community || !isCommunityMember(community.id, auth.user.id)) return bad(c, 'Community not found', 404);
  if (community.owner_id === auth.user.id) {
    return bad(c, 'Transfer ownership or delete the community instead', 400);
  }
  run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', community.id, auth.user.id);
  run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ?', community.id, auth.user.id);
  hub.send(auth.user.id, { op: 'community:remove', communityId: community.id });
  hub.broadcast(communityAudienceIds(community.id), {
    op: 'member:remove',
    communityId: community.id,
    userId: auth.user.id,
  });
  return c.json({ ok: true });
});

router.post('/:id/invites', (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.CREATE_INVITES);
  if (denied) return bad(c, denied.error, denied.status);
  const code = uid().slice(0, 8);
  run('UPDATE communities SET invite_code = ? WHERE id = ?', code, community!.id);
  hub.broadcast(communityAudienceIds(community!.id), {
    op: 'community:update',
    community: communityPayload(communityRow(community!.id)!, c.get('auth').user.id),
  });
  return c.json({ inviteCode: code });
});

router.get('/invites/:code', (c) => {
  const code = c.req.param('code');
  const community = get<CommunityRow>('SELECT * FROM communities WHERE invite_code = ?', code);
  if (!community) return bad(c, 'That invite is no longer valid', 404);
  const memberCount = Number(
    get('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', community.id)?.n ?? 0,
  );
  return c.json({
    invite: {
      communityId: community.id,
      name: community.name,
      description: community.description,
      iconUrl: community.icon_id ? `/api/uploads/${community.icon_id}` : null,
      memberCount,
      alreadyMember: isCommunityMember(community.id, c.get('auth')?.user.id ?? ''),
    },
  });
});

router.post('/join', async (c) => {
  const parsed = z.object({ code: z.string().trim().min(3).max(40) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const community = get<CommunityRow>('SELECT * FROM communities WHERE invite_code = ?', parsed.data.code);
  if (!community) return bad(c, 'That invite is no longer valid', 404);
  const auth = c.get('auth');
  if (!isCommunityMember(community.id, auth.user.id)) {
    run(
      'INSERT INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)',
      community.id,
      auth.user.id,
      now(),
    );
    const member = communityMembers(community.id).find((m) => m.userId === auth.user.id);
    hub.broadcast(communityAudienceIds(community.id), {
      op: 'member:update',
      communityId: community.id,
      member,
    });
  }
  const payload = communityPayload(community, auth.user.id);
  hub.send(auth.user.id, { op: 'community:join', community: payload });
  return c.json({ community: payload });
});

// ---- channels -------------------------------------------------------------

router.post('/:id/channels', async (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.MANAGE_CHANNELS);
  if (denied) return bad(c, denied.error, denied.status);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(40),
      type: z.enum(['text', 'voice']).default('text'),
      topic: z.string().max(200).optional(),
      isPrivate: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  const slug = parsed.data.name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
  if (!slug) return bad(c, 'Channel name needs letters or numbers', 400);
  if (all('SELECT 1 AS x FROM channels WHERE community_id = ?', community!.id).length >= 100) {
    return bad(c, 'This community has reached its channel limit', 400);
  }
  const position = Number(
    get('SELECT COALESCE(MAX(position), 0) AS p FROM channels WHERE community_id = ?', community!.id)?.p ?? 0,
  ) + 1;
  const id = uid('ch_');
  run(
    `INSERT INTO channels (id, community_id, name, type, topic, position, is_private, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    community!.id,
    slug,
    parsed.data.type,
    cleanText(parsed.data.topic ?? ''),
    position,
    parsed.data.isPrivate ? 1 : 0,
    now(),
  );
  const updated = communityPayload(communityRow(community!.id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(community!.id), { op: 'community:update', community: updated });
  return c.json({ community: updated }, 201);
});

// ---- roles ----------------------------------------------------------------

router.post('/:id/roles', async (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.MANAGE_ROLES);
  if (denied) return bad(c, denied.error, denied.status);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(40),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      permissions: z.number().int().min(0).max(0xffffff).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  const position = Number(
    get('SELECT COALESCE(MAX(position), 0) AS p FROM roles WHERE community_id = ?', community!.id)?.p ?? 0,
  ) + 1;
  const id = uid('r_');
  run(
    `INSERT INTO roles (id, community_id, name, color, permissions, position, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    community!.id,
    parsed.data.name,
    parsed.data.color ?? '#b9b9c0',
    parsed.data.permissions ?? DEFAULT_MEMBER_PERMISSIONS,
    position,
    now(),
  );
  const updated = communityPayload(communityRow(community!.id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(community!.id), { op: 'community:update', community: updated });
  return c.json({ community: updated }, 201);
});

router.patch('/roles/:roleId', async (c) => {
  const role = get<{ id: string; community_id: string; is_default: number }>(
    'SELECT id, community_id, is_default FROM roles WHERE id = ?',
    c.req.param('roleId'),
  );
  if (!role) return bad(c, 'Role not found', 404);
  const community = communityRow(role.community_id);
  const denied = guard(c, community, PERMISSIONS.MANAGE_ROLES);
  if (denied) return bad(c, denied.error, denied.status);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(40).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      permissions: z.number().int().min(0).max(0xffffff).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const auth = c.get('auth');
  run(
    `UPDATE roles SET name = COALESCE(?, name), color = COALESCE(?, color), permissions = COALESCE(?, permissions)
     WHERE id = ?`,
    parsed.data.name ?? null,
    parsed.data.color ?? null,
    parsed.data.permissions ?? null,
    role.id,
  );
  const updated = communityPayload(communityRow(role.community_id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(role.community_id), { op: 'community:update', community: updated });
  return c.json({ community: updated });
});

router.delete('/roles/:roleId', (c) => {
  const role = get<{ id: string; community_id: string; is_default: number }>(
    'SELECT id, community_id, is_default FROM roles WHERE id = ?',
    c.req.param('roleId'),
  );
  if (!role) return bad(c, 'Role not found', 404);
  if (role.is_default) return bad(c, 'The default member role cannot be deleted', 400);
  const community = communityRow(role.community_id);
  const denied = guard(c, community, PERMISSIONS.MANAGE_ROLES);
  if (denied) return bad(c, denied.error, denied.status);
  const auth = c.get('auth');
  run('DELETE FROM member_roles WHERE role_id = ?', role.id);
  run('DELETE FROM roles WHERE id = ?', role.id);
  const updated = communityPayload(communityRow(role.community_id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(role.community_id), { op: 'community:update', community: updated });
  return c.json({ community: updated });
});

router.put('/:id/members/:userId/roles', async (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.MANAGE_ROLES);
  if (denied) return bad(c, denied.error, denied.status);
  const targetId = c.req.param('userId');
  if (!isCommunityMember(community!.id, targetId)) return bad(c, 'That user is not a member', 404);
  const parsed = z.object({ roleIds: z.array(z.string()).max(20) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  const valid = new Set(
    all<{ id: string }>('SELECT id FROM roles WHERE community_id = ?', community!.id).map((r) => r.id),
  );
  const ids = parsed.data.roleIds.filter((id) => valid.has(id));
  transaction(() => {
    run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ?', community!.id, targetId);
    for (const roleId of ids) {
      run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', community!.id, targetId, roleId);
    }
  });
  const updated = communityPayload(communityRow(community!.id)!, c.get('auth').user.id);
  hub.broadcast(communityAudienceIds(community!.id), { op: 'community:update', community: updated });
  return c.json({ community: updated });
});

router.patch('/:id/members/:userId', async (c) => {
  const community = communityRow(c.req.param('id'));
  const auth = c.get('auth');
  if (!community) return bad(c, 'Community not found', 404);
  const targetId = c.req.param('userId');
  if (targetId !== auth.user.id) {
    const denied = guard(c, community, PERMISSIONS.MANAGE_MEMBERS);
    if (denied) return bad(c, denied.error, denied.status);
  }
  const parsed = z.object({ nickname: z.string().max(40).nullable().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return bad(c, parsed.error);
  run(
    'UPDATE community_members SET nickname = ? WHERE community_id = ? AND user_id = ?',
    parsed.data.nickname ? cleanText(parsed.data.nickname) : null,
    community.id,
    targetId,
  );
  const updated = communityPayload(communityRow(community.id)!, auth.user.id);
  hub.broadcast(communityAudienceIds(community.id), { op: 'community:update', community: updated });
  return c.json({ community: updated });
});

router.delete('/:id/members/:userId', (c) => {
  const community = communityRow(c.req.param('id'));
  const denied = guard(c, community, PERMISSIONS.KICK_MEMBERS);
  if (denied) return bad(c, denied.error, denied.status);
  const targetId = c.req.param('userId');
  if (targetId === community!.owner_id) return bad(c, 'The owner cannot be removed', 400);
  if (targetId === c.get('auth').user.id) return bad(c, 'Use leave instead', 400);
  run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', community!.id, targetId);
  run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ?', community!.id, targetId);
  hub.send(targetId, { op: 'community:remove', communityId: community!.id });
  hub.broadcast(communityAudienceIds(community!.id), {
    op: 'member:remove',
    communityId: community!.id,
    userId: targetId,
  });
  return c.json({ ok: true });
});

export default router;
