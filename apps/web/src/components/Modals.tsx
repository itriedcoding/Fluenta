import { useEffect, useMemo, useState } from 'react';
import {
  addToGroup,
  closeModal,
  createChannel,
  createCommunity,
  createGroup,
  createRole,
  deleteChannel,
  deleteCommunity,
  deleteRole,
  joinInvite,
  kickMember,
  leaveCommunity,
  openModal,
  permissionFor,
  PERM,
  rotateInvite,
  setChannelAccess,
  setOverlay,
  startDm,
  toastError,
  updateChannel,
  updateCommunity,
  updateRole,
  useStore,
  assignRoles,
  applyBadges,
} from '../lib/store';
import { uploadFile } from '../lib/api';
import { useStore as useStoreHook } from '../lib/store';
import type { Community, Member, Role } from '../lib/types';
import { Avatar, Icon, ModalFrame, Spinner } from './ui';
import { BadgeChip, BadgeGlyph } from './BadgeChip';
import { grantBadge, revokeBadge, useBadgeCatalog } from '../lib/badges';
import { cx } from '../lib/util';

const PERMISSION_OPTIONS: { label: string; bit: number; hint: string }[] = [
  { label: 'Manage server', bit: PERM.MANAGE_SERVER, hint: 'Rename, re-theme and delete the community' },
  { label: 'Manage channels', bit: PERM.MANAGE_CHANNELS, hint: 'Create, edit and delete channels' },
  { label: 'Manage roles', bit: PERM.MANAGE_ROLES, hint: 'Create roles and assign them to members' },
  { label: 'Manage messages', bit: PERM.MANAGE_MESSAGES, hint: 'Edit and delete anyone’s messages' },
  { label: 'Kick members', bit: PERM.KICK_MEMBERS, hint: 'Remove members from the community' },
  { label: 'Create invites', bit: PERM.CREATE_INVITES, hint: 'Generate invite links' },
  { label: 'Send messages', bit: PERM.SEND_MESSAGES, hint: 'Post in text channels' },
  { label: 'Attach files', bit: PERM.ATTACH_FILES, hint: 'Upload images and files' },
  { label: 'Add reactions', bit: PERM.ADD_REACTIONS, hint: 'React to messages' },
  { label: 'Mention everyone', bit: PERM.MENTION_EVERYONE, hint: 'Use @everyone and @here' },
  { label: 'Connect to voice', bit: PERM.CONNECT_VOICE, hint: 'Join voice channels' },
];

export function Modals() {
  const modal = useStoreHook((state) => state.modal);
  if (!modal) return null;

  switch (modal.kind) {
    case 'create-community':
      return <CreateCommunity />;
    case 'create-channel':
      return <CreateChannel communityId={modal.communityId} />;
    case 'community-settings':
      return <CommunitySettings communityId={modal.communityId} />;
    case 'channel-settings':
      return <ChannelSettings channelId={modal.channelId} />;
    case 'invite':
      return <InviteModal communityId={modal.communityId} />;
    case 'roles':
      return <RolesModal communityId={modal.communityId} />;
    case 'create-group':
      return <CreateGroup />;
    case 'profile':
      return <ProfileModal userId={modal.userId} />;
    case 'confirm':
      return (
        <ModalFrame title={modal.title} onClose={closeModal}>
          <p className="modal-text">{modal.message}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-soft" onClick={closeModal}>Cancel</button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                await modal.run();
                closeModal();
              }}
            >
              {modal.confirmLabel}
            </button>
          </div>
        </ModalFrame>
      );
    default:
      return null;
  }
}

function CreateCommunity() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalFrame
      title="Your spaces"
      subtitle="Start a community of your own, or join one with an invite code."
      onClose={closeModal}
    >
      <div className="modal-section">
        <h3>Create a community</h3>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Design Guild" />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="input textarea"
            rows={2}
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this place for?"
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await createCommunity(name.trim(), description.trim());
              closeModal();
            } catch (err) {
              toastError(err);
              setError(err instanceof Error ? err.message : 'Could not create the community');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Create community
        </button>
      </div>

      <div className="divider"><span>or</span></div>

      <div className="modal-section">
        <h3>Join with an invite</h3>
        <div className="inline-form">
          <input
            className="input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste an invite code or link"
          />
          <button
            type="button"
            className="btn btn-soft"
            disabled={code.trim().length < 3}
            onClick={async () => {
              const raw = code.trim();
              const parsed = raw.includes('/invite/') ? raw.split('/invite/')[1] : raw;
              try {
                await joinInvite(parsed.split('?')[0]);
                closeModal();
              } catch (err) {
                toastError(err);
              }
            }}
          >
            Join
          </button>
        </div>
        {error && <p className="auth-error">{error}</p>}
      </div>
    </ModalFrame>
  );
}

function CreateChannel({ communityId }: { communityId: string }) {
  const communities = useStoreHook((state) => state.communities);
  const community = communities.find((entry) => entry.id === communityId);
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!community) return null;

  return (
    <ModalFrame title="Create a channel" subtitle={`In ${community.name}`} onClose={closeModal}>
      <div className="segmented">
        <button type="button" className={cx('segment', type === 'text' && 'active')} onClick={() => setType('text')}>
          <Icon name="hash" size={16} /> Text
        </button>
        <button type="button" className={cx('segment', type === 'voice' && 'active')} onClick={() => setType('voice')}>
          <Icon name="volume" size={16} /> Voice
        </button>
      </div>
      <label className="field">
        <span className="field-label">Channel name</span>
        <input className="input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder={type === 'text' ? 'product-talk' : 'Studio'} />
      </label>
      {type === 'text' && (
        <label className="field">
          <span className="field-label">Topic (optional)</span>
          <input className="input" value={topic} maxLength={200} onChange={(event) => setTopic(event.target.value)} placeholder="What belongs here?" />
        </label>
      )}
      <label className="switch-row">
        <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
        <span>
          <strong>Private channel</strong>
          <small>Only invited members and moderators can see it.</small>
        </span>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn btn-soft" onClick={closeModal}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await createChannel(communityId, { name: name.trim(), type, topic: topic.trim(), isPrivate });
              closeModal();
            } catch (err) {
              toastError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size={16} /> : null} Create channel
        </button>
      </div>
    </ModalFrame>
  );
}

function InviteModal({ communityId }: { communityId: string }) {
  const communities = useStoreHook((state) => state.communities);
  const community = communities.find((entry) => entry.id === communityId);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState(community?.inviteCode ?? '');
  if (!community) return null;
  const link = `${window.location.origin}/invite/${code}`;

  return (
    <ModalFrame title="Invite people" subtitle={`Anyone with this link can join ${community.name}`} onClose={closeModal}>
      <label className="field">
        <span className="field-label">Invite link</span>
        <div className="inline-form">
          <input className="input" readOnly value={link} onFocus={(event) => event.target.select()} />
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                toastError('Copy failed — select the link manually');
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </label>
      {permissionFor(community, PERM.CREATE_INVITES) && (
        <div className="modal-section">
          <p className="modal-text">
            Rotating the link invalidates the current one immediately. Anyone already in the community stays.
          </p>
          <button
            type="button"
            className="btn btn-soft"
            onClick={async () => {
              try {
                const next = await rotateInvite(communityId);
                setCode(next);
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <Icon name="link" size={16} /> Generate a new link
          </button>
        </div>
      )}
    </ModalFrame>
  );
}

function CommunitySettings({ communityId }: { communityId: string }) {
  const communities = useStoreHook((state) => state.communities);
  const me = useStoreHook((state) => state.me);
  const community = communities.find((entry) => entry.id === communityId);
  const [tab, setTab] = useState<'overview' | 'roles' | 'members' | 'danger'>('overview');
  const [name, setName] = useState(community?.name ?? '');
  const [description, setDescription] = useState(community?.description ?? '');
  const [busy, setBusy] = useState(false);

  if (!community || !me) return null;
  const isOwner = community.ownerId === me.id;
  const canRoles = permissionFor(community, PERM.MANAGE_ROLES);
  const canKick = permissionFor(community, PERM.KICK_MEMBERS);

  return (
    <ModalFrame title={community.name} subtitle="Community settings" onClose={closeModal} wide>
      <div className="tabs">
        {(['overview', 'roles', 'members', 'danger'] as const).map((entry) => (
          <button key={entry} type="button" className={cx('tab', tab === entry && 'active')} onClick={() => setTab(entry)}>
            {entry === 'danger' ? 'Danger zone' : entry[0].toUpperCase() + entry.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="modal-section">
          <div className="icon-uploader">
            <Avatar name={community.name} url={community.iconUrl} id={community.id} size={64} />
            <label className="btn btn-soft btn-sm">
              <Icon name="image" size={15} /> Change icon
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    const result = await uploadFile(file);
                    await updateCommunity(communityId, { iconId: result.id });
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <textarea className="input textarea" rows={3} maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await updateCommunity(communityId, { name: name.trim(), description: description.trim() });
                  closeModal();
                } catch (err) {
                  toastError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner size={16} /> : null} Save changes
            </button>
          </div>
        </div>
      )}

      {tab === 'roles' && (
        <div className="modal-section">
          <p className="modal-text">
            Roles bundle permissions. The default Member role applies to everyone who joins.
          </p>
          <div className="role-list">
            {community.roles.map((role) => (
              <div key={role.id} className="role-row">
                <span className="role-dot" style={{ background: role.color }} />
                <span className="role-row-name">{role.name}</span>
                {role.isDefault && <span className="tag">default</span>}
                <span className="role-row-perms">{role.permissions.toString(2).split('1').length - 1} permissions</span>
                {canRoles && (
                  <button type="button" className="link-btn" onClick={() => openModal({ kind: 'roles', communityId })}>
                    Edit
                  </button>
                )}
              </div>
            ))}
          </div>
          {canRoles && (
            <button type="button" className="btn btn-soft" onClick={() => openModal({ kind: 'roles', communityId })}>
              <Icon name="plus" size={16} /> Create or edit roles
            </button>
          )}
        </div>
      )}

      {tab === 'members' && (
        <div className="modal-section">
          <div className="member-table">
            {community.members.map((member) => (
              <div key={member.userId} className="member-table-row">
                <Avatar size={30} name={member.displayName} url={member.avatarUrl} id={member.userId} presence={member.presence} />
                <div className="member-table-text">
                  <strong>{member.nickname || member.displayName}</strong>
                  <span>@{member.username}{member.userId === community.ownerId ? ' · owner' : ''}</span>
                </div>
                <div className="member-table-actions">
                  <button type="button" className="btn btn-soft btn-xs" onClick={() => openModal({ kind: 'profile', userId: member.userId })}>
                    View
                  </button>
                  {canKick && member.userId !== me.id && member.userId !== community.ownerId && (
                    <button
                      type="button"
                      className="btn btn-danger-ghost btn-xs"
                      onClick={() =>
                        openModal({
                          kind: 'confirm',
                          title: 'Remove member',
                          message: `Remove ${member.displayName} from ${community.name}?`,
                          confirmLabel: 'Remove',
                          run: () => kickMember(communityId, member.userId),
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'danger' && (
        <div className="modal-section danger-zone">
          {!isOwner && (
            <>
              <h3>Leave community</h3>
              <p className="modal-text">You will need a new invite to come back.</p>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  openModal({
                    kind: 'confirm',
                    title: 'Leave community',
                    message: `Leave ${community.name}?`,
                    confirmLabel: 'Leave',
                    run: () => leaveCommunity(communityId),
                  })
                }
              >
                Leave community
              </button>
            </>
          )}
          {isOwner && (
            <>
              <h3>Delete community</h3>
              <p className="modal-text">
                This permanently deletes every channel, message and role in {community.name}. There is no undo.
              </p>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  openModal({
                    kind: 'confirm',
                    title: 'Delete community',
                    message: `Permanently delete ${community.name}?`,
                    confirmLabel: 'Delete forever',
                    run: () => deleteCommunity(communityId),
                  })
                }
              >
                Delete community
              </button>
            </>
          )}
        </div>
      )}
    </ModalFrame>
  );
}

function ChannelSettings({ channelId }: { channelId: string }) {
  const communities = useStoreHook((state) => state.communities);
  const community = communities.find((entry) => entry.channels.some((channel) => channel.id === channelId));
  const channel = community?.channels.find((entry) => entry.id === channelId);
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [slowmode, setSlowmode] = useState(channel?.slowmode ?? 0);
  const [isPrivate, setIsPrivate] = useState(channel?.isPrivate ?? false);

  if (!community || !channel) return null;

  return (
    <ModalFrame title={`#${channel.name}`} subtitle="Channel settings" onClose={closeModal}>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      </label>
      {channel.type === 'text' && (
        <label className="field">
          <span className="field-label">Topic</span>
          <textarea className="input textarea" rows={2} maxLength={200} value={topic} onChange={(event) => setTopic(event.target.value)} />
        </label>
      )}
      <label className="field">
        <span className="field-label">Slow mode (seconds between messages)</span>
        <input
          className="input"
          type="number"
          min={0}
          max={21600}
          value={slowmode}
          onChange={(event) => setSlowmode(Math.max(0, Number(event.target.value) || 0))}
        />
      </label>
      <label className="switch-row">
        <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />
        <span>
          <strong>Private channel</strong>
          <small>Hidden from members unless they are invited.</small>
        </span>
      </label>
      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-danger-ghost"
          onClick={() =>
            openModal({
              kind: 'confirm',
              title: 'Delete channel',
              message: `Delete #${channel.name} and all of its messages?`,
              confirmLabel: 'Delete channel',
              run: async () => {
                await deleteChannel(channelId);
              },
            })
          }
        >
          Delete channel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            try {
              await updateChannel(channelId, { name: name.trim(), topic: topic.trim(), slowmode, isPrivate });
              closeModal();
            } catch (err) {
              toastError(err);
            }
          }}
        >
          Save changes
        </button>
      </div>
    </ModalFrame>
  );
}

function RolesModal({ communityId }: { communityId: string }) {
  const communities = useStoreHook((state) => state.communities);
  const community = communities.find((entry) => entry.id === communityId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#a01b2d');
  const [permissions, setPermissions] = useState(0);

  const selected = community?.roles.find((role) => role.id === selectedId) ?? null;

  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setColor(selected.color);
      setPermissions(selected.permissions);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!community) return null;

  function toggle(bit: number) {
    setPermissions((current) => (current & bit ? current & ~bit : current | bit));
  }

  return (
    <ModalFrame title="Roles" subtitle={community.name} onClose={closeModal} wide>
      <div className="roles-layout">
        <div className="roles-side">
          {community.roles.map((role) => (
            <button
              key={role.id}
              type="button"
              className={cx('role-pick', selectedId === role.id && 'active')}
              onClick={() => setSelectedId(role.id)}
            >
              <span className="role-dot" style={{ background: role.color }} />
              {role.name}
            </button>
          ))}
          <button
            type="button"
            className="role-pick role-pick-new"
            onClick={() => {
              setSelectedId(null);
              setName('');
              setColor('#a01b2d');
              setPermissions(PERM.SEND_MESSAGES | PERM.ADD_REACTIONS | PERM.ATTACH_FILES);
            }}
          >
            <Icon name="plus" size={14} /> New role
          </button>
        </div>

        <div className="roles-main">
          <label className="field">
            <span className="field-label">Role name</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} />
          </label>
          <label className="field">
            <span className="field-label">Color</span>
            <div className="color-row">
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <input className="input" value={color} onChange={(event) => setColor(event.target.value)} maxLength={7} />
            </div>
          </label>
          <div className="perm-list">
            {PERMISSION_OPTIONS.map((option) => (
              <label key={option.bit} className="perm-row">
                <input
                  type="checkbox"
                  checked={(permissions & option.bit) === option.bit}
                  onChange={() => toggle(option.bit)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            {selected && !selected.isDefault && (
              <button
                type="button"
                className="btn btn-danger-ghost"
                onClick={() =>
                  openModal({
                    kind: 'confirm',
                    title: 'Delete role',
                    message: `Delete the ${selected.name} role? Members keep their other roles.`,
                    confirmLabel: 'Delete role',
                    run: async () => {
                      await deleteRole(selected.id);
                      setSelectedId(null);
                    },
                  })
                }
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  if (selected) await updateRole(selected.id, { name: name.trim(), color, permissions });
                  else await createRole(communityId, { name: name.trim(), color, permissions });
                  setSelectedId(null);
                  setName('');
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              {selected ? 'Save role' : 'Create role'}
            </button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}

function CreateGroup() {
  const people = useStoreHook((state) => state.people);
  const me = useStoreHook((state) => state.me);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');

  const candidates = useMemo(
    () =>
      Object.values(people)
        .filter((person) => person.id !== me?.id)
        .filter(
          (person) =>
            person.displayName.toLowerCase().includes(query.toLowerCase()) ||
            person.username.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [people, me?.id, query],
  );

  return (
    <ModalFrame title="New conversation" subtitle="Pick one person for a direct message, or several for a group." onClose={closeModal}>
      <input className="input" placeholder="Search people you share a space with" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      <div className="people-list">
        {candidates.map((person) => (
          <button
            key={person.id}
            type="button"
            className={cx('person-row', selected.includes(person.id) && 'selected')}
            onClick={() =>
              setSelected((current) =>
                current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id],
              )
            }
          >
            <Avatar size={32} name={person.displayName} url={person.avatarUrl} id={person.id} presence={person.presence} />
            <span>
              <strong>{person.displayName}</strong>
              <small>@{person.username}</small>
            </span>
            <span className="check-box">{selected.includes(person.id) && <Icon name="check" size={13} />}</span>
          </button>
        ))}
        {candidates.length === 0 && (
          <p className="modal-text">
            No one here yet. Join a community to meet people, or invite someone with your community link.
          </p>
        )}
      </div>
      {selected.length > 1 && (
        <label className="field">
          <span className="field-label">Group name (optional)</span>
          <input className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </label>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-soft" onClick={closeModal}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={selected.length === 0}
          onClick={async () => {
            try {
              if (selected.length === 1) await startDm(selected[0]);
              else await createGroup(selected, name.trim() || undefined);
              closeModal();
            } catch (err) {
              toastError(err);
            }
          }}
        >
          {selected.length > 1 ? 'Create group' : 'Message'}
        </button>
      </div>
    </ModalFrame>
  );
}

function ProfileModal({ userId }: { userId: string }) {
  const person = useStoreHook((state) => state.people[userId]);
  const communities = useStoreHook((state) => state.communities);
  const me = useStoreHook((state) => state.me);
  const [communityId, setCommunityId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [badgeBusy, setBadgeBusy] = useState<string | null>(null);
  const { catalog: badgeCatalog, canGrant } = useBadgeCatalog();

  const sharedCommunities = communities.filter((community) =>
    community.members.some((member) => member.userId === userId),
  );
  const activeCommunity = sharedCommunities.find((community) => community.id === communityId) ?? sharedCommunities[0];
  const member: Member | undefined = activeCommunity?.members.find((entry) => entry.userId === userId);
  const canManageRoles = activeCommunity ? permissionFor(activeCommunity, PERM.MANAGE_ROLES) : false;
  const canKick = activeCommunity ? permissionFor(activeCommunity, PERM.KICK_MEMBERS) : false;

  if (!person) return null;
  const isMe = me?.id === userId;
  const badges = member?.badges ?? person.badges ?? [];

  return (
    <ModalFrame title={member?.nickname || person.displayName} subtitle={`@${person.username}`} onClose={closeModal}>
      <div className="profile-card">
        <Avatar size={72} name={person.displayName} url={person.avatarUrl} id={userId} presence={person.presence} />
        <div>
          <h3>{person.displayName}</h3>
          <p className={cx('presence-line', `presence-text-${person.presence}`)}>
            {person.presence === 'offline' ? 'Offline' : person.presence === 'dnd' ? 'Do not disturb' : person.presence === 'idle' ? 'Idle' : 'Online'}
            {person.customStatus ? ` · ${person.customStatus}` : ''}
          </p>
        </div>
      </div>

      {badges.length > 0 && (
        <div className="profile-badges">
          {badges.map((key) => (
            <BadgeChip key={key} badgeKey={key} showLabel size={14} />
          ))}
        </div>
      )}

      {member?.bio && <p className="modal-text">{member.bio}</p>}

      {sharedCommunities.length > 1 && (
        <label className="field">
          <span className="field-label">Roles shown for</span>
          <select className="input" value={activeCommunity?.id ?? ''} onChange={(event) => setCommunityId(event.target.value)}>
            {sharedCommunities.map((community) => (
              <option key={community.id} value={community.id}>{community.name}</option>
            ))}
          </select>
        </label>
      )}

      {activeCommunity && member && (
        <div className="profile-roles">
          {member.roles.length === 0 && <span className="tag">No roles</span>}
          {member.roles.map((roleId) => {
            const role = activeCommunity.roles.find((entry) => entry.id === roleId);
            if (!role) return null;
            return (
              <span key={roleId} className="role-pill" style={{ borderColor: role.color, color: role.color }}>
                {role.name}
              </span>
            );
          })}
        </div>
      )}

      {canManageRoles && activeCommunity && member && (
        <div className="modal-section">
          <h3>Assign roles</h3>
          <div className="role-check-list">
            {activeCommunity.roles
              .filter((role) => !role.isDefault)
              .map((role: Role) => (
                <label key={role.id} className="switch-row">
                  <input
                    type="checkbox"
                    checked={member.roles.includes(role.id)}
                    onChange={async (event) => {
                      const next = event.target.checked
                        ? [...member.roles.filter((id) => id !== role.id || true), role.id]
                        : member.roles.filter((id) => id !== role.id);
                      const unique = [...new Set(next)];
                      try {
                        await assignRoles(activeCommunity.id, userId, unique);
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  />
                  <span>
                    <strong style={{ color: role.color }}>{role.name}</strong>
                    <small>{role.permissions} permission bits</small>
                  </span>
                </label>
              ))}
          </div>
        </div>
      )}

      {canGrant && activeCommunity && member && badgeCatalog && (
        <div className="modal-section">
          <h3>Badges</h3>
          <p className="modal-hint">You are the server founder, so you can grant these to anyone here.</p>
          <div className="badge-grant-list">
            {badgeCatalog
              .filter((badge) => !badge.automatic)
              .map((badge) => {
                const has = badges.includes(badge.key);
                return (
                  <button
                    key={badge.key}
                    type="button"
                    className={cx('badge-grant', has && 'granted')}
                    style={{ '--badge-color': badge.color } as React.CSSProperties}
                    disabled={badgeBusy === badge.key}
                    title={badge.description}
                    onClick={async () => {
                      setBadgeBusy(badge.key);
                      try {
                        const next = has
                          ? await revokeBadge(userId, badge.key)
                          : await grantBadge(userId, badge.key);
                        applyBadges(userId, next);
                      } catch (err) {
                        toastError(err);
                      } finally {
                        setBadgeBusy(null);
                      }
                    }}
                  >
                    {badgeBusy === badge.key ? <Spinner size={13} /> : <BadgeGlyph icon={badge.icon} size={13} />}
                    {badge.name}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      <div className="modal-actions">
        {!isMe && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await startDm(userId);
                closeModal();
              } catch (err) {
                toastError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="at" size={16} /> Message
          </button>
        )}
        {isMe && (
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => {
              closeModal();
              setOverlay('settings');
            }}
          >
            Edit profile
          </button>
        )}
        {canKick && activeCommunity && !isMe && activeCommunity.ownerId !== userId && (
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={() =>
              openModal({
                kind: 'confirm',
                title: 'Remove member',
                message: `Remove ${person.displayName} from ${activeCommunity.name}?`,
                confirmLabel: 'Remove',
                run: () => kickMember(activeCommunity.id, userId),
              })
            }
          >
            Remove from community
          </button>
        )}
      </div>
    </ModalFrame>
  );
}

// keep tree-shaking honest for helpers referenced only in some branches
void addToGroup;
void setChannelAccess;
void leaveCommunity;
