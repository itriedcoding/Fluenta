import type { WebSocket } from 'ws';

export type VoiceState = { muted: boolean; video: boolean; sharing: boolean };
export type VoicePeer = VoiceState & { userId: string; joinedAt: number };

type Client = {
  id: string;
  ws: WebSocket;
  userId: string;
  alive: boolean;
  voiceChannelId: string | null;
};

export class Hub {
  private byUser = new Map<string, Set<Client>>();
  private clients = new Map<WebSocket, Client>();
  private voice = new Map<string, Map<string, VoicePeer>>();
  private typing = new Map<string, Map<string, number>>();

  register(userId: string, ws: WebSocket, clientId: string): Client {
    const client: Client = { id: clientId, ws, userId, alive: true, voiceChannelId: null };
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(client);
    this.clients.set(ws, client);
    return client;
  }

  unregister(ws: WebSocket): Client | undefined {
    const client = this.clients.get(ws);
    if (!client) return undefined;
    this.clients.delete(ws);
    const set = this.byUser.get(client.userId);
    if (set) {
      set.delete(client);
      if (set.size === 0) this.byUser.delete(client.userId);
    }
    if (client.voiceChannelId) this.leaveVoice(client.voiceChannelId, client.userId);
    return client;
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  connectionCount(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  send(userId: string, payload: unknown) {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const client of set) {
      if (client.ws.readyState === 1) client.ws.send(data);
    }
  }

  sendClient(client: Client, payload: unknown) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(payload));
  }

  broadcast(userIds: Iterable<string>, payload: unknown) {
    const data = JSON.stringify(payload);
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      const set = this.byUser.get(userId);
      if (!set) continue;
      for (const client of set) {
        if (client.ws.readyState === 1) client.ws.send(data);
      }
    }
  }

  /** Relay a client-supplied event to other members, dropping backpressure-heavy sockets. */
  broadcastRaw(userIds: Iterable<string>, payload: string, exceptUserId?: string) {
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (userId === exceptUserId || seen.has(userId)) continue;
      seen.add(userId);
      const set = this.byUser.get(userId);
      if (!set) continue;
      for (const client of set) {
        if (client.ws.readyState === 1) client.ws.send(payload);
      }
    }
  }

  heartbeat() {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
  }

  markAlive(ws: WebSocket) {
    const client = this.clients.get(ws);
    if (client) client.alive = true;
  }

  // ---- typing -------------------------------------------------------------
  markTyping(scope: string, userId: string) {
    let map = this.typing.get(scope);
    if (!map) {
      map = new Map();
      this.typing.set(scope, map);
    }
    map.set(userId, Date.now());
  }

  // ---- voice --------------------------------------------------------------
  joinVoice(client: Client, channelId: string, state: VoiceState): VoicePeer[] {
    let room = this.voice.get(channelId);
    if (!room) {
      room = new Map();
      this.voice.set(channelId, room);
    }
    const peer: VoicePeer = { userId: client.userId, joinedAt: Date.now(), ...state };
    room.set(client.userId, peer);
    client.voiceChannelId = channelId;
    return [...room.values()];
  }

  leaveVoice(channelId: string, userId: string): boolean {
    const room = this.voice.get(channelId);
    if (!room) return false;
    const existed = room.delete(userId);
    if (room.size === 0) this.voice.delete(channelId);
    for (const client of this.clients.values()) {
      if (client.userId === userId && client.voiceChannelId === channelId) client.voiceChannelId = null;
    }
    return existed;
  }

  updateVoice(channelId: string, userId: string, state: VoiceState): VoicePeer | null {
    const room = this.voice.get(channelId);
    const peer = room?.get(userId);
    if (!peer) return null;
    peer.muted = state.muted;
    peer.video = state.video;
    peer.sharing = state.sharing;
    return peer;
  }

  voicePeers(channelId: string): VoicePeer[] {
    return [...(this.voice.get(channelId)?.values() ?? [])];
  }

  voiceChannelOf(userId: string): string | null {
    for (const [channelId, room] of this.voice) {
      if (room.has(userId)) return channelId;
    }
    return null;
  }

  /** All voice rooms, used to hydrate the initial client state. */
  allVoiceRooms(): Record<string, VoicePeer[]> {
    const out: Record<string, VoicePeer[]> = {};
    for (const [channelId, room] of this.voice) out[channelId] = [...room.values()];
    return out;
  }
}

export const hub = new Hub();
