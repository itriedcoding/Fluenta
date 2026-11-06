import { realtime } from './realtime';

/**
 * Mesh WebRTC voice/video/screen-share engine.
 *
 * - The peer that is already in the room answers; the joiner offers.
 * - Audio and video use pre-negotiated transceivers, so toggling camera or
 *   swapping to a screen share needs no renegotiation at all.
 */

export type VoiceSnapshot = {
  joined: boolean;
  channelId: string | null;
  connecting: boolean;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  localStream: MediaStream | null;
  participants: Record<string, MediaStream>;
  error: string | null;
};

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function iceServers(): RTCIceServer[] {
  const custom = (window as unknown as { __FLUENTA_ICE__?: RTCIceServer[] }).__FLUENTA_ICE__;
  return custom && custom.length > 0 ? custom : DEFAULT_ICE;
}

type Peer = {
  pc: RTCPeerConnection;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender;
  audioEl: HTMLAudioElement | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteReady: boolean;
};

class VoiceManager {
  snapshot: VoiceSnapshot = {
    joined: false,
    channelId: null,
    connecting: false,
    muted: false,
    deafened: false,
    camera: false,
    sharing: false,
    localStream: null,
    participants: {},
    error: null,
  };

  onUpdate: ((snapshot: VoiceSnapshot) => void) | null = null;

  private peers = new Map<string, Peer>();
  private screenStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private starting = false;
  private preferred: { audio?: string; video?: string } = {};

  /** Persists the microphone/camera choice made in Settings. */
  setPreferredDevice(kind: 'audio' | 'video', deviceId: string | null) {
    if (kind === 'audio') this.preferred.audio = deviceId ?? undefined;
    else this.preferred.video = deviceId ?? undefined;
  }

  get localStream() {
    return this.snapshot.localStream;
  }

  get inCall() {
    return this.snapshot.joined;
  }

  private emit(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.(this.snapshot);
  }

  private send(payload: Record<string, unknown>) {
    realtime.send(payload);
  }

  async join(channelId: string, options: { video?: boolean } = {}) {
    if (this.starting) return;
    if (this.snapshot.channelId === channelId && this.snapshot.joined) return;
    this.starting = true;
    if (this.snapshot.joined) this.leave(true);

    this.emit({ connecting: true, error: null, channelId, camera: Boolean(options.video) });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(this.preferred.audio ? { deviceId: { exact: this.preferred.audio } } : {}),
        },
        video: options.video
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
              ...(this.preferred.video ? { deviceId: { exact: this.preferred.video } } : {}),
            }
          : false,
      });
    } catch (err) {
      const message =
        (err as DOMException)?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser settings.'
          : 'Could not access your microphone or camera.';
      this.emit({ connecting: false, error: message, channelId: null, joined: false });
      this.starting = false;
      return;
    }

    this.cameraTrack = stream.getVideoTracks()[0] ?? null;
    this.emit({
      localStream: stream,
      joined: true,
      connecting: false,
      muted: false,
      camera: Boolean(this.cameraTrack),
    });

    this.send({ op: 'voice:join', channelId, muted: false, video: Boolean(this.cameraTrack), sharing: false });
    this.starting = false;
  }

  leave(silent = false) {
    const channelId = this.snapshot.channelId;
    if (this.snapshot.joined && channelId && !silent) this.send({ op: 'voice:leave' });
    for (const peer of this.peers.values()) this.destroyPeer(peer);
    this.peers.clear();
    this.stopScreen();
    this.snapshot.localStream?.getTracks().forEach((track) => track.stop());
    this.emit({
      joined: false,
      connecting: false,
      channelId: null,
      muted: false,
      camera: false,
      sharing: false,
      localStream: null,
      participants: {},
      error: null,
    });
  }

  toggleMute() {
    const next = !this.snapshot.muted;
    this.snapshot.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    this.emit({ muted: next });
    this.broadcastState({ muted: next });
  }

  toggleDeafen() {
    const next = !this.snapshot.deafened;
    for (const peer of this.peers.values()) {
      if (peer.audioEl) peer.audioEl.muted = next;
    }
    this.emit({ deafened: next });
  }

  async toggleCamera() {
    if (!this.snapshot.joined) return;
    if (this.snapshot.camera) {
      this.cameraTrack?.stop();
      this.cameraTrack = null;
      for (const peer of this.peers.values()) void peer.videoSender.replaceTrack(null);
      this.emit({ camera: false });
      this.broadcastState({ video: false });
      return;
    }
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...(this.preferred.video ? { deviceId: { exact: this.preferred.video } } : {}),
        },
      });
      const track = cam.getVideoTracks()[0];
      this.cameraTrack = track;
      this.snapshot.localStream?.addTrack(track);
      for (const peer of this.peers.values()) void peer.videoSender.replaceTrack(track);
      this.emit({ camera: true });
      this.broadcastState({ video: true });
    } catch {
      this.emit({ error: 'Camera access was blocked.' });
    }
  }

  async toggleShare() {
    if (!this.snapshot.joined) return;
    if (this.snapshot.sharing) {
      this.stopScreen();
      this.emit({ sharing: false });
      this.broadcastState({ sharing: false });
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
      });
      const track = display.getVideoTracks()[0];
      this.screenStream = display;
      track.onended = () => {
        this.stopScreen();
        this.emit({ sharing: false });
        this.broadcastState({ sharing: false });
      };
      for (const peer of this.peers.values()) void peer.videoSender.replaceTrack(track);
      this.emit({ sharing: true });
      this.broadcastState({ sharing: true });
    } catch {
      /* user cancelled the picker */
    }
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  private stopScreen() {
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    // restore camera view for every peer when the share ends
    for (const peer of this.peers.values()) void peer.videoSender.replaceTrack(this.cameraTrack);
  }

  private broadcastState(patch: { muted?: boolean; video?: boolean; sharing?: boolean }) {
    this.send({
      op: 'voice:state',
      muted: patch.muted ?? this.snapshot.muted,
      video: patch.video ?? this.snapshot.camera,
      sharing: patch.sharing ?? this.snapshot.sharing,
    });
  }

  private createPeer(userId: string, initiator: boolean): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    const audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    const videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;

    const localAudio = this.snapshot.localStream?.getAudioTracks()[0];
    if (localAudio) void audioSender.replaceTrack(localAudio);
    const outboundVideo = this.screenStream?.getVideoTracks()[0] ?? this.cameraTrack;
    if (outboundVideo) void videoSender.replaceTrack(outboundVideo);

    const peer: Peer = {
      pc,
      audioSender,
      videoSender,
      audioEl: null,
      pendingCandidates: [],
      remoteReady: false,
    };
    this.peers.set(userId, peer);

    const remote = new MediaStream();

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({
          op: 'voice:signal',
          targetUserId: userId,
          data: { kind: 'candidate', candidate: event.candidate.toJSON() },
        });
      }
    };

    pc.ontrack = (event) => {
      remote.addTrack(event.track);
      if (event.track.kind === 'audio') {
        if (!peer.audioEl) {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.dataset.peer = userId;
          document.body.appendChild(audio);
          peer.audioEl = audio;
        }
        peer.audioEl.srcObject = remote;
        peer.audioEl.muted = this.snapshot.deafened;
        void peer.audioEl.play().catch(() => {});
      }
      this.emit({ participants: { ...this.snapshot.participants, [userId]: remote } });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        void pc.restartIce?.();
      }
      if (pc.connectionState === 'closed') this.removePeer(userId);
    };

    if (initiator) {
      void (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ op: 'voice:signal', targetUserId: userId, data: { kind: 'offer', sdp: pc.localDescription } });
      })();
    }

    return peer;
  }

  /** Called for every peer already in the room when we join. */
  handlePeers(peers: { userId: string }[]) {
    for (const peer of peers) {
      if (peer.userId === this.snapshot.channelId) continue;
      this.createPeer(peer.userId, true);
    }
  }

  /** Someone else joined after us: wait for their offer. */
  handlePeerJoined(userId: string) {
    if (!this.snapshot.joined) return;
    this.createPeer(userId, false);
  }

  handlePeerLeft(userId: string) {
    this.removePeer(userId);
  }

  async handleSignal(fromUserId: string, data: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (!this.snapshot.joined) return;
    let peer = this.peers.get(fromUserId);
    if (data.kind === 'offer') {
      if (!peer) peer = this.createPeer(fromUserId, false);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp!));
      peer.remoteReady = true;
      for (const candidate of peer.pendingCandidates) {
        await peer.pc.addIceCandidate(candidate).catch(() => {});
      }
      peer.pendingCandidates = [];
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.send({
        op: 'voice:signal',
        targetUserId: fromUserId,
        data: { kind: 'answer', sdp: peer.pc.localDescription },
      });
      return;
    }
    if (!peer) return;
    if (data.kind === 'answer') {
      if (peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp!));
      peer.remoteReady = true;
      for (const candidate of peer.pendingCandidates) {
        await peer.pc.addIceCandidate(candidate).catch(() => {});
      }
      peer.pendingCandidates = [];
      return;
    }
    if (data.kind === 'candidate' && data.candidate) {
      if (peer.remoteReady) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingCandidates.push(data.candidate);
    }
  }

  private removePeer(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.destroyPeer(peer);
    this.peers.delete(userId);
    const participants = { ...this.snapshot.participants };
    delete participants[userId];
    this.emit({ participants });
  }

  private destroyPeer(peer: Peer) {
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.close();
    } catch {
      /* already closed */
    }
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
  }
}

export const voice = new VoiceManager();
