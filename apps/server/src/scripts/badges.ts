/**
 * Badge administration from the server shell (no web access needed).
 *
 *   node apps/server/src/scripts/badges.ts list
 *   node apps/server/src/scripts/badges.ts grant @alex developer
 *   node apps/server/src/scripts/badges.ts grant alex@example.com bug_hunter
 *   node apps/server/src/scripts/badges.ts revoke alex legend
 */
import { all, get } from '../db.ts';
import { badgeCatalog, badgesForUsers, founderId, grantBadge, revokeBadge, BADGE_BY_KEY } from '../badges.ts';

type UserRef = { id: string; username: string; display_name: string };

function resolveUser(ref: string): UserRef {
  const needle = ref.replace(/^@/, '');
  const row =
    get<UserRef>('SELECT id, username, display_name FROM users WHERE username = ? OR email = ?', needle, needle) ??
    get<UserRef>('SELECT id, username, display_name FROM users WHERE id = ?', needle);
  if (!row) {
    console.error(`No account matches "${ref}".`);
    process.exit(1);
  }
  return row;
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'list') {
  const founder = founderId();
  const users = all<UserRef>('SELECT id, username, display_name FROM users ORDER BY created_at');
  const badges = badgesForUsers(users.map((user) => user.id));
  for (const user of users) {
    const keys = badges[user.id] ?? [];
    const names = keys.map((key) => BADGE_BY_KEY.get(key)?.name ?? key).join(', ') || '—';
    console.log(`${user.id === founder ? '*' : ' '} @${user.username} (${user.display_name}): ${names}`);
  }
  console.log(`\n${badgeCatalog().length} badges available. "*" marks the server founder.`);
} else if (command === 'grant' || command === 'revoke') {
  const [ref, key] = rest;
  if (!ref || !key) {
    console.error(`Usage: node apps/server/src/scripts/badges.ts ${command} <@username|email|id> <badge>`);
    process.exit(1);
  }
  const user = resolveUser(ref);
  try {
    if (command === 'grant') grantBadge(user.id, key, founderId());
    else revokeBadge(user.id, key);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const names = badgesForUsers([user.id])[user.id] ?? [];
  console.log(`${command === 'grant' ? 'Granted' : 'Revoked'} ${key} for @${user.username}. Badges now: ${names.join(', ') || '—'}`);
} else {
  console.log('Usage:\n  node apps/server/src/scripts/badges.ts list\n  node apps/server/src/scripts/badges.ts grant <@username|email|id> <badge>\n  node apps/server/src/scripts/badges.ts revoke <@username|email|id> <badge>');
}
