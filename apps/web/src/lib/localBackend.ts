/**
 * On-device backend for the Android build.
 *
 * The Android app ships the whole client inside the APK and runs this module in
 * the WebView before React mounts. It replaces `fetch` and `WebSocket` with an
 * in-process implementation backed by IndexedDB, so the exact same UI works with
 * no server anywhere: accounts, communities, channels, direct messages, uploads,
 * search, roles, badges and the voice room all read and write local data.
 *
 * Data layout mirrors the server's HTTP API on purpose: the client code is
 * unchanged and every endpoint answers with the same JSON shape the server does.
 */

type ID = string;

type DeviceUser = {
  id: ID;
  email: string;
  username: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  avatarId: string | null;
  bio: string | null;
  customStatus: string | null;
  presence: string;
  createdAt: number;
  updatedAt: number;
};

type DeviceSession = {
  id: ID;
  userId: ID;
  token: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
};

type DeviceCommunity = {
  id: ID;
  name: string;
  description: string;
  iconId: string | null;
  ownerId: ID;
  inviteCode: string;
  createdAt: number;
};

type DeviceMember = { communityId: ID; userId: ID; nickname: string | null; joinedAt: number; roleIds: ID[] };

type DeviceRole = {
  id: ID;
  communityId: ID;
  name: string;
  color: string;
  permissions: number;
  position: number;
  isDefault: boolean;
  createdAt: number;
};

type DeviceChannel = {
  id: ID;
  communityId: ID;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  isPrivate: boolean;
  slowmode: number;
  createdAt: number;
  allowedUserIds: ID[];
};

type DeviceConversationMember = { userId: ID; joinedAt: number; lastReadAt: number; muted: boolean };

type DeviceConversation = {
  id: ID;
  type: 'dm' | 'group';
  name: string | null;
  iconId: string | null;
  ownerId: ID;
  createdAt: number;
  members: DeviceConversationMember[];
};

type DeviceMessage = {
  id: ID;
  channelId: ID | null;
  conversationId: ID | null;
  authorId: ID;
  content: string;
  replyToId: ID | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  attachmentIds: ID[];
  reactions: { userId: ID; emoji: string; at: number }[];
};

type DeviceUpload = {
  id: ID;
  ownerId: ID;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  dataUrl: string;
  createdAt: number;
};

type DeviceBadge = { userId: ID; key: string; grantedBy: ID | null; grantedAt: number };
type DeviceRead = { channelId: ID; userId: ID; lastReadAt: number };

type DeviceDB = {
  version: 1;
  users: DeviceUser[];
  sessions: DeviceSession[];
  communities: DeviceCommunity[];
  members: DeviceMember[];
  roles: DeviceRole[];
  channels: DeviceChannel[];
  conversations: DeviceConversation[];
  messages: DeviceMessage[];
  uploads: DeviceUpload[];
  badges: DeviceBadge[];
  reads: DeviceRead[];
};

type VoicePeer = { userId: ID; muted: boolean; video: boolean; sharing: boolean; joinedAt: number };

export const PERMISSIONS = {
  MANAGE_SERVER: 1 << 0,
  MANAGE_CHANNELS: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MANAGE_MESSAGES: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  CREATE_INVITES: 1 << 5,
  SEND_MESSAGES: 1 << 6,
  ATTACH_FILES: 1 << 7,
  ADD_REACTIONS: 1 << 8,
  MENTION_EVERYONE: 1 << 9,
  CONNECT_VOICE: 1 << 10,
  SPEAK: 1 << 11,
  MANAGE_MEMBERS: 1 << 12,
} as const;

const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((mask, bit) => mask | bit, 0);
const DEFAULT_MEMBER_PERMISSIONS =
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.CREATE_INVITES |
  PERMISSIONS.CONNECT_VOICE |
  PERMISSIONS.SPEAK |
  PERMISSIONS.MENTION_EVERYONE;

const BADGE_CATALOG = [
  { key: 'founder', name: 'Founder', description: 'Created this Fluenta space.', howToEarn: 'Automatic for the first account on this device.', color: '#e6b45c', icon: 'crown', automatic: true },
  { key: 'early', name: 'Early member', description: 'One of the first accounts here.', howToEarn: 'Automatic while you are among the first 100 accounts on this device.', color: '#74c0fc', icon: 'sparkle', automatic: true },
  { key: 'verified', name: 'Verified', description: 'Identity checked by the space owner.', howToEarn: 'Granted by the founder.', color: '#4ade80', icon: 'shield', automatic: false },
  { key: 'developer', name: 'Developer', description: 'Wrote code that shipped in Fluenta.', howToEarn: 'Granted for merged pull requests.', color: '#b794f6', icon: 'terminal', automatic: false },
  { key: 'bug_hunter', name: 'Bug hunter', description: 'Reported a real bug that got fixed.', howToEarn: 'Granted for reproducible bug reports.', color: '#fb923c', icon: 'flask', automatic: false },
  { key: 'helper', name: 'Helper', description: 'Goes out of their way for other members.', howToEarn: 'Granted by the founder.', color: '#f472b6', icon: 'heart', automatic: false },
  { key: 'builder', name: 'Builder', description: 'Shipped something with the Fluenta API.', howToEarn: 'Granted for bots and integrations built on Fluenta.', color: '#2dd4bf', icon: 'bolt', automatic: false },
  { key: 'legend', name: 'Community legend', description: 'A long-standing, trusted member.', howToEarn: 'Granted by the founder.', color: '#facc15', icon: 'star', automatic: false },
] as const;

const BADGE_ORDER = new Map<string, number>(BADGE_CATALOG.map((badge, index) => [badge.key, index]));
const TOKEN_KEY = 'fluenta:device-token';
const IDB_NAME = 'fluenta-device';
const IDB_STORE = 'state';
const IDB_KEY = 'database';

export function isLocalMode(): boolean {
  if (typeof window === 'undefined') return false;
  const flag = (window as unknown as { __FLUENTA_LOCAL__?: boolean }).__FLUENTA_LOCAL__;
  if (flag === true) return true;
  try {
    if (new URLSearchParams(window.location.search).get('local') === '1') return true;
  } catch {
    /* location may be opaque */
  }
  const capacitor = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return Boolean(capacitor?.getPlatform && capacitor.getPlatform() === 'android');
}

// --------------------------------------------------------------- persistence ---

function emptyDb(): DeviceDB {
  return {
    version: 1,
    users: [],
    sessions: [],
    communities: [],
    members: [],
    roles: [],
    channels: [],
    conversations: [],
    messages: [],
    uploads: [],
    badges: [],
    reads: [],
  };
}

let db: DeviceDB = emptyDb();
let loading: Promise<void> | null = null;
let persistTimer: number | null = null;
let storage: IDBDatabase | null = null;

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) request.result.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

async function load(): Promise<void> {
  try {
    storage = await openStore();
    const stored = await new Promise<DeviceDB | undefined>((resolve) => {
      const tx = storage!.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
      request.onsuccess = () => resolve(request.result as DeviceDB | undefined);
      request.onerror = () => resolve(undefined);
    });
    if (stored) db = { ...emptyDb(), ...stored };
  } catch {
    // Without IndexedDB the app still runs for the current session; data simply
    // does not survive a reload, which is better than refusing to start.
    db = emptyDb();
  }
}

function persistNow(): Promise<void> {
  if (!storage) return Promise.resolve();
  const snapshot = db;
  return new Promise((resolve) => {
    try {
      const tx = storage!.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(snapshot, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function save(): void {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 150);
}

function ready(): Promise<void> {
  if (!loading) loading = load();
  return loading;
}

// -------------------------------------------------------------------- helpers ---

function uid(prefix: string): ID {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 18)
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}${random}`;
}

function now(): number {
  return Date.now();
}

function token(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function inviteCode(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = typeof crypto !== 'undefined' && 'getRandomValues' in crypto ? crypto.getRandomValues(new Uint8Array(8)) : null;
  for (let i = 0; i < 8; i += 1) {
    const value = bytes ? bytes[i] : Math.floor(Math.random() * 256);
    out += alphabet[value % alphabet.length];
  }
  return out;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120_000, hash: 'SHA-256' }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToBase64(salt), hash: await derivePassword(password, salt) };
}

async function verifyPassword(password: string, saltB64: string, expected: string): Promise<boolean> {
  const actual = await derivePassword(password, base64ToBytes(saltB64));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function userById(id: ID): DeviceUser | undefined {
  return db.users.find((user) => user.id === id);
}

function uploadById(id: ID): DeviceUpload | undefined {
  return db.uploads.find((upload) => upload.id === id);
}

function avatarUrl(user: DeviceUser): string | null {
  if (!user.avatarId) return null;
  return uploadById(user.avatarId)?.dataUrl ?? null;
}

function iconUrl(id: string | null): string | null {
  if (!id) return null;
  return uploadById(id)?.dataUrl ?? null;
}

function currentUser(): DeviceUser | null {
  const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
  if (!value) return null;
  const session = db.sessions.find((entry) => entry.token === value);
  if (!session) return null;
  const user = userById(session.userId);
  if (!user) return null;
  session.lastSeenAt = now();
  return user;
}

function requireUser(): DeviceUser {
  const user = currentUser();
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).filter((entry): entry is string => typeof entry === 'string');
}

function presenceOf(user: DeviceUser): 'online' | 'idle' | 'dnd' | 'offline' {
  if (user.presence === 'invisible') return 'offline';
  if (user.presence === 'idle' || user.presence === 'dnd') return user.presence;
  return 'online';
}

function badgesFor(userId: ID): string[] {
  const founder = [...db.users].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
  const earlyIds = new Set([...db.users].sort((a, b) => a.createdAt - b.createdAt).slice(0, 100).map((user) => user.id));
  const keys: string[] = [];
  if (userId === founder) keys.push('founder');
  if (earlyIds.has(userId)) keys.push('early');
  for (const badge of db.badges) {
    if (badge.userId === userId && BADGE_ORDER.has(badge.key)) keys.push(badge.key);
  }
  return [...new Set(keys)].sort((a, b) => (BADGE_ORDER.get(a) ?? 99) - (BADGE_ORDER.get(b) ?? 99));
}

function publicUser(user: DeviceUser, includeEmail = false) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: avatarUrl(user),
    bio: user.bio,
    customStatus: user.customStatus,
    presence: presenceOf(user),
    createdAt: user.createdAt,
    badges: badgesFor(user.id),
    ...(includeEmail ? { email: user.email } : {}),
  };
}

function memberPayload(communityId: ID, userId: ID) {
  const user = userById(userId);
  if (!user) return null;
  const member = db.members.find((entry) => entry.communityId === communityId && entry.userId === userId);
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: avatarUrl(user),
    bio: user.bio,
    customStatus: user.customStatus,
    presence: presenceOf(user),
    nickname: member?.nickname ?? null,
    roles: member?.roleIds ?? [],
    badges: badgesFor(user.id),
    joinedAt: member?.joinedAt ?? user.createdAt,
  };
}

function effectivePermissions(communityId: ID, userId: ID): number {
  const community = db.communities.find((entry) => entry.id === communityId);
  if (!community) return 0;
  if (community.ownerId === userId) return ALL_PERMISSIONS;
  const member = db.members.find((entry) => entry.communityId === communityId && entry.userId === userId);
  if (!member) return 0;
  let mask = 0;
  const roles = db.roles.filter((role) => member.roleIds.includes(role.id));
  for (const role of roles) mask |= role.permissions;
  if (roles.length === 0) mask |= DEFAULT_MEMBER_PERMISSIONS;
  return mask;
}

function canManageChannel(communityId: ID, userId: ID): boolean {
  return (effectivePermissions(communityId, userId) & PERMISSIONS.MANAGE_CHANNELS) === PERMISSIONS.MANAGE_CHANNELS;
}

function visibleChannels(communityId: ID, userId: ID): DeviceChannel[] {
  const manage = canManageChannel(communityId, userId);
  return db.channels
    .filter((channel) => channel.communityId === communityId)
    .filter((channel) => manage || !channel.isPrivate || channel.allowedUserIds.includes(userId))
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

function channelPayload(channel: DeviceChannel) {
  return {
    id: channel.id,
    communityId: channel.communityId,
    name: channel.name,
    type: channel.type,
    topic: channel.topic,
    position: channel.position,
    isPrivate: channel.isPrivate,
    slowmode: channel.slowmode,
    createdAt: channel.createdAt,
  };
}

function communityPayload(community: DeviceCommunity, viewerId: ID) {
  const members = db.members
    .filter((member) => member.communityId === community.id)
    .map((member) => memberPayload(community.id, member.userId))
    .filter((member): member is NonNullable<typeof member> => Boolean(member))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    id: community.id,
    name: community.name,
    description: community.description,
    iconUrl: iconUrl(community.iconId),
    ownerId: community.ownerId,
    inviteCode: community.inviteCode,
    createdAt: community.createdAt,
    memberCount: members.length,
    myPermissions: effectivePermissions(community.id, viewerId),
    roles: db.roles
      .filter((role) => role.communityId === community.id)
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
      .map((role) => ({ id: role.id, name: role.name, color: role.color, permissions: role.permissions, position: role.position, isDefault: role.isDefault })),
    members,
    channels: visibleChannels(community.id, viewerId).map(channelPayload),
  };
}

function conversationMembers(conversation: DeviceConversation) {
  return conversation.members
    .map((entry) => {
      const user = userById(entry.userId);
      if (!user) return null;
      return {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: avatarUrl(user),
        bio: user.bio,
        customStatus: user.customStatus,
        presence: presenceOf(user),
        roles: [] as string[],
        badges: badgesFor(user.id),
        joinedAt: entry.joinedAt,
      };
    })
    .filter((member): member is NonNullable<typeof member> => Boolean(member));
}

function conversationPayload(conversation: DeviceConversation, viewerId: ID) {
  const last = db.messages
    .filter((message) => message.conversationId === conversation.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const mine = conversation.members.find((entry) => entry.userId === viewerId);
  const unread = db.messages.filter(
    (message) =>
      message.conversationId === conversation.id &&
      message.createdAt > (mine?.lastReadAt ?? 0) &&
      message.authorId !== viewerId &&
      !message.deletedAt,
  ).length;
  const reads = Object.fromEntries(conversation.members.map((entry) => [entry.userId, entry.lastReadAt]));
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    iconUrl: iconUrl(conversation.iconId),
    ownerId: conversation.ownerId,
    createdAt: conversation.createdAt,
    members: conversationMembers(conversation),
    lastMessage: last
      ? {
          id: last.id,
          content: last.deletedAt ? 'Message deleted' : last.content.slice(0, 140) || 'Attachment',
          authorId: last.authorId,
          createdAt: last.createdAt,
        }
      : null,
    unread,
    reads,
    muted: Boolean(mine?.muted),
  };
}

function readByFor(message: DeviceMessage): string[] {
  if (!message.channelId) return [];
  return db.reads
    .filter((read) => read.channelId === message.channelId && read.lastReadAt >= message.createdAt)
    .map((read) => read.userId);
}

function serializeMessage(message: DeviceMessage, viewerId: ID) {
  const author = userById(message.authorId);
  const parent = message.replyToId ? db.messages.find((entry) => entry.id === message.replyToId) : undefined;
  const parentAuthor = parent ? userById(parent.authorId) : undefined;
  const attachmentIds = message.attachmentIds ?? [];
  const attachments = attachmentIds
    .map((id) => uploadById(id))
    .filter((upload): upload is DeviceUpload => Boolean(upload))
    .map((upload) => ({
      id: upload.id,
      url: upload.dataUrl,
      name: upload.name,
      mime: upload.mime,
      size: upload.size,
      width: upload.width,
      height: upload.height,
      isImage: upload.mime.startsWith('image/'),
    }));
  const grouped = new Map<string, { count: number; me: boolean; users: string[] }>();
  for (const reaction of message.reactions ?? []) {
    const entry = grouped.get(reaction.emoji) ?? { count: 0, me: false, users: [] };
    entry.count += 1;
    entry.users.push(reaction.userId);
    if (reaction.userId === viewerId) entry.me = true;
    grouped.set(reaction.emoji, entry);
  }
  return {
    id: message.id,
    channelId: message.channelId,
    conversationId: message.conversationId,
    author: {
      id: author?.id ?? 'unknown',
      username: author?.username ?? 'unknown',
      displayName: author?.displayName ?? 'Unknown',
      avatarUrl: author ? avatarUrl(author) : null,
    },
    content: message.deletedAt ? '' : message.content,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    replyTo: parent
      ? {
          id: parent.id,
          content: parent.deletedAt ? '' : parent.content,
          author: {
            id: parentAuthor?.id ?? 'unknown',
            username: parentAuthor?.username ?? 'unknown',
            displayName: parentAuthor?.displayName ?? 'Unknown',
          },
        }
      : null,
    attachments,
    reactions: [...grouped.entries()].map(([emoji, entry]) => ({ emoji, count: entry.count, me: entry.me, users: entry.users })),
    readBy: readByFor(message),
  };
}

function unreadMap(userId: ID) {
  const channels: Record<string, number> = {};
  for (const channel of db.channels) {
    const community = db.communities.find((entry) => entry.id === channel.communityId);
    if (!community || !db.members.some((member) => member.communityId === community.id && member.userId === userId)) continue;
    const read = db.reads.find((entry) => entry.channelId === channel.id && entry.userId === userId)?.lastReadAt ?? 0;
    const count = db.messages.filter(
      (message) => message.channelId === channel.id && message.createdAt > read && message.authorId !== userId && !message.deletedAt,
    ).length;
    if (count > 0) channels[channel.id] = count;
  }
  const conversations: Record<string, number> = {};
  for (const conversation of db.conversations) {
    const mine = conversation.members.find((member) => member.userId === userId);
    if (!mine) continue;
    const count = db.messages.filter(
      (message) =>
        message.conversationId === conversation.id &&
        message.createdAt > mine.lastReadAt &&
        message.authorId !== userId &&
        !message.deletedAt,
    ).length;
    if (count > 0) conversations[conversation.id] = count;
  }
  return { channels, conversations };
}

function communityForChannel(channel: DeviceChannel): DeviceCommunity | undefined {
  return db.communities.find((entry) => entry.id === channel.communityId);
}

function communityAudience(communityId: ID): string[] {
  return db.members.filter((member) => member.communityId === communityId).map((member) => member.userId);
}

function createMessage(input: {
  authorId: ID;
  channelId: ID | null;
  conversationId: ID | null;
  content: string;
  attachmentIds: string[];
  replyToId: string | null;
  nonce?: string | null;
}) {
  const content = input.content.slice(0, 4000).trim();
  const attachmentIds = input.attachmentIds.slice(0, 5);
  if (!content && attachmentIds.length === 0) throw new HttpError(400, 'Message cannot be empty');
  if (input.content.length > 4000) throw new HttpError(400, 'Message is too long (max 4000 characters)');

  const message: DeviceMessage = {
    id: uid('m_'),
    channelId: input.channelId,
    conversationId: input.conversationId,
    authorId: input.authorId,
    content,
    replyToId: input.replyToId,
    createdAt: now(),
    editedAt: null,
    deletedAt: null,
    attachmentIds,
    reactions: [],
  };
  db.messages.push(message);
  save();
  const serialized = serializeMessage(message, input.authorId);
  broadcast({ op: 'message:new', message: { ...serialized, ...(input.nonce ? { nonce: input.nonce } : {}) } });
  return serialized;
}

// ---------------------------------------------------------------- realtime ---

type LocalListener = (event: Record<string, unknown>) => void;
const sockets = new Set<LocalSocket>();
const voiceRooms = new Map<ID, VoicePeer[]>();

class LocalSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = LocalSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    void ready().then(() => {
      if (this.readyState !== LocalSocket.CONNECTING) return;
      this.readyState = LocalSocket.OPEN;
      sockets.add(this);
      this.onopen?.(new Event('open'));
      const user = currentUser();
      if (!user) return;
      this.emit(readyPayload(user));
    });
  }

  emit(event: Record<string, unknown>) {
    if (this.readyState !== LocalSocket.OPEN) return;
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  send(raw: string) {
    if (this.readyState !== LocalSocket.OPEN) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    handleSocketEvent(event);
  }

  close() {
    this.readyState = LocalSocket.CLOSED;
    sockets.delete(this);
    this.onclose?.(new Event('close'));
  }
}

function broadcast(event: Record<string, unknown>) {
  for (const socket of sockets) socket.emit(event);
}

function readyPayload(user: DeviceUser) {
  const communities = db.communities
    .filter((community) => db.members.some((member) => member.communityId === community.id && member.userId === user.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((community) => communityPayload(community, user.id));
  const conversations = db.conversations
    .filter((conversation) => conversation.members.some((member) => member.userId === user.id))
    .map((conversation) => conversationPayload(conversation, user.id))
    .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  return {
    op: 'ready',
    user: publicUser(user, true),
    communities,
    summaries: communities.map((community) => ({
      id: community.id,
      name: community.name,
      iconUrl: community.iconUrl,
      memberCount: community.memberCount,
    })),
    conversations,
    unread: unreadMap(user.id),
    voice: Object.fromEntries(voiceRooms.entries()),
    serverTime: Date.now(),
  };
}

function handleSocketEvent(event: Record<string, unknown>) {
  const op = String(event.op ?? '');
  if (op === 'ping') {
    broadcast({ op: 'pong', t: event.t ?? Date.now() });
    return;
  }
  const user = currentUser();
  if (!user) return;

  if (op === 'typing') {
    // Only one account is signed in on this device, so there is nobody to show.
    return;
  }

  if (op === 'voice:join') {
    const channelId = String(event.channelId ?? '');
    const channel = db.channels.find((entry) => entry.id === channelId && entry.type === 'voice');
    if (!channel) return;
    if (!visibleChannels(channel.communityId, user.id).some((entry) => entry.id === channelId)) return;
    for (const [id, peers] of voiceRooms) {
      const filtered = peers.filter((peer) => peer.userId !== user.id);
      if (filtered.length !== peers.length) voiceRooms.set(id, filtered);
    }
    const peer: VoicePeer = {
      userId: user.id,
      muted: Boolean(event.muted),
      video: Boolean(event.video),
      sharing: Boolean(event.sharing),
      joinedAt: now(),
    };
    voiceRooms.set(channelId, [...(voiceRooms.get(channelId) ?? []), peer]);
    broadcast({ op: 'voice:peers', channelId, peers: [] });
    broadcast({ op: 'voice:join', channelId, peer });
    return;
  }

  if (op === 'voice:leave') {
    for (const [channelId, peers] of voiceRooms) {
      if (!peers.some((entry) => entry.userId === user.id)) continue;
      voiceRooms.set(channelId, peers.filter((entry) => entry.userId !== user.id));
      broadcast({ op: 'voice:leave', channelId, userId: user.id });
    }
    return;
  }

  if (op === 'voice:state') {
    for (const [channelId, peers] of voiceRooms) {
      const peer = peers.find((entry) => entry.userId === user.id);
      if (!peer) continue;
      peer.muted = Boolean(event.muted);
      peer.video = Boolean(event.video);
      peer.sharing = Boolean(event.sharing);
      broadcast({ op: 'voice:state', channelId, peer });
    }
    return;
  }
}

// ------------------------------------------------------------------ routing ---

type RouteResult = { status: number; body: unknown };

function ok(body: unknown, status = 200): RouteResult {
  return { status, body };
}

function match(segments: string[], pattern: string): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const value = segments[i];
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}

async function readBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (!body) return {};
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new HttpError(400, 'Could not read that file'));
    reader.readAsDataURL(file);
  });
}

async function route(method: string, rawUrl: string, rawBody: BodyInit | null | undefined): Promise<RouteResult> {
  await ready();
  const url = new URL(rawUrl, 'https://device.fluenta');
  const path = url.pathname;
  const segments = path.split('/').filter(Boolean);
  const payload = await readBody(rawBody);
  const body = object(payload);
  let params: Record<string, string> | null = null;

  try {
    if (!path.startsWith('/api/')) return ok({ error: 'Not found' }, 404);

    // ---- auth ----
    if (method === 'GET' && match(segments, '/api/auth/auth-config')) {
      return ok({ google: false, registrationOpen: true, mail: false, local: true });
    }

    if (method === 'GET' && match(segments, '/api/auth/me')) {
      const user = currentUser();
      if (!user) return ok({ error: 'Not authenticated' }, 401);
      return ok({ user: publicUser(user, true) });
    }

    if (method === 'POST' && match(segments, '/api/auth/signup')) {
      const email = text(body.email, 200).toLowerCase();
      const username = normalizeUsername(text(body.username, 24));
      const displayName = text(body.displayName, 40) || username;
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
      if (!/^[-a-zA-Z0-9._]{3,24}$/.test(username)) throw new HttpError(400, 'Usernames are 3-24 letters, numbers, dots, dashes or underscores');
      if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters');
      if (db.users.some((entry) => entry.email.toLowerCase() === email)) throw new HttpError(409, 'That email already has an account on this device');
      if (db.users.some((entry) => entry.username.toLowerCase() === username)) throw new HttpError(409, 'That username is taken on this device');
      const { salt, hash } = await hashPassword(password);
      const created = now();
      const user: DeviceUser = {
        id: uid('u_'),
        email,
        username,
        displayName: displayName || username,
        passwordSalt: salt,
        passwordHash: hash,
        avatarId: null,
        bio: null,
        customStatus: null,
        presence: 'online',
        createdAt: created,
        updatedAt: created,
      };
      db.users.push(user);
      seedFirstSpace(user);
      startSession(user);
      save();
      return ok({ user: publicUser(user, true) }, 201);
    }

    if (method === 'POST' && match(segments, '/api/auth/login')) {
      const email = text(body.email, 200).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      const user = db.users.find((entry) => entry.email.toLowerCase() === email || entry.username.toLowerCase() === email);
      if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) {
        throw new HttpError(401, 'Wrong email or password');
      }
      startSession(user);
      save();
      return ok({ user: publicUser(user, true) });
    }

    if (method === 'POST' && match(segments, '/api/auth/logout')) {
      endSession();
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && match(segments, '/api/auth/forgot-password')) {
      return ok({ delivery: 'device' });
    }

    if (method === 'POST' && match(segments, '/api/auth/reset-password')) {
      const email = text(body.email, 200).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters');
      const user = db.users.find((entry) => entry.email.toLowerCase() === email);
      if (!user) throw new HttpError(404, 'No account with that email on this device');
      const { salt, hash } = await hashPassword(password);
      user.passwordSalt = salt;
      user.passwordHash = hash;
      user.updatedAt = now();
      db.sessions = db.sessions.filter((session) => session.userId !== user.id);
      save();
      return ok({ ok: true });
    }

    if (method === 'GET' && (params = match(segments, '/api/auth/invite-preview/:code'))) {
      const community = db.communities.find((entry) => entry.inviteCode === params!.code);
      if (!community) throw new HttpError(404, 'That invite link is not valid');
      return ok({
        invite: {
          communityId: community.id,
          name: community.name,
          description: community.description,
          iconUrl: iconUrl(community.iconId),
          memberCount: db.members.filter((member) => member.communityId === community.id).length,
        },
      });
    }

    // Everything below needs a signed-in account.
    const me = requireUser();

    // ---- profile ----
    if (method === 'GET' && match(segments, '/api/me')) {
      return ok({ user: publicUser(me, true) });
    }

    if (method === 'PATCH' && match(segments, '/api/me')) {
      if (typeof body.username === 'string') {
        const username = normalizeUsername(body.username);
        if (!/^[-a-zA-Z0-9._]{3,24}$/.test(username)) throw new HttpError(400, 'Usernames are 3-24 letters, numbers, dots, dashes or underscores');
        if (db.users.some((entry) => entry.id !== me.id && entry.username.toLowerCase() === username)) {
          throw new HttpError(409, 'That username is taken on this device');
        }
        me.username = username;
      }
      if (typeof body.displayName === 'string') {
        const displayName = text(body.displayName, 40);
        if (!displayName) throw new HttpError(400, 'Display name cannot be empty');
        me.displayName = displayName;
      }
      if (typeof body.bio === 'string') me.bio = text(body.bio, 280) || null;
      if (typeof body.customStatus === 'string') me.customStatus = text(body.customStatus, 120) || null;
      if (body.avatarId === null) me.avatarId = null;
      else if (typeof body.avatarId === 'string' && uploadById(body.avatarId)) me.avatarId = body.avatarId;
      if (typeof body.presence === 'string' && ['online', 'idle', 'dnd', 'invisible'].includes(body.presence)) {
        me.presence = body.presence;
      }
      me.updatedAt = now();
      save();
      const user = publicUser(me, true);
      broadcast({ op: 'profile:update', user });
      return ok({ user });
    }

    if (method === 'DELETE' && match(segments, '/api/me')) {
      deleteAccount(me);
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && match(segments, '/api/me/password')) {
      const current = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      if (next.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters');
      if (!(await verifyPassword(current, me.passwordSalt, me.passwordHash))) throw new HttpError(403, 'Your current password is wrong');
      const { salt, hash } = await hashPassword(next);
      me.passwordSalt = salt;
      me.passwordHash = hash;
      me.updatedAt = now();
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
      db.sessions = db.sessions.filter((session) => session.userId !== me.id && session.token !== token);
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && match(segments, '/api/me/presence')) {
      const presence = String(body.presence ?? 'online');
      me.presence = ['online', 'idle', 'dnd', 'invisible'].includes(presence) ? presence : 'online';
      me.updatedAt = now();
      save();
      broadcast({ op: 'profile:update', user: publicUser(me, true) });
      return ok({ ok: true });
    }

    if (method === 'GET' && match(segments, '/api/me/sessions')) {
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
      return ok({
        sessions: db.sessions
          .filter((session) => session.userId === me.id)
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map((session) => ({
            id: session.id,
            current: session.token === token,
            userAgent: session.userAgent,
            ip: session.ip,
            createdAt: session.createdAt,
            lastSeenAt: session.lastSeenAt,
          })),
      });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/me/sessions/:id'))) {
      db.sessions = db.sessions.filter((session) => !(session.id === params!.id && session.userId === me.id));
      save();
      return ok({ ok: true });
    }

    // ---- communities ----
    if (method === 'GET' && match(segments, '/api/communities')) {
      return ok({
        communities: db.communities
          .filter((community) => db.members.some((member) => member.communityId === community.id && member.userId === me.id))
          .map((community) => ({
            id: community.id,
            name: community.name,
            iconUrl: iconUrl(community.iconId),
            memberCount: db.members.filter((member) => member.communityId === community.id).length,
          })),
      });
    }

    if (method === 'POST' && match(segments, '/api/communities')) {
      const name = text(body.name, 80);
      if (!name) throw new HttpError(400, 'Give the community a name');
      const community = createCommunity(me, name, text(body.description, 300));
      save();
      return ok({ community: communityPayload(community, me.id) }, 201);
    }

    if (method === 'GET' && (params = match(segments, '/api/communities/:id'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community || !db.members.some((member) => member.communityId === community.id && member.userId === me.id)) {
        throw new HttpError(404, 'Community not found');
      }
      return ok({ community: communityPayload(community, me.id) });
    }

    if (method === 'POST' && (params = match(segments, '/api/communities/join'))) {
      const code = text(body.code, 64);
      const community = db.communities.find((entry) => entry.inviteCode === code);
      if (!community) throw new HttpError(404, 'That invite is not valid');
      joinCommunity(community, me);
      save();
      return ok({ community: communityPayload(community, me.id) });
    }

    if (method === 'POST' && (params = match(segments, '/api/communities/:id/leave'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if (community.ownerId === me.id) throw new HttpError(400, 'Transfer or delete the community instead of leaving it');
      db.members = db.members.filter((member) => !(member.communityId === community.id && member.userId === me.id));
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && (params = match(segments, '/api/communities/:id/invites'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.CREATE_INVITES) !== PERMISSIONS.CREATE_INVITES) {
        throw new HttpError(403, 'You cannot create invites here');
      }
      community.inviteCode = inviteCode();
      save();
      return ok({ inviteCode: community.inviteCode });
    }

    if (method === 'PATCH' && (params = match(segments, '/api/communities/:id'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.MANAGE_SERVER) !== PERMISSIONS.MANAGE_SERVER) {
        throw new HttpError(403, 'You cannot edit this community');
      }
      if (typeof body.name === 'string') {
        const name = text(body.name, 80);
        if (!name) throw new HttpError(400, 'Community name cannot be empty');
        community.name = name;
      }
      if (typeof body.description === 'string') community.description = text(body.description, 300);
      if (body.iconId === null) community.iconId = null;
      else if (typeof body.iconId === 'string' && uploadById(body.iconId)) community.iconId = body.iconId;
      save();
      const payload = communityPayload(community, me.id);
      broadcast({ op: 'community:update', community: payload });
      return ok({ community: payload });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/communities/:id'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if (community.ownerId !== me.id) throw new HttpError(403, 'Only the owner can delete this community');
      deleteCommunity(community);
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && (params = match(segments, '/api/communities/:id/channels'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.MANAGE_CHANNELS) !== PERMISSIONS.MANAGE_CHANNELS) {
        throw new HttpError(403, 'You cannot create channels here');
      }
      const type = body.type === 'voice' ? 'voice' : 'text';
      const name = (text(body.name, 40) || (type === 'voice' ? 'Voice' : 'general')).toLowerCase().replace(/\s+/g, '-');
      const channel: DeviceChannel = {
        id: uid('c_'),
        communityId: community.id,
        name,
        type,
        topic: type === 'text' ? text(body.topic, 200) : '',
        position: db.channels.filter((entry) => entry.communityId === community.id).length,
        isPrivate: Boolean(body.isPrivate),
        slowmode: 0,
        createdAt: now(),
        allowedUserIds: [],
      };
      db.channels.push(channel);
      save();
      return ok({ community: communityPayload(community, me.id) });
    }

    if (method === 'POST' && (params = match(segments, '/api/communities/:id/roles'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.MANAGE_ROLES) !== PERMISSIONS.MANAGE_ROLES) {
        throw new HttpError(403, 'You cannot manage roles here');
      }
      const name = text(body.name, 40);
      if (!name) throw new HttpError(400, 'Give the role a name');
      db.roles.push({
        id: uid('r_'),
        communityId: community.id,
        name,
        color: typeof body.color === 'string' ? body.color : '#b9b9c0',
        permissions: Number(body.permissions) || 0,
        position: db.roles.filter((role) => role.communityId === community.id).length,
        isDefault: false,
        createdAt: now(),
      });
      save();
      return ok({ community: communityPayload(community, me.id) });
    }

    if ((method === 'PATCH' || method === 'DELETE') && (params = match(segments, '/api/communities/roles/:roleId'))) {
      const role = db.roles.find((entry) => entry.id === params!.roleId);
      if (!role) throw new HttpError(404, 'Role not found');
      if ((effectivePermissions(role.communityId, me.id) & PERMISSIONS.MANAGE_ROLES) !== PERMISSIONS.MANAGE_ROLES) {
        throw new HttpError(403, 'You cannot manage roles here');
      }
      const community = db.communities.find((entry) => entry.id === role.communityId)!;
      if (method === 'DELETE') {
        if (role.isDefault) throw new HttpError(400, 'The default role cannot be deleted');
        db.roles = db.roles.filter((entry) => entry.id !== role.id);
        for (const member of db.members) member.roleIds = member.roleIds.filter((id) => id !== role.id);
      } else {
        if (typeof body.name === 'string' && text(body.name, 40)) role.name = text(body.name, 40);
        if (typeof body.color === 'string') role.color = body.color;
        if (typeof body.permissions === 'number') role.permissions = body.permissions;
      }
      save();
      return ok({ community: communityPayload(community, me.id) });
    }

    if (method === 'PUT' && (params = match(segments, '/api/communities/:id/members/:userId/roles'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.MANAGE_ROLES) !== PERMISSIONS.MANAGE_ROLES) {
        throw new HttpError(403, 'You cannot manage roles here');
      }
      const member = db.members.find((entry) => entry.communityId === community.id && entry.userId === params!.userId);
      if (!member) throw new HttpError(404, 'Member not found');
      member.roleIds = strings(body.roleIds).filter((id) => db.roles.some((role) => role.id === id && role.communityId === community.id));
      save();
      return ok({ community: communityPayload(community, me.id) });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/communities/:id/members/:userId'))) {
      const community = db.communities.find((entry) => entry.id === params!.id);
      if (!community) throw new HttpError(404, 'Community not found');
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.KICK_MEMBERS) !== PERMISSIONS.KICK_MEMBERS) {
        throw new HttpError(403, 'You cannot remove members');
      }
      if (params!.userId === community.ownerId) throw new HttpError(400, 'The owner cannot be removed');
      db.members = db.members.filter((member) => !(member.communityId === community.id && member.userId === params!.userId));
      save();
      return ok({ ok: true });
    }

    // ---- channels ----
    if (method === 'PATCH' && (params = match(segments, '/api/channels/:id'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      if (!canManageChannel(channel.communityId, me.id)) throw new HttpError(403, 'You cannot edit this channel');
      if (typeof body.name === 'string' && text(body.name, 40)) channel.name = text(body.name, 40).toLowerCase().replace(/\s+/g, '-');
      if (typeof body.topic === 'string') channel.topic = text(body.topic, 200);
      if (typeof body.slowmode === 'number') channel.slowmode = Math.max(0, Math.min(21_600, Math.round(body.slowmode)));
      if (typeof body.isPrivate === 'boolean') channel.isPrivate = body.isPrivate;
      save();
      return ok({ ok: true });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/channels/:id'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      if (!canManageChannel(channel.communityId, me.id)) throw new HttpError(403, 'You cannot delete this channel');
      db.channels = db.channels.filter((entry) => entry.id !== channel.id);
      db.messages = db.messages.filter((message) => message.channelId !== channel.id);
      db.reads = db.reads.filter((read) => read.channelId !== channel.id);
      save();
      return ok({ ok: true });
    }

    if (method === 'PUT' && (params = match(segments, '/api/channels/:id/members'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      if (!canManageChannel(channel.communityId, me.id)) throw new HttpError(403, 'You cannot change access here');
      const userId = String(body.userId ?? '');
      const allowed = Boolean(body.allowed);
      channel.allowedUserIds = channel.allowedUserIds.filter((id) => id !== userId);
      if (allowed) channel.allowedUserIds.push(userId);
      save();
      return ok({ ok: true });
    }

    if (method === 'GET' && (params = match(segments, '/api/channels/:id/messages'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      if (!visibleChannels(channel.communityId, me.id).some((entry) => entry.id === channel.id)) {
        throw new HttpError(403, 'You cannot read this channel');
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      const before = Number(url.searchParams.get('before') ?? 0);
      const all = db.messages
        .filter((message) => message.channelId === channel.id)
        .filter((message) => !before || message.createdAt < before)
        .sort((a, b) => a.createdAt - b.createdAt);
      const page = all.slice(Math.max(0, all.length - limit));
      return ok({
        messages: page.map((message) => serializeMessage(message, me.id)),
        hasMore: all.length > page.length,
      });
    }

    if (method === 'POST' && (params = match(segments, '/api/channels/:id/messages'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      const community = communityForChannel(channel);
      if (!community || !db.members.some((member) => member.communityId === community.id && member.userId === me.id)) {
        throw new HttpError(403, 'You are not a member of this community');
      }
      if ((effectivePermissions(community.id, me.id) & PERMISSIONS.SEND_MESSAGES) !== PERMISSIONS.SEND_MESSAGES) {
        throw new HttpError(403, 'You cannot send messages in this channel');
      }
      if (channel.slowmode > 0) {
        const last = db.messages
          .filter((message) => message.channelId === channel.id && message.authorId === me.id)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (last && now() - last.createdAt < channel.slowmode * 1000) {
          const wait = Math.ceil((channel.slowmode * 1000 - (now() - last.createdAt)) / 1000);
          throw new HttpError(429, `Slow mode is on — wait ${wait}s`);
        }
      }
      const attachmentIds = strings(body.attachmentIds).filter((id) => uploadById(id)?.ownerId === me.id);
      const replyToId = typeof body.replyToId === 'string' ? body.replyToId : null;
      if (replyToId) {
        const parent = db.messages.find((entry) => entry.id === replyToId);
        if (!parent || parent.channelId !== channel.id) throw new HttpError(400, 'Cannot reply to that message');
      }
      const message = createMessage({
        authorId: me.id,
        channelId: channel.id,
        conversationId: null,
        content: typeof body.content === 'string' ? body.content : '',
        attachmentIds,
        replyToId,
        nonce: typeof body.nonce === 'string' ? body.nonce : null,
      });
      return ok({ message }, 201);
    }

    if (method === 'POST' && (params = match(segments, '/api/channels/:id/read'))) {
      const channel = db.channels.find((entry) => entry.id === params!.id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      const existing = db.reads.find((read) => read.channelId === channel.id && read.userId === me.id);
      const ts = now();
      if (existing) existing.lastReadAt = ts;
      else db.reads.push({ channelId: channel.id, userId: me.id, lastReadAt: ts });
      save();
      broadcast({ op: 'read', channelId: channel.id, userId: me.id, lastReadAt: ts });
      return ok({ ok: true });
    }

    // ---- conversations ----
    if (method === 'POST' && match(segments, '/api/conversations')) {
      const userIds = [...new Set(strings(body.userIds).filter((id) => id !== me.id && userById(id)))];
      if (userIds.length === 0) throw new HttpError(400, 'Pick at least one person');
      const type = body.type === 'group' || userIds.length > 1 ? 'group' : 'dm';
      if (type === 'dm') {
        const existing = db.conversations.find(
          (conversation) =>
            conversation.type === 'dm' &&
            conversation.members.length === 2 &&
            conversation.members.some((member) => member.userId === me.id) &&
            conversation.members.some((member) => member.userId === userIds[0]),
        );
        if (existing) return ok({ conversation: conversationPayload(existing, me.id) });
      }
      const created = now();
      const conversation: DeviceConversation = {
        id: uid('d_'),
        type,
        name: type === 'group' ? text(body.name, 60) || null : null,
        iconId: null,
        ownerId: me.id,
        createdAt: created,
        members: [me.id, ...userIds].map((userId) => ({ userId, joinedAt: created, lastReadAt: 0, muted: false })),
      };
      db.conversations.push(conversation);
      save();
      return ok({ conversation: conversationPayload(conversation, me.id) }, 201);
    }

    if (method === 'GET' && (params = match(segments, '/api/conversations/:id/messages'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation || !conversation.members.some((member) => member.userId === me.id)) {
        throw new HttpError(404, 'Conversation not found');
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      const before = Number(url.searchParams.get('before') ?? 0);
      const all = db.messages
        .filter((message) => message.conversationId === conversation.id)
        .filter((message) => !before || message.createdAt < before)
        .sort((a, b) => a.createdAt - b.createdAt);
      const page = all.slice(Math.max(0, all.length - limit));
      return ok({
        messages: page.map((message) => serializeMessage(message, me.id)),
        hasMore: all.length > page.length,
      });
    }

    if (method === 'POST' && (params = match(segments, '/api/conversations/:id/messages'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation || !conversation.members.some((member) => member.userId === me.id)) {
        throw new HttpError(404, 'Conversation not found');
      }
      const attachmentIds = strings(body.attachmentIds).filter((id) => uploadById(id)?.ownerId === me.id);
      const replyToId = typeof body.replyToId === 'string' ? body.replyToId : null;
      if (replyToId) {
        const parent = db.messages.find((entry) => entry.id === replyToId);
        if (!parent || parent.conversationId !== conversation.id) throw new HttpError(400, 'Cannot reply to that message');
      }
      const message = createMessage({
        authorId: me.id,
        channelId: null,
        conversationId: conversation.id,
        content: typeof body.content === 'string' ? body.content : '',
        attachmentIds,
        replyToId,
        nonce: typeof body.nonce === 'string' ? body.nonce : null,
      });
      return ok({ message }, 201);
    }

    if (method === 'POST' && (params = match(segments, '/api/conversations/:id/read'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const member = conversation.members.find((entry) => entry.userId === me.id);
      if (!member) throw new HttpError(404, 'Conversation not found');
      member.lastReadAt = now();
      save();
      broadcast({ op: 'read', conversationId: conversation.id, userId: me.id, lastReadAt: member.lastReadAt });
      return ok({ ok: true });
    }

    if (method === 'POST' && (params = match(segments, '/api/conversations/:id/members'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      if (!conversation.members.some((member) => member.userId === me.id)) throw new HttpError(403, 'You are not in this conversation');
      const userId = String(body.userId ?? '');
      if (!userById(userId)) throw new HttpError(404, 'User not found');
      if (!conversation.members.some((member) => member.userId === userId)) {
        conversation.members.push({ userId, joinedAt: now(), lastReadAt: 0, muted: false });
        save();
      }
      return ok({ conversation: conversationPayload(conversation, me.id) });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/conversations/:id/members/:userId'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const target = params!.userId;
      if (target !== me.id && conversation.ownerId !== me.id) throw new HttpError(403, 'You cannot remove that member');
      conversation.members = conversation.members.filter((member) => member.userId !== target);
      if (target === me.id && conversation.members.length === 0) {
        db.conversations = db.conversations.filter((entry) => entry.id !== conversation.id);
      }
      save();
      return ok({ ok: true });
    }

    if (method === 'POST' && (params = match(segments, '/api/conversations/:id/mute'))) {
      const conversation = db.conversations.find((entry) => entry.id === params!.id);
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      const member = conversation.members.find((entry) => entry.userId === me.id);
      if (!member) throw new HttpError(403, 'You are not in this conversation');
      member.muted = Boolean(body.muted);
      save();
      return ok({ ok: true });
    }

    // ---- messages ----
    if (method === 'PATCH' && (params = match(segments, '/api/messages/:id'))) {
      const message = db.messages.find((entry) => entry.id === params!.id);
      if (!message || message.deletedAt) throw new HttpError(404, 'Message not found');
      const community = message.channelId
        ? db.channels.find((entry) => entry.id === message.channelId)
        : undefined;
      const canManage = community ? (effectivePermissions(community.communityId, me.id) & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES : false;
      if (message.authorId !== me.id && !canManage) throw new HttpError(403, 'You cannot edit that message');
      const content = typeof body.content === 'string' ? body.content.trim().slice(0, 4000) : '';
      if (!content) throw new HttpError(400, 'Message cannot be empty');
      message.content = content;
      message.editedAt = now();
      save();
      broadcast({ op: 'message:update', message: { id: message.id, content, editedAt: message.editedAt } });
      return ok({ message: serializeMessage(message, me.id) });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/messages/:id'))) {
      const message = db.messages.find((entry) => entry.id === params!.id);
      if (!message) throw new HttpError(404, 'Message not found');
      const channel = message.channelId ? db.channels.find((entry) => entry.id === message.channelId) : undefined;
      const canManage = channel ? (effectivePermissions(channel.communityId, me.id) & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES : false;
      if (message.authorId !== me.id && !canManage) throw new HttpError(403, 'You cannot delete that message');
      message.deletedAt = now();
      message.content = '';
      message.attachmentIds = [];
      message.reactions = [];
      save();
      broadcast({ op: 'message:delete', id: message.id });
      return ok({ ok: true });
    }

    if ((method === 'PUT' || method === 'DELETE') && (params = match(segments, '/api/messages/:id/reactions/:emoji'))) {
      const message = db.messages.find((entry) => entry.id === params!.id);
      if (!message || message.deletedAt) throw new HttpError(404, 'Message not found');
      const emoji = params!.emoji;
      if (method === 'PUT') {
        if (!message.reactions.some((reaction) => reaction.userId === me.id && reaction.emoji === emoji)) {
          message.reactions.push({ userId: me.id, emoji, at: now() });
        }
      } else {
        message.reactions = message.reactions.filter((reaction) => !(reaction.userId === me.id && reaction.emoji === emoji));
      }
      save();
      broadcast({ op: 'reaction', messageId: message.id, emoji, userId: me.id, added: method === 'PUT' });
      return ok({ ok: true });
    }

    // ---- search ----
    if (method === 'GET' && match(segments, '/api/search')) {
      const query = (url.searchParams.get('q') ?? '').trim();
      const needle = query.toLowerCase();
      if (needle.length < 2) {
        return ok({ messages: [], users: [], channels: [], communities: [], conversations: [] });
      }
      const myCommunityIds = new Set(db.members.filter((member) => member.userId === me.id).map((member) => member.communityId));
      const visibleChannelIds = new Set(
        db.channels.filter((channel) => myCommunityIds.has(channel.communityId) && visibleChannels(channel.communityId, me.id).some((entry) => entry.id === channel.id)).map((channel) => channel.id),
      );
      const messages = db.messages
        .filter((message) => !message.deletedAt && message.channelId && visibleChannelIds.has(message.channelId))
        .filter((message) => message.content.toLowerCase().includes(needle))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((message) => {
          const channel = db.channels.find((entry) => entry.id === message.channelId)!;
          const community = db.communities.find((entry) => entry.id === channel.communityId)!;
          return {
            ...serializeMessage(message, me.id),
            snippet: message.content.slice(0, 160),
            context: {
              type: 'channel' as const,
              channelId: channel.id,
              channelName: channel.name,
              communityId: community.id,
              communityName: community.name,
            },
          };
        });
      const users = db.users
        .filter((user) => user.id !== me.id)
        .filter((user) => db.members.some((member) => member.userId === user.id && myCommunityIds.has(member.communityId)))
        .filter((user) => user.displayName.toLowerCase().includes(needle) || user.username.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((user) => publicUser(user));
      const channels = db.channels
        .filter((channel) => visibleChannelIds.has(channel.id) && channel.name.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          communityId: channel.communityId,
          communityName: db.communities.find((entry) => entry.id === channel.communityId)?.name ?? '',
        }));
      const communities = db.communities
        .filter((community) => myCommunityIds.has(community.id) && community.name.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((community) => ({
          id: community.id,
          name: community.name,
          iconUrl: iconUrl(community.iconId),
          description: community.description,
        }));
      const conversations = db.conversations
        .filter((conversation) => conversation.members.some((member) => member.userId === me.id))
        .filter((conversation) => (conversation.name ?? '').toLowerCase().includes(needle))
        .slice(0, 10)
        .map((conversation) => ({ id: conversation.id, name: conversation.name ?? 'Conversation', type: conversation.type }));
      return ok({ messages, users, channels, communities, conversations });
    }

    // ---- badges ----
    if (method === 'GET' && match(segments, '/api/badges')) {
      const founder = [...db.users].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
      return ok({ badges: BADGE_CATALOG, mine: badgesFor(me.id), canGrant: founder === me.id });
    }

    if (method === 'POST' && (params = match(segments, '/api/badges/:key/grant'))) {
      const founder = [...db.users].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
      if (founder !== me.id) throw new HttpError(403, 'Only the founder can grant badges');
      const definition = BADGE_CATALOG.find((badge) => badge.key === params!.key);
      if (!definition) throw new HttpError(404, 'Unknown badge');
      if (definition.automatic) throw new HttpError(400, `${definition.name} is granted automatically`);
      const userId = String(body.userId ?? '');
      if (!userById(userId)) throw new HttpError(404, 'User not found');
      if (!db.badges.some((badge) => badge.userId === userId && badge.key === definition.key)) {
        db.badges.push({ userId, key: definition.key, grantedBy: me.id, grantedAt: now() });
        save();
      }
      const badges = badgesFor(userId);
      broadcast({ op: 'badges:update', userId, badges });
      return ok({ badges });
    }

    if (method === 'DELETE' && (params = match(segments, '/api/badges/:key/grant/:userId'))) {
      const founder = [...db.users].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
      if (founder !== me.id) throw new HttpError(403, 'Only the founder can manage badges');
      db.badges = db.badges.filter((badge) => !(badge.userId === params!.userId && badge.key === params!.key));
      save();
      const badges = badgesFor(params!.userId);
      broadcast({ op: 'badges:update', userId: params!.userId, badges });
      return ok({ badges });
    }

    // ---- uploads ----
    if (method === 'POST' && match(segments, '/api/uploads')) {
      if (!(payload instanceof FormData)) throw new HttpError(400, 'Expected a file upload');
      const file = payload.get('file');
      if (!(file instanceof File)) throw new HttpError(400, 'Pick a file to upload');
      if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'Files are limited to 25 MB');
      const dataUrl = await fileToDataUrl(file);
      const upload: DeviceUpload = {
        id: uid('f_'),
        ownerId: me.id,
        name: file.name || 'file',
        mime: file.type || 'application/octet-stream',
        size: file.size,
        width: Number(payload.get('width')) || null,
        height: Number(payload.get('height')) || null,
        dataUrl,
        createdAt: now(),
      };
      db.uploads.push(upload);
      save();
      return ok({
        upload: {
          id: upload.id,
          url: upload.dataUrl,
          name: upload.name,
          mime: upload.mime,
          size: upload.size,
          width: upload.width,
          height: upload.height,
          isImage: upload.mime.startsWith('image/'),
        },
      }, 201);
    }

    return ok({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof HttpError) return ok({ error: error.message }, error.status);
    console.error('[device]', method, path, error);
    return ok({ error: 'Something went wrong in the on-device database' }, 500);
  }
}

// ----------------------------------------------------------------- mutations ---

function startSession(user: DeviceUser): void {
  const session: DeviceSession = {
    id: uid('s_'),
    userId: user.id,
    token: token(),
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    ip: 'on-device',
    createdAt: now(),
    lastSeenAt: now(),
  };
  db.sessions.push(session);
  try {
    localStorage.setItem(TOKEN_KEY, session.token);
  } catch {
    /* private mode */
  }
}

function endSession(): void {
  const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
  if (value) db.sessions = db.sessions.filter((session) => session.token !== value);
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

function seedFirstSpace(owner: DeviceUser): void {
  const community = createCommunity(owner, 'My space', 'Your private corner of Fluenta. Rename it, invite people or make another.');
  void community;
}

function createCommunity(owner: DeviceUser, name: string, description: string): DeviceCommunity {
  const created = now();
  const community: DeviceCommunity = {
    id: uid('k_'),
    name,
    description,
    iconId: null,
    ownerId: owner.id,
    inviteCode: inviteCode(),
    createdAt: created,
  };
  db.communities.push(community);
  db.members.push({ communityId: community.id, userId: owner.id, nickname: null, joinedAt: created, roleIds: [] });
  db.roles.push({
    id: uid('r_'),
    communityId: community.id,
    name: 'Member',
    color: '#b9b9c0',
    permissions: DEFAULT_MEMBER_PERMISSIONS,
    position: 0,
    isDefault: true,
    createdAt: created,
  });
  db.channels.push(
    {
      id: uid('c_'),
      communityId: community.id,
      name: 'general',
      type: 'text',
      topic: '',
      position: 0,
      isPrivate: false,
      slowmode: 0,
      createdAt: created,
      allowedUserIds: [],
    },
    {
      id: uid('c_'),
      communityId: community.id,
      name: 'Lounge',
      type: 'voice',
      topic: '',
      position: 1,
      isPrivate: false,
      slowmode: 0,
      createdAt: created + 1,
      allowedUserIds: [],
    },
  );
  return community;
}

function joinCommunity(community: DeviceCommunity, user: DeviceUser): void {
  if (db.members.some((member) => member.communityId === community.id && member.userId === user.id)) return;
  db.members.push({ communityId: community.id, userId: user.id, nickname: null, joinedAt: now(), roleIds: [] });
  broadcast({ op: 'community:join', community: communityPayload(community, user.id) });
}

function deleteCommunity(community: DeviceCommunity): void {
  db.communities = db.communities.filter((entry) => entry.id !== community.id);
  db.members = db.members.filter((member) => member.communityId !== community.id);
  db.roles = db.roles.filter((role) => role.communityId !== community.id);
  const channelIds = new Set(db.channels.filter((channel) => channel.communityId === community.id).map((channel) => channel.id));
  db.channels = db.channels.filter((channel) => channel.communityId !== community.id);
  db.messages = db.messages.filter((message) => !message.channelId || !channelIds.has(message.channelId));
  db.reads = db.reads.filter((read) => !channelIds.has(read.channelId));
}

function deleteAccount(user: DeviceUser): void {
  for (const community of db.communities.filter((entry) => entry.ownerId === user.id)) deleteCommunity(community);
  db.members = db.members.filter((member) => member.userId !== user.id);
  db.messages = db.messages.filter((message) => message.authorId !== user.id);
  db.reads = db.reads.filter((read) => read.userId !== user.id);
  db.badges = db.badges.filter((badge) => badge.userId !== user.id);
  db.conversations = db.conversations
    .map((conversation) => ({ ...conversation, members: conversation.members.filter((member) => member.userId !== user.id) }))
    .filter((conversation) => conversation.members.length > 0);
  db.sessions = db.sessions.filter((session) => session.userId !== user.id);
  db.uploads = db.uploads.filter((upload) => upload.ownerId !== user.id);
  db.users = db.users.filter((entry) => entry.id !== user.id);
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

// --------------------------------------------------------------------- install ---

let installed = false;

export function installLocalBackend(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  (window as unknown as { __FLUENTA_LOCAL__?: boolean }).__FLUENTA_LOCAL__ = true;
  void ready();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.pathname.startsWith('/api/')) {
        await ready();
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();
        const result = await route(method, parsed.pathname + parsed.search, init?.body ?? null);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    } catch {
      /* fall through to the network for non-API URLs */
    }
    return nativeFetch(input as RequestInfo, init);
  }) as typeof window.fetch;

  window.WebSocket = LocalSocket as unknown as typeof WebSocket;

  const flush = () => {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    void persistNow();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Exposed for tests and debugging: a snapshot of the on-device database. */
export function deviceSnapshot(): DeviceDB {
  return db;
}
