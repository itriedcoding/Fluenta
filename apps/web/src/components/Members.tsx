import { useMemo, useState } from 'react';
import { openModal, useStore } from '../lib/store';
import { cx } from '../lib/util';
import type { Channel, Community, Member } from '../lib/types';
import { Avatar, Icon } from './ui';

export function Members({ community, channel }: { community: Community; channel?: Channel }) {
  const [query, setQuery] = useState('');
  const members = community.members;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(
      (member) =>
        member.displayName.toLowerCase().includes(needle) ||
        member.username.toLowerCase().includes(needle),
    );
  }, [members, query]);

  const online = filtered
    .filter((member) => member.presence !== 'offline')
    .sort((a, b) => rank(b, community) - rank(a, community) || a.displayName.localeCompare(b.displayName));
  const offline = filtered
    .filter((member) => member.presence === 'offline')
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <aside className="members">
      <div className="members-head">
        <span>Members</span>
        <span className="members-count">{members.length}</span>
      </div>
      {members.length > 8 && (
        <input
          className="input members-search"
          placeholder="Find a member"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="members-scroll">
        {online.length > 0 && (
          <>
            <h4 className="members-group">Online — {online.length}</h4>
            {online.map((member) => (
              <MemberRow key={member.userId} member={member} community={community} />
            ))}
          </>
        )}
        {offline.length > 0 && (
          <>
            <h4 className="members-group">Offline — {offline.length}</h4>
            {offline.map((member) => (
              <MemberRow key={member.userId} member={member} community={community} />
            ))}
          </>
        )}
        {filtered.length === 0 && <p className="members-empty">No one matches “{query}”.</p>}
      </div>
      {channel?.isPrivate && (
        <p className="members-note">
          <Icon name="lock" size={12} /> Private channel — only invited members can see it.
        </p>
      )}
    </aside>
  );
}

function rank(member: Member, community: Community): number {
  if (member.userId === community.ownerId) return 1000;
  const roles = member.roles
    .map((id) => community.roles.find((role) => role.id === id))
    .filter((role): role is NonNullable<typeof role> => Boolean(role));
  return Math.max(0, ...roles.map((role) => role.position + 1));
}

function MemberRow({ member, community }: { member: Member; community: Community }) {
  const color = useMemo(() => {
    const roles = member.roles
      .map((id) => community.roles.find((role) => role.id === id))
      .filter((role): role is NonNullable<typeof role> => Boolean(role))
      .sort((a, b) => b.position - a.position);
    return roles.find((role) => !role.isDefault)?.color;
  }, [member.roles, community.roles]);

  const topRole = member.roles
    .map((id) => community.roles.find((role) => role.id === id))
    .filter((role): role is NonNullable<typeof role> => Boolean(role))
    .sort((a, b) => b.position - a.position)[0];

  return (
    <button
      type="button"
      className={cx('member-row', member.presence === 'offline' && 'offline')}
      onClick={() => openModal({ kind: 'profile', userId: member.userId })}
    >
      <Avatar
        size={30}
        name={member.nickname || member.displayName}
        url={member.avatarUrl}
        id={member.userId}
        presence={member.presence}
      />
      <span className="member-text">
        <span className="member-name" style={color ? { color } : undefined}>
          {member.nickname || member.displayName}
          {member.userId === community.ownerId && <Icon name="crown" size={11} className="member-crown" />}
        </span>
        {member.customStatus && <span className="member-status">{member.customStatus}</span>}
      </span>
      {topRole && !topRole.isDefault && <span className="member-role" style={{ borderColor: topRole.color, color: topRole.color }}>{topRole.name}</span>}
    </button>
  );
}
