// End-to-end encryption for the public-MQTT relay.
//
// The room id is the only shared secret. PBKDF2 (100k, SHA-256) derives an AES-GCM key; every
// envelope body is encrypted with a fresh 96-bit IV. Public broker wildcard subscribers therefore
// see only opaque base64. Large snapshots are gzip-compressed before encryption.

const SALT_TEXT = 'fable-tycoon-v1';
const PBKDF2_ITERATIONS = 100_000;
const COMPRESS_THRESHOLD = 2_048;

const keyCache = new Map<string, Promise<CryptoKey>>();

type FreshBytes = Uint8Array<ArrayBuffer>;

function copyBytes(bytes: Uint8Array): FreshBytes {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function normalizeRoom(roomId: string): string {
  return roomId.trim().toUpperCase();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function roomHash(roomId: string): Promise<string> {
  return (await sha256Hex(normalizeRoom(roomId))).slice(0, 24);
}

export function deriveRoomKey(roomId: string): Promise<CryptoKey> {
  const normalized = normalizeRoom(roomId);
  const cached = keyCache.get(normalized);
  if (cached) return cached;
  const promise = (async () => {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(normalized),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(SALT_TEXT),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  keyCache.set(normalized, promise);
  return promise;
}

async function gzip(bytes: Uint8Array): Promise<FreshBytes | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([copyBytes(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function gunzip(bytes: Uint8Array): Promise<FreshBytes> {
  const stream = new Blob([copyBytes(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface EncryptedPayload {
  /** base64 of iv(12) + AES-GCM ciphertext */
  body: string;
  /** body was gzip-compressed before encryption */
  z: boolean;
}

export async function encryptPayload(key: CryptoKey, payload: unknown): Promise<EncryptedPayload> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  let plain: FreshBytes = copyBytes(encoded);
  let compressed = false;
  if (encoded.length >= COMPRESS_THRESHOLD) {
    const packed = await gzip(encoded);
    if (packed && packed.length < encoded.length) {
      plain = packed;
      compressed = true;
    }
  }
  const iv = copyBytes(crypto.getRandomValues(new Uint8Array(12)));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain),
  );
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  return { body: bytesToBase64(combined), z: compressed };
}

export async function decryptPayload(
  key: CryptoKey,
  body: string,
  compressed: boolean,
): Promise<unknown> {
  const combined = base64ToBytes(body);
  if (combined.length < 13) throw new Error('encrypted payload is too short');
  const iv = copyBytes(combined.subarray(0, 12));
  const cipher = copyBytes(combined.subarray(12));
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
  const decoded = compressed ? await gunzip(plain) : plain;
  return JSON.parse(new TextDecoder().decode(decoded));
}