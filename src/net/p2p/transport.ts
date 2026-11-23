// Serverless peer transport: encrypted MQTT over WSS with a per-peer WebRTC DataChannel upgrade.
//
// MQTT carries everything through public brokers (fallback chain). Every payload is AES-GCM
// encrypted with a key derived from the room id, so a wildcard subscriber cannot read state/chat.
// When two peers can reach each other directly, targeted messages switch to an ordered DataChannel
// and fall back to MQTT if it closes.

import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { ClientMsg, LobbyView, ServerMsg } from '../protocol';
import { decryptPayload, deriveRoomKey, encryptPayload, roomHash } from './crypto';

export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
] as const;

const TOPIC_PREFIX = 'fable-tycoon-v1';
const MAX_PAYLOAD_CHARS = 60_000;
const CHUNK_CHARS = 48_000;
const DEDUP_LIMIT = 256;
const PART_TIMEOUT_MS = 15_000;

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

export type TransportStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Non-gameplay messages that ride the same encrypted relay as ClientMsg / ServerMsg. */
export type P2PControl =
  | {
      k: 'hb';
      hostPeerId: string;
      seat: number | null;
      hostSeat: number | null;
      seatTokens: Record<string, string>;
      lobby: LobbyView;
      seq: number;
      at: number;
    }
  | {
      k: 'host';
      hostPeerId: string;
      seat: number | null;
      hostSeat: number | null;
      seatTokens: Record<string, string>;
      lobby: LobbyView;
      seq: number;
      at: number;
    }
  | { k: 'presence'; peerId: string; seat: number | null; at: number }
  | { k: 'probe'; at: number }
  | { k: 'probeAck'; at: number }
  | { k: 'resync' }
  | { k: 'bye' };

export type P2PMessage = ClientMsg | ServerMsg | P2PControl;

export function isP2PControl(message: P2PMessage): message is P2PControl {
  return 'k' in message;
}

interface WireEnvelope {
  f: string;
  id: string;
  body: string;
  z?: boolean;
  p?: number;
  n?: number;
}

type RtcSignal =
  | { k: 'rtc'; kind: 'offer' | 'answer'; sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { k: 'rtc'; kind: 'ice'; candidate: RTCIceCandidateInit };

type WirePayload = { k: 'app'; msg: P2PMessage } | RtcSignal;

interface PeerState {
  lastSeen: number;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  dcOpen: boolean;
  offerSent: boolean;
  remoteSet: boolean;
  candidates: RTCIceCandidateInit[];
}

interface InboundParts {
  from: string;
  z: boolean;
  n: number;
  parts: Map<number, string>;
  timer: ReturnType<typeof setTimeout>;
}

export interface MqttTransportOptions {
  brokers?: readonly string[];
  /** Node tests set this: RTCPeerConnection does not exist in Node anyway, but explicit is clearer. */
  disableWebRtc?: boolean;
  connectTimeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface P2PTransport {
  readonly peerId: string;
  connect(roomId: string): Promise<void>;
  send(peerId: string, message: P2PMessage): Promise<void>;
  broadcast(message: P2PMessage): Promise<void>;
  onMessage(listener: (from: string, message: P2PMessage) => void): () => void;
  onStatus(listener: (status: TransportStatus) => void): () => void;
  status(): TransportStatus;
  broker(): string | null;
  p2pPeers(): number;
  relayPeers(): number;
  close(): Promise<void>;
}

function randomToken(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function isEnvelope(value: unknown): value is WireEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    'f' in value &&
    typeof value.f === 'string' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'body' in value &&
    typeof value.body === 'string'
  );
}

function isWirePayload(value: unknown): value is WirePayload {
  if (!value || typeof value !== 'object' || !('k' in value)) return false;
  if (value.k === 'app') {
    return 'msg' in value && !!value.msg && typeof value.msg === 'object';
  }
  return value.k === 'rtc';
}

function isP2PMessage(value: unknown): value is P2PMessage {
  if (!value || typeof value !== 'object') return false;
  if ('t' in value && typeof value.t === 'string') return true;
  return 'k' in value && typeof value.k === 'string';
}

export class MqttTransport implements P2PTransport {
  readonly peerId: string;
  private readonly options: MqttTransportOptions;
  private readonly log: (message: string, detail?: unknown) => void;
  private client: MqttClient | null = null;
  private brokerUrl: string | null = null;
  private root = '';
  private roomTopic = '';
  private inboxTopic = '';
  private key: CryptoKey | null = null;
  private connectionStatus: TransportStatus = 'connecting';
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private messageListeners = new Set<(from: string, message: P2PMessage) => void>();
  private peers = new Map<string, PeerState>();
  private parts = new Map<string, InboundParts>();
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private counter = 0;
  private outbox: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(peerId: string, options: MqttTransportOptions = {}) {
    this.peerId = peerId;
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  status(): TransportStatus {
    return this.connectionStatus;
  }

  broker(): string | null {
    return this.brokerUrl;
  }

  p2pPeers(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.dcOpen) count += 1;
    return count;
  }

  relayPeers(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (!peer.dcOpen) count += 1;
    return count;
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onMessage(listener: (from: string, message: P2PMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  async connect(roomId: string): Promise<void> {
    if (this.closed) throw new Error('transport is closed');
    this.root = `${TOPIC_PREFIX}/${await roomHash(roomId)}`;
    this.roomTopic = `${this.root}/room`;
    this.inboxTopic = `${this.root}/${this.peerId}`;
    this.key = await deriveRoomKey(roomId);

    const brokers = this.options.brokers ?? DEFAULT_BROKERS;
    let lastError: unknown = null;
    for (const broker of brokers) {
      try {
        const client = await this.openClient(broker);
        if (this.closed) {
          client.end(true);
          throw new Error('transport closed during connect');
        }
        this.client = client;
        this.brokerUrl = broker;
        this.attachClient(client);
        await this.subscribe(client);
        this.setStatus('open');
        this.log(`connected to ${broker} as ${this.peerId}`);
        return;
      } catch (error) {
        lastError = error;
        this.log(`broker failed: ${broker}`, error);
      }
    }
    this.setStatus('closed');
    throw lastError instanceof Error ? lastError : new Error('all MQTT brokers unreachable');
  }

  private openClient(broker: string): Promise<MqttClient> {
    const { promise, resolve: done, reject: fail } = Promise.withResolvers<MqttClient>();
    const timeoutMs = this.options.connectTimeoutMs ?? 5_000;
    let settled = false;
    const client = mqtt.connect(broker, {
      clientId: `fable_${randomToken(12)}`,
      clean: true,
      connectTimeout: timeoutMs,
      keepalive: 25,
      reconnectPeriod: 2_500,
      protocolVersion: 4,
    });
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('connect', onConnect);
      client.off('error', onError);
      if (error) {
        try {
          client.end(true);
        } catch {
          // ignore
        }
        fail(error);
      } else {
        done(client);
      }
    };
    const onConnect = (): void => finish(null);
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => finish(new Error('broker connect timeout')), timeoutMs + 500);
    client.once('connect', onConnect);
    client.once('error', onError);
    return promise;
  }

  private attachClient(client: MqttClient): void {
    client.on('message', (_topic: string, payload: Uint8Array) => {
      this.handleWire(payload.toString());
    });
    client.on('close', () => {
      if (this.closed) return;
      this.setStatus('reconnecting');
    });
    client.on('offline', () => {
      if (!this.closed) this.setStatus('reconnecting');
    });
    client.on('connect', () => {
      if (this.closed) return;
      void this.subscribe(client).then(() => this.setStatus('open'));
    });
    client.on('error', (error: Error) => this.log('mqtt error', error));
  }

  private subscribe(client: MqttClient): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.key) {
        reject(new Error('transport not initialised'));
        return;
      }
      client.subscribe([this.roomTopic, this.inboxTopic], { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private setStatus(status: TransportStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  send(peerId: string, message: P2PMessage): Promise<void> {
    this.touch(peerId);
    this.maybeOffer(peerId);
    return this.enqueue(async () => {
      const chunks = await this.encode({ k: 'app', msg: message });
      const peer = this.peers.get(peerId);
      if (peer?.dcOpen && peer.dc && peer.dc.readyState === 'open') {
        this.sendChunks(peerId, chunks, peer.dc);
        return;
      }
      this.publishChunks(this.topicFor(peerId), chunks);
    });
  }

  broadcast(message: P2PMessage): Promise<void> {
    return this.enqueue(async () => {
      const chunks = await this.encode({ k: 'app', msg: message });
      this.publishChunks(this.roomTopic, chunks);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.outbox.then(task).catch((error) => {
      this.log('outbound message failed', error);
    });
    this.outbox = next;
    return next;
  }

  private topicFor(peerId: string): string {
    return `${this.root}/${peerId}`;
  }

  private async encode(payload: WirePayload): Promise<WireEnvelope[]> {
    if (!this.key) throw new Error('transport is not connected');
    const encrypted = await encryptPayload(this.key, payload);
    this.counter += 1;
    const id = `${this.peerId.slice(0, 8)}-${Date.now().toString(36)}-${this.counter}`;
    if (encrypted.body.length <= MAX_PAYLOAD_CHARS) {
      return [{ f: this.peerId, id, body: encrypted.body, ...(encrypted.z ? { z: true } : {}) }];
    }
    const chunks: WireEnvelope[] = [];
    const total = Math.ceil(encrypted.body.length / CHUNK_CHARS);
    for (let i = 0; i < total; i += 1) {
      chunks.push({
        f: this.peerId,
        id,
        body: encrypted.body.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
        p: i,
        n: total,
        ...(encrypted.z ? { z: true } : {}),
      });
    }
    return chunks;
  }

  private publishChunks(topic: string, chunks: WireEnvelope[]): void {
    const client = this.client;
    if (!client || !client.connected) return;
    for (const chunk of chunks) {
      client.publish(topic, JSON.stringify(chunk), { qos: 1 });
    }
  }

  private sendChunks(peerId: string, chunks: WireEnvelope[], dc: RTCDataChannel): void {
    if (dc.bufferedAmount > 256 * 1024) {
      this.publishChunks(this.topicFor(peerId), chunks);
      return;
    }
    try {
      for (const chunk of chunks) dc.send(JSON.stringify(chunk));
    } catch (error) {
      this.log('data channel send failed; falling back to relay', error);
      this.publishChunks(this.topicFor(peerId), chunks);
    }
  }

  private handleWire(raw: string): void {
    let envelope: WireEnvelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelope(parsed)) return;
      envelope = parsed;
    } catch {
      return;
    }
    if (envelope.f === this.peerId) return;
    this.touch(envelope.f);

    if (typeof envelope.n === 'number' && envelope.n > 1) {
      const existing = this.parts.get(envelope.id);
      const entry =
        existing ??
        ({
          from: envelope.f,
          z: envelope.z === true,
          n: envelope.n,
          parts: new Map<number, string>(),
          timer: setTimeout(() => this.parts.delete(envelope.id), PART_TIMEOUT_MS),
        } satisfies InboundParts);
      if (!existing) this.parts.set(envelope.id, entry);
      if (typeof envelope.p === 'number') entry.parts.set(envelope.p, envelope.body);
      if (entry.parts.size < entry.n) return;
      clearTimeout(entry.timer);
      this.parts.delete(envelope.id);
      const body: string[] = [];
      for (let i = 0; i < entry.n; i += 1) {
        const part = entry.parts.get(i);
        if (part === undefined) return;
        body.push(part);
      }
      void this.queueDispatch(envelope.f, envelope.id, body.join(''), entry.z);
      return;
    }
    void this.queueDispatch(envelope.f, envelope.id, envelope.body, envelope.z === true);
  }

  private queueDispatch(from: string, id: string, body: string, compressed: boolean): Promise<void> {
    const next = this.inbound
      .then(() => this.decodeAndDispatch(from, id, body, compressed))
      .catch((error) => this.log('inbound message failed', error));
    this.inbound = next;
    return next;
  }

  private async decodeAndDispatch(
    from: string,
    id: string,
    body: string,
    compressed: boolean,
  ): Promise<void> {
    if (this.seenIds.has(id)) return;
    this.remember(id);
    if (!this.key) return;
    let decoded: unknown;
    try {
      decoded = await decryptPayload(this.key, body, compressed);
    } catch (error) {
      this.log('could not decrypt envelope', error);
      return;
    }
    if (!isWirePayload(decoded)) return;
    if (decoded.k === 'rtc') {
      await this.handleSignal(from, decoded);
      return;
    }
    if (!isP2PMessage(decoded.msg)) return;
    this.touch(from);
    this.maybeOffer(from);
    for (const listener of this.messageListeners) listener(from, decoded.msg);
  }

  private remember(id: string): void {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > DEDUP_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenIds.delete(oldest);
    }
  }

  private touch(peerId: string): PeerState {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        lastSeen: Date.now(),
        pc: null,
        dc: null,
        dcOpen: false,
        offerSent: false,
        remoteSet: false,
        candidates: [],
      };
      this.peers.set(peerId, peer);
    }
    peer.lastSeen = Date.now();
    return peer;
  }

  // ---------------------------------------------------------------- WebRTC

  private rtcAvailable(): boolean {
    return this.options.disableWebRtc !== true && typeof RTCPeerConnection === 'function';
  }

  private maybeOffer(peerId: string): void {
    if (!this.rtcAvailable() || this.peerId >= peerId) return;
    const peer = this.touch(peerId);
    if (peer.pc || peer.offerSent) return;
    peer.offerSent = true;
    void this.createOffer(peerId);
  }

  private createPeer(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = this.touch(peerId);
    peer.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) void this.sendSignal(peerId, { k: 'rtc', kind: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.teardownPc(peerId);
    };
    return pc;
  }

  private async createOffer(peerId: string): Promise<void> {
    try {
      const pc = this.createPeer(peerId);
      const dc = pc.createDataChannel('fable-tycoon', { ordered: true });
      this.attachDataChannel(peerId, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(peerId, {
        k: 'rtc',
        kind: 'offer',
        sdp: { type: 'offer', sdp: pc.localDescription?.sdp ?? '' },
      });
    } catch (error) {
      this.log('webrtc offer failed', error);
      this.teardownPc(peerId);
    }
  }

  private async sendSignal(peerId: string, signal: RtcSignal): Promise<void> {
    // Signaling always rides MQTT; the DataChannel does not exist yet (or is falling back).
    await this.enqueue(async () => {
      const chunks = await this.encode(signal);
      this.publishChunks(this.topicFor(peerId), chunks);
    });
  }

  private async handleSignal(from: string, signal: RtcSignal): Promise<void> {
    if (!this.rtcAvailable()) return;
    const peer = this.touch(from);
    try {
      if (signal.kind === 'offer') {
        this.teardownPc(from);
        const fresh = this.touch(from);
        const pc = this.createPeer(from);
        pc.ondatachannel = (event) => {
          if (event.channel) this.attachDataChannel(from, event.channel);
        };
        await pc.setRemoteDescription(signal.sdp);
        fresh.remoteSet = true;
        for (const candidate of fresh.candidates.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(from, {
          k: 'rtc',
          kind: 'answer',
          sdp: { type: 'answer', sdp: pc.localDescription?.sdp ?? '' },
        });
        return;
      }
      if (signal.kind === 'answer') {
        if (!peer.pc) return;
        await peer.pc.setRemoteDescription(signal.sdp);
        peer.remoteSet = true;
        for (const candidate of peer.candidates.splice(0)) {
          await peer.pc.addIceCandidate(candidate).catch(() => {});
        }
        return;
      }
      if (signal.kind === 'ice') {
        if (!peer.pc || !peer.remoteSet) {
          peer.candidates.push(signal.candidate);
          return;
        }
        await peer.pc.addIceCandidate(signal.candidate).catch(() => {});
      }
    } catch (error) {
      this.log('webrtc signaling failed', error);
      this.teardownPc(from);
    }
  }

  private attachDataChannel(peerId: string, dc: RTCDataChannel): void {
    const peer = this.touch(peerId);
    peer.dc = dc;
    dc.onopen = () => {
      peer.dcOpen = true;
      this.log(`p2p channel open: ${peerId}`);
    };
    dc.onclose = () => {
      if (peer.dc === dc) {
        peer.dcOpen = false;
        peer.dc = null;
      }
    };
    dc.onerror = () => {
      if (peer.dc === dc) {
        peer.dcOpen = false;
      }
    };
    dc.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') this.handleWire(event.data);
    };
  }

  private teardownPc(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      peer.dc?.close();
    } catch {
      // ignore
    }
    try {
      peer.pc?.close();
    } catch {
      // ignore
    }
    peer.dc = null;
    peer.pc = null;
    peer.dcOpen = false;
    peer.offerSent = false;
    peer.remoteSet = false;
    peer.candidates = [];
  }

  // ---------------------------------------------------------------- teardown

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.parts.values()) clearTimeout(entry.timer);
    this.parts.clear();
    for (const peerId of [...this.peers.keys()]) this.teardownPc(peerId);
    this.peers.clear();
    this.messageListeners.clear();
    this.statusListeners.clear();
    const client = this.client;
    this.client = null;
    this.setStatus('closed');
    if (client) {
      const { promise, resolve } = Promise.withResolvers<void>();
      client.end(false, {}, () => resolve());
      setTimeout(resolve, 500);
      await promise;
    }
  }
}