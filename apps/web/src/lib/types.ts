export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type PresenceChoice = 'online' | 'idle' | 'dnd' | 'invisible';

export type User = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  customStatus: string | null;
  presence: Presence;
  createdAt: number;
  email?: string;
};

export type Person = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  presence: Presence;
  customStatus?: string | null;
};

export type Member = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  customStatus: string | null;
  presence: Presence;
  nickname: string | null;
  roles: string[];
  joinedAt: number;
};

export type Role = {
  id: string;
  name: string;
  color: string;
  permissions: number;
  position: number;
  isDefault: boolean;
};

export type Channel = {
  id: string;
  communityId: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  isPrivate: boolean;
  slowmode: number;
  createdAt: number;
};

export type Community = {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  ownerId: string;
  inviteCode: string;
  createdAt: number;
  memberCount: number;
  myPermissions: number;
  roles: Role[];
  members: Member[];
  channels: Channel[];
};

export type Conversation = {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  iconUrl: string | null;
  ownerId: string;
  createdAt: number;
  members: Member[];
  lastMessage: { id: string; content: string; authorId: string; createdAt: number } | null;
  unread: number;
  reads: Record<string, number>;
  muted: boolean;
};

export type Attachment = {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  isImage: boolean;
};

export type Reaction = { emoji: string; count: number; me: boolean; users: string[] };

export type Message = {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  author: { id: string; username: string; displayName: string; avatarUrl: string | null };
  content: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: { id: string; content: string; author: { id: string; username: string; displayName: string } } | null;
  attachments: Attachment[];
  reactions: Reaction[];
  readBy?: string[];
  nonce?: string;
  pending?: boolean;
  failed?: boolean;
};

export type VoicePeer = {
  userId: string;
  muted: boolean;
  video: boolean;
  sharing: boolean;
  joinedAt: number;
};

export type Scope = { kind: 'channel' | 'conversation'; id: string };

export type Toast = { id: string; message: string; kind: 'info' | 'error' | 'success' };

export type SessionInfo = {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
};

export type SearchResults = {
  messages: (Message & {
    snippet: string;
    context: { type: 'channel'; channelId: string; channelName: string; communityId: string; communityName: string };
  })[];
  users: User[];
  channels: { id: string; name: string; communityId: string; communityName: string }[];
  communities: { id: string; name: string; iconUrl: string | null; description: string }[];
  conversations: { id: string; name: string; type: string }[];
};
