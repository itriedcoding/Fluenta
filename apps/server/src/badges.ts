import { all, get, run } from './db.ts';
import { now } from './ids.ts';

/**
 * Badges are real server data, not decoration:
 *  - `automatic` badges are derived from the database (account age/order),
 *  - the rest are granted by the server founder and stored in `user_badges`.
 *
 * Art for each icon lives in the client (`apps/web/src/components/BadgeChip.tsx`).
 */
export type BadgeIcon = 'crown' | 'sparkle' | 'shield' | 'terminal' | 'flask' | 'heart' | 'bolt' | 'star';

export type BadgeDefinition = {
  key: string;
  name: string;
  description: string;
  howToEarn: string;
  color: string;
  icon: BadgeIcon;
  automatic: boolean;
};

export const BADGES: BadgeDefinition[] = [
  {
    key: 'founder',
    name: 'Founder',
    description: 'Created this Fluenta server.',
    howToEarn: 'Automatic for the first account on this server.',
    color: '#e6b45c',
    icon: 'crown',
    automatic: true,
  },
  {
    key: 'early',
    name: 'Early member',
    description: 'One of the first 100 accounts here.',
    howToEarn: 'Automatic while you are among the first 100 sign-ups.',
    color: '#74c0fc',
    icon: 'sparkle',
    automatic: true,
  },
  {
    key: 'verified',
    name: 'Verified',
    description: 'Identity checked by the server team.',
    howToEarn: 'Granted by the server founder.',
    color: '#4ade80',
    icon: 'shield',
    automatic: false,
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'Wrote code that shipped in Fluenta.',
    howToEarn: 'Granted for merged pull requests.',
    color: '#b794f6',
    icon: 'terminal',
    automatic: false,
  },
  {
    key: 'bug_hunter',
    name: 'Bug hunter',
    description: 'Reported a real bug that got fixed.',
    howToEarn: 'Granted for reproducible bug reports.',
    color: '#fb923c',
    icon: 'flask',
    automatic: false,
  },
  {
    key: 'helper',
    name: 'Helper',
    description: 'Goes out of their way for other members.',
    howToEarn: 'Granted by the server founder.',
    color: '#f472b6',
    icon: 'heart',
    automatic: false,
  },
  {
    key: 'builder',
    name: 'Builder',
    description: 'Shipped something with the Fluenta API.',
    howToEarn: 'Granted for bots and integrations built on Fluenta.',
    color: '#2dd4bf',
    icon: 'bolt',
    automatic: false,
  },
  {
    key: 'legend',
    name: 'Community legend',
    description: 'A long-standing, trusted member.',
    howToEarn: 'Granted by the server founder.',
    color: '#facc15',
    icon: 'star',
    automatic: false,
  },
];

export const BADGE_BY_KEY = new Map(BADGES.map((badge) => [badge.key, badge]));

const ORDER = new Map(BADGES.map((badge, index) => [badge.key, index]));

export function badgeCatalog() {
  return BADGES.map((badge) => ({
    key: badge.key,
    name: badge.name,
    description: badge.description,
    howToEarn: badge.howToEarn,
    color: badge.color,
    icon: badge.icon,
    automatic: badge.automatic,
  }));
}

/** The first account on this server owns it (see `/api/badges` for grant rights). */
export function founderId(): string | null {
  return get<{ id: string }>('SELECT id FROM users ORDER BY created_at, id LIMIT 1')?.id ?? null;
}

export function isFounder(userId: string): boolean {
  return founderId() === userId;
}

function sortBadges(keys: string[]): string[] {
  return [...new Set(keys)].sort((a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99));
}

/**
 * Resolves badges for a batch of users with three queries total, so member lists
 * and search results never fall into an N+1 pattern.
 */
export function badgesForUsers(userIds: string[]): Record<string, string[]> {
  const unique = [...new Set(userIds)].filter(Boolean);
  const out: Record<string, string[]> = {};
  for (const id of unique) out[id] = [];
  if (unique.length === 0) return out;

  const founder = founderId();
  const earlyIds = new Set(
    all<{ id: string }>('SELECT id FROM users ORDER BY created_at, id LIMIT 100').map((row) => row.id),
  );
  const placeholders = unique.map(() => '?').join(', ');
  const granted = all<{ user_id: string; badge_key: string }>(
    `SELECT user_id, badge_key FROM user_badges WHERE user_id IN (${placeholders})`,
    ...unique,
  );

  for (const id of unique) {
    const keys: string[] = [];
    if (id === founder) keys.push('founder');
    if (earlyIds.has(id)) keys.push('early');
    for (const row of granted) {
      if (row.user_id === id && BADGE_BY_KEY.has(row.badge_key)) keys.push(row.badge_key);
    }
    out[id] = sortBadges(keys);
  }
  return out;
}

export function badgesFor(userId: string): string[] {
  return badgesForUsers([userId])[userId] ?? [];
}

export function grantBadge(userId: string, badgeKey: string, grantedBy: string | null): boolean {
  const definition = BADGE_BY_KEY.get(badgeKey);
  if (!definition) throw new Error(`Unknown badge: ${badgeKey}`);
  if (definition.automatic) throw new Error(`${definition.name} is granted automatically`);
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', userId)) throw new Error('User not found');
  run(
    'INSERT OR IGNORE INTO user_badges (user_id, badge_key, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    userId,
    badgeKey,
    grantedBy,
    now(),
  );
  return true;
}

export function revokeBadge(userId: string, badgeKey: string): boolean {
  const definition = BADGE_BY_KEY.get(badgeKey);
  if (!definition) throw new Error(`Unknown badge: ${badgeKey}`);
  if (definition.automatic) throw new Error(`${definition.name} is granted automatically`);
  run('DELETE FROM user_badges WHERE user_id = ? AND badge_key = ?', userId, badgeKey);
  return true;
}
