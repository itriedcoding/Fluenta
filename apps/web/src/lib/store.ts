import { useSyncExternalStore } from 'react';
import { api, ApiError, onUnauthorized, uploadFile } from './api';
import { realtime, type RealtimeEvent } from './realtime';
import { voice, type VoiceSnapshot } from './webrtc';
import { showLocalNotification } from './push';
import type {
  Channel,
  Community,
  Conversation,
  Member,
  Message,
  Person,
  Presence,
  PresenceChoice,
  Scope,
  SearchResults,
  SessionInfo,
  Toast,
  User,
  VoicePeer,
} from './types';
import { scopeKey, storageGet, storageSet } from './util';

type MessageCache = { items: Message[]; hasMore: boolean; loading: boolean; loaded: boolean };
type TypingEntry = { userId: string; name: string };

export type Modal =
  | { kind: 'create-community' }
  | { kind: 'create-channel'; communityId: string }
  | { kind: 'community-settings'; communityId: string }
  | { kind: 'channel-settings'; channelId: string }
  | { kind: 'invite'; communityId: string }
  | { kind: 'roles'; communityId: string }
  | { kind: 'create-group' }
  | { kind: 'profile'; userId: string }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; run: () => Promise<void> | void }
  | null;

export type Overlay = 'search' | 'settings' | null;

export type State = {
  bootstrapped: boolean;
  me: User | null;
  authConfig: { google: boolean; registrationOpen: boolean; mail: boolean };
  connection: 'connecting' | 'online' | 'offline';
  communities: Community[];
  conversations: Conversation[];
  people: Record<string, Person>;
  active: Scope | null;
  messages: Record<string, MessageCache>;
  unread: Record<string, number>;
  reads: Record<string, Record<string, number>>;
  typing: Record<string, TypingEntry[]>;
  voiceRooms: Record<string, VoicePeer[]>;
  voiceSession: VoiceSnapshot;
  toasts: Toast[];
  modal: Modal;
  overlay: Overlay;
  memberList: boolean;
  mobileView: 'sidebar' | 'chat';
  replyTo: Message | null;
  theme: 'dark' | 'light';
  notifications: boolean;
};

const initial: State = {
  bootstrapped: false,
  me: null,
  authConfig: { google: false, registrationOpen: true, mail: false },
  connection: 'offline',
  communities: [],
  conversations: [],
  people: {},
  active: null,
  messages: {},
  unread: {},
  reads: {},
  typing: {},
  voiceRooms: {},
  voiceSession: voice.snapshot,
  toasts: [],
  modal: null,
  overlay: null,
  memberList: true,
  mobileView: 'sidebar',
  replyTo: null,
  theme: storageGet<'dark' | 'light'>('fluenta:theme', 'dark'),
  notifications: storageGet<boolean>('fluenta:notifications', false),
};

let state: State = { ...initial, theme: initial.theme, notifications: initial.notifications };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function set(patch: Partial<State> | ((current: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  emit();
}

export function getState(): State {
  return state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (current: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'dark' ? '#08080a' : '#f6f6f8');
}

applyTheme(state.theme);

// ---------------------------------------------------------------- helpers ---

function toast(message: string, kind: Toast['kind'] = 'info') {
  const id = Math.random().toString(36).slice(2);
  set((current) => ({ toasts: [...current.toasts, { id, message, kind }].slice(-4) }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 3500);
}

export function dismissToast(id: string) {
  set((current) => ({ toasts: current.toasts.filter((t) => t.id !== id) }));
}

export function toastError(err: unknown) {
  const message =
    err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong';
  toast(message, 'error');
}

export function openModal(modal: Modal) {
  // Only one surface at a time: a modal must never stack under an overlay.
  set({ modal, overlay: null });
}

export function closeModal() {
  set({ modal: null });
}

export function setOverlay(overlay: Overlay) {
  set({ overlay, modal: null });
}

export function toggleMemberList() {
  set((current) => ({ memberList: !current.memberList }));
}

export function setMobileView(view: 'sidebar' | 'chat') {
  set({ mobileView: view });
}

export function setTheme(theme: 'dark' | 'light') {
  storageSet('fluenta:theme', theme);
  applyTheme(theme);
  set({ theme });
}

export function setNotificationsEnabled(enabled: boolean) {
  storageSet('fluenta:notifications', enabled);
  set({ notifications: enabled });
}

function buildPeople(communities: Community[], conversations: Conversation[]): Record<string, Person> {
  const map: Record<string, Person> = {};
  for (const community of communities) {
    for (const member of community.members) {
      map[member.userId] = {
        id: member.userId,
        username: member.username,
        displayName: member.nickname || member.displayName,
        avatarUrl: member.avatarUrl,
        presence: member.presence,
        customStatus: member.customStatus,
      };
    }
  }
  for (const conversation of conversations) {
    for (const member of conversation.members) {
      map[member.userId] ??= {
        id: member.userId,
        username: member.username,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        presence: member.presence,
        customStatus: member.customStatus,
      };
    }
  }
  return map;
}

function readsFromConversations(conversations: Conversation[]): Record<string, Record<string, number>> {
  const reads: Record<string, Record<string, number>> = {};
  for (const conversation of conversations) {
    reads[`dm:${conversation.id}`] = { ...(conversation.reads ?? {}) };
  }
  return reads;
}

export function channelOf(id: string | null): Channel | null {
  if (!id) return null;
  for (const community of state.communities) {
    const channel = community.channels.find((ch) => ch.id === id);
    if (channel) return channel;
  }
  return null;
}

export function communityOfChannel(id: string | null): Community | null {
  if (!id) return null;
  return state.communities.find((community) => community.channels.some((ch) => ch.id === id)) ?? null;
}

export function activeConversation(): Conversation | null {
  if (!state.active || state.active.kind !== 'conversation') return null;
  return state.conversations.find((c) => c.id === state.active!.id) ?? null;
}

export function permissionFor(community: Community, permission: number): boolean {
  return (community.myPermissions & permission) === permission;
}

export const PERM = {
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

// -------------------------------------------------------------- bootstrap ---

export async function bootstrap() {
  try {
    const config = await api<{ google: boolean; registrationOpen: boolean; mail: boolean }>('/api/auth/auth-config');
    set({ authConfig: config });
  } catch {
    /* endpoint may be unreachable briefly during boot */
  }
  try {
    const { user } = await api<{ user: User }>('/api/auth/me');
    set({ me: user, bootstrapped: true });
    realtime.connect();
  } catch {
    set({ me: null, bootstrapped: true });
  }
}

onUnauthorized(() => {
  realtime.disconnect();
  voice.leave(true);
  set({ me: null, communities: [], conversations: [], active: null, messages: {}, bootstrapped: true });
});

// ------------------------------------------------------------------- auth ---

export async function signIn(email: string, password: string) {
  await api('/api/auth/login', { method: 'POST', body: { email, password } });
  window.location.reload();
}

export async function signUp(input: { email: string; username: string; displayName: string; password: string }) {
  await api('/api/auth/signup', { method: 'POST', body: input });
  window.location.reload();
}

export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  realtime.disconnect();
  voice.leave(true);
  set({ me: null, communities: [], conversations: [], active: null, messages: {} });
  window.location.href = '/';
}

export async function updateProfile(patch: {
  displayName?: string;
  username?: string;
  bio?: string;
  customStatus?: string;
  avatarId?: string | null;
  presence?: PresenceChoice;
}) {
  const { user } = await api<{ user: User }>('/api/me', { method: 'PATCH', body: patch });
  set({ me: user });
  refreshPeople();
  return user;
}

export async function uploadAvatar(file: File) {
  const uploaded = await uploadFile(file);
  return updateProfile({ avatarId: uploaded.id });
}

export async function changePassword(current: string, next: string) {
  await api('/api/me/password', { method: 'POST', body: { current, next } });
  toast('Password updated', 'success');
}

export async function setPresence(choice: PresenceChoice) {
  await api('/api/me/presence', { method: 'POST', body: { presence: choice } });
  set((current) => ({ me: current.me ? { ...current.me, presence: choice === 'invisible' ? 'offline' : choice } : null }));
}

export async function listSessions(): Promise<SessionInfo[]> {
  const { sessions } = await api<{ sessions: SessionInfo[] }>('/api/me/sessions');
  return sessions;
}

export async function revokeSession(id: string) {
  await api(`/api/me/sessions/${id}`, { method: 'DELETE' });
}

export async function deleteAccount() {
  await api('/api/me', { method: 'DELETE' });
  window.location.href = '/';
}

// -------------------------------------------------------------- selection ---

export function selectScope(scope: Scope, options: { mobile?: boolean } = {}) {
  const channel = scope.kind === 'channel' ? channelOf(scope.id) : null;
  set({ active: scope, replyTo: null, mobileView: options.mobile === false ? state.mobileView : 'chat' });
  storageSet('fluenta:scope', scope);
  if (scope.kind === 'conversation' || channel?.type === 'text') void ensureMessages(scope);
  markRead(scope);
}

function ensureMessages(scope: Scope) {
  const key = scopeKey(scope);
  const cache = state.messages[key];
  if (cache?.loaded || cache?.loading) return;
  return loadMessages(scope);
}

export async function loadMessages(scope: Scope, older = false) {
  const key = scopeKey(scope);
  const existing = state.messages[key];
  if (existing?.loading) return;
  set((current) => ({
    messages: {
      ...current.messages,
      [key]: { items: existing?.items ?? [], hasMore: existing?.hasMore ?? true, loading: true, loaded: existing?.loaded ?? false },
    },
  }));

  try {
    const before = older && existing?.items.length ? existing.items[0].createdAt : null;
    const query = `?limit=50${before ? `&before=${before}` : ''}`;
    const path =
      scope.kind === 'channel'
        ? `/api/channels/${scope.id}/messages${query}`
        : `/api/conversations/${scope.id}/messages${query}`;
    const data = await api<{ messages: Message[]; hasMore: boolean }>(path);
    set((current) => {
      const cache = current.messages[key];
      const combined = older ? [...data.messages, ...(cache?.items ?? [])] : data.messages;
      const deduped = new Map(combined.map((message) => [message.id, message]));
      const items = [...deduped.values()].sort((a, b) => a.createdAt - b.createdAt);
      let reads = current.reads;
      if (scope.kind === 'channel') {
        const nextReads = { ...(reads[key] ?? {}) };
        for (const message of items) {
          for (const userId of message.readBy ?? []) {
            nextReads[userId] = Math.max(nextReads[userId] ?? 0, message.createdAt);
          }
        }
        reads = { ...reads, [key]: nextReads };
      }
      return {
        messages: { ...current.messages, [key]: { items, hasMore: data.hasMore, loading: false, loaded: true } },
        reads,
      };
    });
  } catch (err) {
    set((current) => ({
      messages: {
        ...current.messages,
        [key]: { items: existing?.items ?? [], hasMore: existing?.hasMore ?? false, loading: false, loaded: true },
      },
    }));
    toastError(err);
  }
}

export function clearReply() {
  set({ replyTo: null });
}

export function setReply(message: Message | null) {
  set({ replyTo: message });
}

export function markRead(scope: Scope) {
  const key = scopeKey(scope);
  if (state.unread[key]) {
    set((current) => ({ unread: { ...current.unread, [key]: 0 } }));
  }
  const path =
    scope.kind === 'channel' ? `/api/channels/${scope.id}/read` : `/api/conversations/${scope.id}/read`;
  void api(path, { method: 'POST' }).catch(() => {});
}

// --------------------------------------------------------------- messaging ---

function applyUnreadOnIncoming(message: Message) {
  const key = message.channelId ? `ch:${message.channelId}` : `dm:${message.conversationId}`;
  const isActive = state.active && scopeKey(state.active) === key;
  const fromMe = message.author.id === state.me?.id;
  if (isActive && !fromMe) {
    markRead(state.active!);
    return;
  }
  if (fromMe) return;
  set((current) => ({ unread: { ...current.unread, [key]: (current.unread[key] ?? 0) + 1 } }));
}

function upsertMessage(message: Message) {
  const key = message.channelId ? `ch:${message.channelId}` : `dm:${message.conversationId}`;
  set((current) => {
    const cache = current.messages[key];
    let nextMessages = current.messages;
    if (cache) {
      const existingIndex = cache.items.findIndex((item) => item.id === message.id);
      const tempIndex = message.nonce ? cache.items.findIndex((item) => item.nonce === message.nonce) : -1;
      let items = cache.items;
      if (existingIndex >= 0) {
        items = cache.items.map((item) => (item.id === message.id ? { ...item, ...message } : item));
      } else if (tempIndex >= 0) {
        items = cache.items.map((item) => (item.nonce === message.nonce ? message : item));
      } else {
        items = [...cache.items, message].sort((a, b) => a.createdAt - b.createdAt);
      }
      nextMessages = { ...current.messages, [key]: { ...cache, items } };
    }

    let conversations = current.conversations;
    if (message.conversationId) {
      conversations = current.conversations.map((conversation) =>
        conversation.id === message.conversationId
          ? {
              ...conversation,
              lastMessage: {
                id: message.id,
                content: message.content || 'Attachment',
                authorId: message.author.id,
                createdAt: message.createdAt,
              },
            }
          : conversation,
      );
    }
    return { messages: nextMessages, conversations };
  });

  applyUnreadOnIncoming(message);
}

export async function sendMessage(input: { content: string; attachmentIds?: string[]; replyToId?: string | null }) {
  if (!state.active || !state.me) return;
  const scope = state.active;
  const key = scopeKey(scope);
  const nonce = Math.random().toString(36).slice(2);
  const optimistic: Message = {
    id: `tmp_${nonce}`,
    channelId: scope.kind === 'channel' ? scope.id : null,
    conversationId: scope.kind === 'conversation' ? scope.id : null,
    author: {
      id: state.me.id,
      username: state.me.username,
      displayName: state.me.displayName,
      avatarUrl: state.me.avatarUrl,
    },
    content: input.content,
    createdAt: Date.now(),
    editedAt: null,
    deletedAt: null,
    replyTo: null,
    attachments: [],
    reactions: [],
    nonce,
    pending: true,
  };

  set((current) => {
    const cache = current.messages[key];
    if (!cache) return {};
    return { messages: { ...current.messages, [key]: { ...cache, items: [...cache.items, optimistic] } } };
  });
  set({ replyTo: null });

  try {
    const path =
      scope.kind === 'channel' ? `/api/channels/${scope.id}/messages` : `/api/conversations/${scope.id}/messages`;
    await api<{ message: Message }>(path, {
      method: 'POST',
      body: { ...input, content: input.content, nonce },
    });
  } catch (err) {
    set((current) => {
      const cache = current.messages[key];
      if (!cache) return {};
      return {
        messages: {
          ...current.messages,
          [key]: {
            ...cache,
            items: cache.items.map((item) => (item.nonce === nonce ? { ...item, pending: false, failed: true } : item)),
          },
        },
      };
    });
    toastError(err);
  }
}

export async function editMessage(messageId: string, content: string) {
  const previous = findMessage(messageId);
  if (!previous) return;
  patchMessage(messageId, { content, editedAt: Date.now() });
  try {
    await api(`/api/messages/${messageId}`, { method: 'PATCH', body: { content } });
  } catch (err) {
    patchMessage(messageId, { content: previous.content, editedAt: previous.editedAt });
    toastError(err);
  }
}

export async function deleteMessage(messageId: string) {
  try {
    await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    patchMessage(messageId, { content: '', deletedAt: Date.now(), attachments: [], reactions: [] });
  } catch (err) {
    toastError(err);
  }
}

export async function toggleReaction(messageId: string, emoji: string) {
  const message = findMessage(messageId);
  if (!message || !state.me) return;
  const mine = message.reactions.find((r) => r.emoji === emoji);
  const meId = state.me.id;
  const reactions = mine
    ? mine.me
      ? message.reactions
          .map((r) =>
            r.emoji === emoji ? { ...r, count: r.count - 1, me: false, users: r.users.filter((u) => u !== meId) } : r,
          )
          .filter((r) => r.count > 0)
      : message.reactions.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, me: true, users: [...r.users, meId] } : r,
        )
    : [...message.reactions, { emoji, count: 1, me: true, users: [meId] }];

  patchMessage(messageId, { reactions });
  try {
    await api(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: mine?.me ? 'DELETE' : 'PUT',
    });
  } catch (err) {
    patchMessage(messageId, { reactions: message.reactions });
    toastError(err);
  }
}

function findMessage(messageId: string): Message | undefined {
  for (const cache of Object.values(state.messages)) {
    const found = cache.items.find((message) => message.id === messageId);
    if (found) return found;
  }
  return undefined;
}

function patchMessage(messageId: string, patch: Partial<Message>) {
  set((current) => {
    const nextMessages: Record<string, MessageCache> = {};
    let touched = false;
    for (const [key, cache] of Object.entries(current.messages)) {
      if (!cache.items.some((message) => message.id === messageId)) {
        nextMessages[key] = cache;
        continue;
      }
      touched = true;
      nextMessages[key] = {
        ...cache,
        items: cache.items.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
      };
    }
    return touched ? { messages: nextMessages } : {};
  });
}

function refreshPeople() {
  set((current) => ({ people: buildPeople(current.communities, current.conversations) }));
}

// ------------------------------------------------------------- communities ---

export async function createCommunity(name: string, description: string) {
  const { community } = await api<{ community: Community }>('/api/communities', {
    method: 'POST',
    body: { name, description },
  });
  set((current) => ({
    communities: [...current.communities, community],
    people: buildPeople([...current.communities, community], current.conversations),
  }));
  const first = community.channels.find((ch) => ch.type === 'text');
  if (first) selectScope({ kind: 'channel', id: first.id });
  toast(`“${community.name}” is ready`, 'success');
  return community;
}

export async function updateCommunity(
  communityId: string,
  patch: { name?: string; description?: string; iconId?: string | null },
) {
  const { community } = await api<{ community: Community }>(`/api/communities/${communityId}`, {
    method: 'PATCH',
    body: patch,
  });
  applyCommunity(community);
  return community;
}

export async function deleteCommunity(communityId: string) {
  await api(`/api/communities/${communityId}`, { method: 'DELETE' });
  set((current) => ({ communities: current.communities.filter((c) => c.id !== communityId) }));
  clearActiveIfMissing();
}

export async function leaveCommunity(communityId: string) {
  await api(`/api/communities/${communityId}/leave`, { method: 'POST' });
  set((current) => ({ communities: current.communities.filter((c) => c.id !== communityId) }));
  clearActiveIfMissing();
}

export async function createChannel(
  communityId: string,
  input: { name: string; type: 'text' | 'voice'; topic?: string; isPrivate?: boolean },
) {
  const { community } = await api<{ community: Community }>(`/api/communities/${communityId}/channels`, {
    method: 'POST',
    body: input,
  });
  applyCommunity(community);
  const created = community.channels.find((ch) => ch.name === input.name.toLowerCase().replace(/\s+/g, '-'));
  if (created && created.type === 'text') selectScope({ kind: 'channel', id: created.id });
}

export async function updateChannel(
  channelId: string,
  patch: { name?: string; topic?: string; slowmode?: number; isPrivate?: boolean },
) {
  await api(`/api/channels/${channelId}`, { method: 'PATCH', body: patch });
  await refreshCommunities();
}

export async function deleteChannel(channelId: string) {
  await api(`/api/channels/${channelId}`, { method: 'DELETE' });
  await refreshCommunities();
  clearActiveIfMissing();
}

export async function setChannelAccess(channelId: string, userId: string, allowed: boolean) {
  await api(`/api/channels/${channelId}/members`, { method: 'PUT', body: { userId, allowed } });
}

export async function createRole(communityId: string, input: { name: string; color: string; permissions: number }) {
  const { community } = await api<{ community: Community }>(`/api/communities/${communityId}/roles`, {
    method: 'POST',
    body: input,
  });
  applyCommunity(community);
}

export async function updateRole(
  roleId: string,
  patch: { name?: string; color?: string; permissions?: number },
) {
  const { community } = await api<{ community: Community }>(`/api/communities/roles/${roleId}`, {
    method: 'PATCH',
    body: patch,
  });
  applyCommunity(community);
}

export async function deleteRole(roleId: string) {
  const { community } = await api<{ community: Community }>(`/api/communities/roles/${roleId}`, {
    method: 'DELETE',
  });
  applyCommunity(community);
}

export async function assignRoles(communityId: string, userId: string, roleIds: string[]) {
  const { community } = await api<{ community: Community }>(
    `/api/communities/${communityId}/members/${userId}/roles`,
    { method: 'PUT', body: { roleIds } },
  );
  applyCommunity(community);
}

export async function kickMember(communityId: string, userId: string) {
  await api(`/api/communities/${communityId}/members/${userId}`, { method: 'DELETE' });
  toast('Member removed');
}

export async function rotateInvite(communityId: string): Promise<string> {
  const { inviteCode } = await api<{ inviteCode: string }>(`/api/communities/${communityId}/invites`, {
    method: 'POST',
  });
  set((current) => ({
    communities: current.communities.map((community) =>
      community.id === communityId ? { ...community, inviteCode } : community,
    ),
  }));
  return inviteCode;
}

export async function joinInvite(code: string) {
  const { community } = await api<{ community: Community }>('/api/communities/join', {
    method: 'POST',
    body: { code },
  });
  set((current) => ({
    communities: current.communities.some((c) => c.id === community.id)
      ? current.communities.map((c) => (c.id === community.id ? community : c))
      : [...current.communities, community],
    people: buildPeople(
      current.communities.some((c) => c.id === community.id)
        ? current.communities.map((c) => (c.id === community.id ? community : c))
        : [...current.communities, community],
      current.conversations,
    ),
  }));
  const first = community.channels.find((ch) => ch.type === 'text');
  if (first) selectScope({ kind: 'channel', id: first.id });
  toast(`Joined ${community.name}`, 'success');
  return community;
}

export async function refreshCommunities() {
  const { communities } = await api<{ communities: { id: string }[] }>('/api/communities');
  const full = await Promise.all(
    communities.map((summary) => api<{ community: Community }>(`/api/communities/${summary.id}`)),
  );
  const list = full.map((entry) => entry.community);
  set((current) => ({ communities: list, people: buildPeople(list, current.conversations) }));
  clearActiveIfMissing();
}

function applyCommunity(community: Community) {
  set((current) => {
    const exists = current.communities.some((c) => c.id === community.id);
    const communities = exists
      ? current.communities.map((c) => (c.id === community.id ? community : c))
      : [...current.communities, community];
    return { communities, people: buildPeople(communities, current.conversations), unread: current.unread };
  });
}

function clearActiveIfMissing() {
  const active = state.active;
  if (!active) return;
  if (active.kind === 'channel' && !channelOf(active.id)) set({ active: null });
  if (active.kind === 'conversation' && !state.conversations.some((c) => c.id === active.id)) {
    set({ active: null });
  }
}

// ----------------------------------------------------------- conversations ---

export async function startDm(userId: string) {
  const { conversation } = await api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: { type: 'dm', userIds: [userId] },
  });
  upsertConversation(conversation);
  selectScope({ kind: 'conversation', id: conversation.id });
  set({ modal: null, overlay: null });
  return conversation;
}

export async function createGroup(userIds: string[], name?: string) {
  const { conversation } = await api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: { type: 'group', userIds, name },
  });
  upsertConversation(conversation);
  selectScope({ kind: 'conversation', id: conversation.id });
  set({ modal: null });
  return conversation;
}

export async function addToGroup(conversationId: string, userId: string) {
  await api(`/api/conversations/${conversationId}/members`, { method: 'POST', body: { userId } });
}

export async function leaveConversation(conversationId: string) {
  await api(`/api/conversations/${conversationId}/members/${state.me?.id}`, { method: 'DELETE' });
  set((current) => ({ conversations: current.conversations.filter((c) => c.id !== conversationId) }));
  clearActiveIfMissing();
}

export async function removeFromGroup(conversationId: string, userId: string) {
  await api(`/api/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' });
}

export async function muteConversation(conversationId: string, muted: boolean) {
  await api(`/api/conversations/${conversationId}/mute`, { method: 'POST', body: { muted } });
  set((current) => ({
    conversations: current.conversations.map((c) => (c.id === conversationId ? { ...c, muted } : c)),
  }));
}

function upsertConversation(conversation: Conversation) {
  set((current) => {
    const exists = current.conversations.some((c) => c.id === conversation.id);
    const conversations = exists
      ? current.conversations.map((c) => (c.id === conversation.id ? conversation : c))
      : [conversation, ...current.conversations];
    return {
      conversations,
      people: buildPeople(current.communities, conversations),
      reads: { ...current.reads, [`dm:${conversation.id}`]: { ...(conversation.reads ?? {}) } },
    };
  });
}

// ------------------------------------------------------------------ search ---

export async function search(query: string): Promise<SearchResults> {
  return api<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`);
}

// ------------------------------------------------------------------- voice ---

export async function joinVoice(channelId: string, video = false) {
  const channel = channelOf(channelId);
  if (!channel) return;
  await voice.join(channelId, { video });
}

export function leaveVoice() {
  voice.leave();
}

export async function startVoiceCall(userId: string) {
  const conversation = await startDm(userId);
  toast('Direct call started from the DM — pick a community voice channel to talk', 'info');
  return conversation;
}

// --------------------------------------------------------- realtime wiring ---

voice.onUpdate = (snapshot) => set({ voiceSession: snapshot });

function onVoiceSignal(event: RealtimeEvent) {
  const from = String(event.fromUserId ?? '');
  const data = event.data as { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  if (!from || !data) return;
  void voice.handleSignal(from, data).catch(() => {});
}

export function handleRealtimeEvent(event: RealtimeEvent) {
  switch (event.op) {
    case 'ready': {
      const user = event.user as User | null;
      const communities = (event.communities ?? []) as Community[];
      const conversations = (event.conversations ?? []) as Conversation[];
      const unreadRaw = (event.unread ?? {}) as { channels?: Record<string, number>; conversations?: Record<string, number> };
      const unread: Record<string, number> = {};
      for (const [id, count] of Object.entries(unreadRaw.channels ?? {})) unread[`ch:${id}`] = count;
      for (const [id, count] of Object.entries(unreadRaw.conversations ?? {})) unread[`dm:${id}`] = count;

      set({
        me: user,
        communities,
        conversations,
        people: buildPeople(communities, conversations),
        unread,
        reads: readsFromConversations(conversations),
        voiceRooms: (event.voice ?? {}) as Record<string, VoicePeer[]>,
        connection: 'online',
      });

      const saved = storageGet<Scope | null>('fluenta:scope', null);
      const savedValid = Boolean(
        saved &&
          (saved.kind === 'channel'
            ? communities.some((c) => c.channels.some((ch) => ch.id === saved.id))
            : conversations.some((c) => c.id === saved.id)),
      );
      const firstChannel = communities.flatMap((c) => c.channels).find((ch) => ch.type === 'text');
      if (saved && savedValid) selectScope(saved, { mobile: false });
      else if (firstChannel) selectScope({ kind: 'channel', id: firstChannel.id }, { mobile: false });
      else if (conversations[0]) selectScope({ kind: 'conversation', id: conversations[0].id }, { mobile: false });
      return;
    }

    case 'message:new': {
      const message = event.message as Message;
      if (!message) return;
      upsertMessage(message);
      const meId = state.me?.id;
      if (message.author.id !== meId) {
        const key = message.channelId ? `ch:${message.channelId}` : `dm:${message.conversationId}`;
        const isActive = state.active && scopeKey(state.active) === key;
        const conversation = message.conversationId
          ? state.conversations.find((c) => c.id === message.conversationId)
          : null;
        if ((!isActive || document.visibilityState === 'hidden') && !conversation?.muted && state.notifications) {
          const channel = message.channelId ? channelOf(message.channelId) : null;
          const title = channel ? `${message.author.displayName} · #${channel.name}` : message.author.displayName;
          void showLocalNotification(title, message.content.slice(0, 140) || 'Sent an attachment', '/');
        }
      }
      return;
    }

    case 'message:update': {
      const message = event.message as Partial<Message> & { id: string };
      if (message?.id) patchMessage(message.id, message);
      return;
    }

    case 'message:delete': {
      const id = String(event.id ?? '');
      if (id) patchMessage(id, { content: '', deletedAt: Date.now(), attachments: [], reactions: [] });
      return;
    }

    case 'reaction': {
      const messageId = String(event.messageId ?? '');
      const emoji = String(event.emoji ?? '');
      const userId = String(event.userId ?? '');
      const added = Boolean(event.added);
      const message = findMessage(messageId);
      if (!message) return;
      const current = message.reactions.find((r) => r.emoji === emoji);
      let reactions = message.reactions;
      if (added) {
        if (!current) reactions = [...message.reactions, { emoji, count: 1, me: false, users: [userId] }];
        else if (!current.users.includes(userId)) {
          reactions = message.reactions.map((r) =>
            r.emoji === emoji
              ? { ...r, count: r.count + 1, users: [...r.users, userId], me: r.me || userId === state.me?.id }
              : r,
          );
        }
      } else if (current?.users.includes(userId)) {
        reactions = message.reactions
          .map((r) =>
            r.emoji === emoji
              ? { ...r, count: r.count - 1, users: r.users.filter((u) => u !== userId), me: userId === state.me?.id ? false : r.me }
              : r,
          )
          .filter((r) => r.count > 0);
      }
      patchMessage(messageId, { reactions });
      return;
    }

    case 'typing': {
      const key = event.channelId ? `ch:${event.channelId}` : `dm:${event.conversationId}`;
      const userId = String(event.userId ?? '');
      if (!userId || userId === state.me?.id) return;
      const name = String(event.displayName ?? 'Someone');
      set((current) => {
        const existing = current.typing[key] ?? [];
        return { typing: { ...current.typing, [key]: [...existing.filter((entry) => entry.userId !== userId), { userId, name }] } };
      });
      setTimeout(() => {
        set((current) => ({
          typing: { ...current.typing, [key]: (current.typing[key] ?? []).filter((entry) => entry.userId !== userId) },
        }));
      }, 5000);
      return;
    }

    case 'read': {
      const key = event.channelId ? `ch:${event.channelId}` : `dm:${event.conversationId}`;
      const userId = String(event.userId ?? '');
      const lastReadAt = Number(event.lastReadAt ?? 0);
      if (!userId) return;
      set((current) => ({
        reads: { ...current.reads, [key]: { ...(current.reads[key] ?? {}), [userId]: lastReadAt } },
        conversations: event.conversationId
          ? current.conversations.map((c) =>
              c.id === event.conversationId
                ? { ...c, reads: { ...(c.reads ?? {}), [userId]: lastReadAt } }
                : c,
            )
          : current.conversations,
      }));
      return;
    }

    case 'presence': {
      const userId = String(event.userId ?? '');
      const presence = event.presence as Presence;
      set((current) => ({
        people: current.people[userId] ? { ...current.people, [userId]: { ...current.people[userId], presence } } : current.people,
        communities: current.communities.map((community) =>
          community.members.some((m) => m.userId === userId)
            ? {
                ...community,
                members: community.members.map((m) => (m.userId === userId ? { ...m, presence } : m)),
              }
            : community,
        ),
        conversations: current.conversations.map((conversation) =>
          conversation.members.some((m) => m.userId === userId)
            ? {
                ...conversation,
                members: conversation.members.map((m) => (m.userId === userId ? { ...m, presence } : m)),
              }
            : conversation,
        ),
      }));
      return;
    }

    case 'profile:update': {
      const user = event.user as User;
      if (!user) return;
      set((current) => ({
        me: current.me?.id === user.id ? { ...current.me, ...user } : current.me,
        people: {
          ...current.people,
          [user.id]: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            presence: user.presence,
            customStatus: user.customStatus,
          },
        },
        communities: current.communities.map((community) => ({
          ...community,
          members: community.members.map((m) =>
            m.userId === user.id
              ? { ...m, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, presence: user.presence, customStatus: user.customStatus }
              : m,
          ),
        })),
        conversations: current.conversations.map((conversation) => ({
          ...conversation,
          members: conversation.members.map((m) =>
            m.userId === user.id
              ? { ...m, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, presence: user.presence }
              : m,
          ),
        })),
      }));
      return;
    }

    case 'community:join':
    case 'community:update': {
      const community = event.community as Community;
      if (community) applyCommunity(community);
      return;
    }

    case 'community:remove': {
      const communityId = String(event.communityId ?? '');
      set((current) => ({ communities: current.communities.filter((c) => c.id !== communityId) }));
      clearActiveIfMissing();
      return;
    }

    case 'member:update': {
      const communityId = String(event.communityId ?? '');
      const member = event.member as Member | undefined;
      if (!communityId || !member) return;
      set((current) => {
        const communities = current.communities.map((community) => {
          if (community.id !== communityId) return community;
          const exists = community.members.some((m) => m.userId === member.userId);
          return {
            ...community,
            memberCount: exists ? community.memberCount : community.memberCount + 1,
            members: exists
              ? community.members.map((m) => (m.userId === member.userId ? member : m))
              : [...community.members, member],
          };
        });
        return { communities, people: buildPeople(communities, current.conversations) };
      });
      return;
    }

    case 'member:remove': {
      const communityId = String(event.communityId ?? '');
      const userId = String(event.userId ?? '');
      set((current) => ({
        communities: current.communities.map((community) =>
          community.id === communityId
            ? {
                ...community,
                memberCount: Math.max(0, community.memberCount - 1),
                members: community.members.filter((m) => m.userId !== userId),
              }
            : community,
        ),
      }));
      return;
    }

    case 'conversation:new':
    case 'conversation:update': {
      const conversation = event.conversation as Conversation;
      if (conversation) upsertConversation(conversation);
      return;
    }

    case 'conversation:remove': {
      const conversationId = String(event.conversationId ?? '');
      set((current) => ({ conversations: current.conversations.filter((c) => c.id !== conversationId) }));
      clearActiveIfMissing();
      return;
    }

    case 'voice:peers': {
      const peers = (event.peers ?? []) as VoicePeer[];
      voice.handlePeers(peers);
      return;
    }

    case 'voice:join': {
      const channelId = String(event.channelId ?? '');
      const peer = event.peer as VoicePeer | undefined;
      if (!channelId || !peer) return;
      set((current) => {
        const room = current.voiceRooms[channelId] ?? [];
        return {
          voiceRooms: {
            ...current.voiceRooms,
            [channelId]: [...room.filter((p) => p.userId !== peer.userId), peer],
          },
        };
      });
      if (peer.userId !== state.me?.id) voice.handlePeerJoined(peer.userId);
      return;
    }

    case 'voice:leave': {
      const channelId = String(event.channelId ?? '');
      const userId = String(event.userId ?? '');
      set((current) => {
        const room = (current.voiceRooms[channelId] ?? []).filter((p) => p.userId !== userId);
        return { voiceRooms: { ...current.voiceRooms, [channelId]: room } };
      });
      voice.handlePeerLeft(userId);
      return;
    }

    case 'voice:state': {
      const channelId = String(event.channelId ?? '');
      const peer = event.peer as VoicePeer | undefined;
      if (!channelId || !peer) return;
      set((current) => ({
        voiceRooms: {
          ...current.voiceRooms,
          [channelId]: (current.voiceRooms[channelId] ?? []).map((p) => (p.userId === peer.userId ? peer : p)),
        },
      }));
      return;
    }

    case 'voice:signal': {
      onVoiceSignal(event);
      return;
    }

    case 'error': {
      toast(String(event.message ?? 'Something went wrong'), 'error');
      return;
    }

    case 'rate_limited': {
      toast('You are sending events too quickly', 'error');
      return;
    }

    default:
      return;
  }
}

realtime.onEvent(handleRealtimeEvent);
realtime.onStatus((status) => set({ connection: status }));

// unread badge in the tab title
subscribe(() => {
  const total = Object.values(state.unread).reduce((sum, count) => sum + count, 0);
  const title = total > 0 ? `(${total}) Fluenta` : 'Fluenta';
  if (document.title !== title) document.title = title;
});

// Typing is throttled to one signal every 3s per client instead of a heartbeat.
let lastTypingAt = 0;
export function notifyTyping() {
  const scope = state.active;
  if (!scope) return;
  const ts = Date.now();
  if (ts - lastTypingAt < 3000) return;
  lastTypingAt = ts;
  realtime.send(
    scope.kind === 'channel'
      ? { op: 'typing', channelId: scope.id }
      : { op: 'typing', conversationId: scope.id },
  );
}
