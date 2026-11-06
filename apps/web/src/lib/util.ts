import type { Message, Person, Scope } from './types';


export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 45% 42%)`;
}

export function scopeKey(scope: Scope): string {
  return `${scope.kind === 'channel' ? 'ch' : 'dm'}:${scope.id}`;
}

export function messageScopeKey(message: Message): string {
  return message.channelId ? `ch:${message.channelId}` : `dm:${message.conversationId}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? formatTime(timestamp) : `${formatDay(timestamp)} ${formatTime(timestamp)}`;
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function personName(person: Pick<Person, 'displayName'> | undefined, fallback = 'Unknown'): string {
  return person?.displayName || fallback;
}

export function conversationTitle(
  conversation: { type: string; name: string | null; members: { userId: string; displayName: string }[] },
  meId: string,
): string {
  if (conversation.name) return conversation.name;
  const others = conversation.members.filter((m) => m.userId !== meId);
  if (conversation.type === 'dm') return others[0]?.displayName ?? 'Direct message';
  return others.map((m) => m.displayName).join(', ') || 'Group';
}

const MENTION = /@([a-zA-Z0-9._-]{3,24})/g;

/** Splits message text into tokens for safe rich rendering (no HTML injection). */
export type RichToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'strike'; value: string }
  | { kind: 'link'; value: string; href: string }
  | { kind: 'emoji'; value: string }
  | { kind: 'mention'; value: string; username: string }
  | { kind: 'everyone'; value: string };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(https?:\/\/[^\s<]+)|(:[a-z0-9_+-]{2,32}:)/gi;

export function tokenize(text: string): RichToken[] {
  const tokens: RichToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push(...plain(text.slice(lastIndex, index)));
    const [raw] = match;
    if (raw.startsWith('`')) tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    else if (raw.startsWith('**')) tokens.push({ kind: 'bold', value: raw.slice(2, -2) });
    else if (raw.startsWith('~~')) tokens.push({ kind: 'strike', value: raw.slice(2, -2) });
    else if (raw.startsWith('*')) tokens.push({ kind: 'italic', value: raw.slice(1, -1) });
    else if (raw.startsWith('http')) tokens.push({ kind: 'link', value: raw, href: raw });
    else if (raw.startsWith(':')) tokens.push({ kind: 'emoji', value: raw });
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) tokens.push(...plain(text.slice(lastIndex)));
  return tokens;
}

function plain(segment: string): RichToken[] {
  const out: RichToken[] = [];
  let last = 0;
  for (const match of segment.matchAll(MENTION)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: 'text', value: segment.slice(last, index) });
    const username = match[1];
    out.push(
      username.toLowerCase() === 'everyone' || username.toLowerCase() === 'here'
        ? { kind: 'everyone', value: match[0] }
        : { kind: 'mention', value: match[0], username },
    );
    last = index + match[0].length;
  }
  if (last < segment.length) out.push({ kind: 'text', value: segment.slice(last) });
  return out;
}

export const EMOJI = [
  '👍', '🔥', '❤️', '😂', '🎉', '😮', '😢', '🙌', '👀', '✅', '💯', '🚀',
  '😀', '😅', '😍', '🤔', '😎', '🥳', '😴', '🤝', '💡', '⚠️', '👎', '🙏',
];

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}
