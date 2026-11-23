// Per-client P-256 signing identity. The public key is the reconnect credential; private JWKs never
// leave the device (localStorage) and are never published. Node tests cache by client id because they
// share one process without localStorage.

import { base64ToBytes, bytesToBase64, sha256Hex } from './crypto';

export interface ClientIdentity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
}

const STORAGE_KEY = 'fable.identity';
const cache = new Map<string, Promise<ClientIdentity>>();

function storageGet(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storageSet(value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // private mode
  }
}

export function publicKeyFingerprint(publicJwk: JsonWebKey): Promise<string> {
  return sha256Hex(`${publicJwk.crv ?? ''}:${publicJwk.x ?? ''}:${publicJwk.y ?? ''}`);
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function minimalJwk(jwk: JsonWebKey, includePrivate: boolean): JsonWebKey {
  const clean: JsonWebKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  if (includePrivate && jwk.d) clean.d = jwk.d;
  return clean;
}

async function importPublic(publicJwk: JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('jwk', publicJwk, ECDSA, false, ['verify']);
  } catch {
    // WebKit can reject key_ops/ext/alg combinations exported by other engines.
    return crypto.subtle.importKey('jwk', minimalJwk(publicJwk, false), ECDSA, false, ['verify']);
  }
}

async function importPrivate(privateJwk: JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('jwk', privateJwk, ECDSA, false, ['sign']);
  } catch {
    return crypto.subtle.importKey('jwk', minimalJwk(privateJwk, true), ECDSA, false, ['sign']);
  }
}

async function fromJwks(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Promise<ClientIdentity> {
  const privateKey = await importPrivate(privateJwk);
  const publicKey = await importPublic(publicJwk);
  return { privateKey, publicKey, publicJwk, fingerprint: await publicKeyFingerprint(publicJwk) };
}

function trimInt(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const value = bytes.subarray(start);
  if (value[0] & 0x80) {
    const padded = new Uint8Array(value.length + 1);
    padded[0] = 0;
    padded.set(value, 1);
    return padded;
  }
  return value;
}

/** P1363 raw r||s -> DER, for engines that expose/accept DER ECDSA signatures. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (raw.length !== 64) return null;
  const r = trimInt(raw.subarray(0, 32));
  const s = trimInt(raw.subarray(32));
  const out = new Uint8Array(2 + 2 + r.length + 2 + s.length);
  let i = 0;
  out[i++] = 0x30;
  out[i++] = out.length - 2;
  out[i++] = 0x02;
  out[i++] = r.length;
  out.set(r, i);
  i += r.length;
  out[i++] = 0x02;
  out[i++] = s.length;
  out.set(s, i);
  return out;
}

function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  let offset = 2;
  if (der[offset] !== 0x02) return null;
  const rLength = der[offset + 1];
  offset += 2;
  const r = der.subarray(offset, offset + rLength);
  offset += rLength;
  if (der[offset] !== 0x02) return null;
  const sLength = der[offset + 1];
  offset += 2;
  const s = der.subarray(offset, offset + sLength);
  if (r.length > 33 || s.length > 33) return null;
  const out = new Uint8Array(64);
  out.set(r.subarray(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  out.set(s.subarray(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return out;
}

export async function generateIdentity(): Promise<ClientIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return fromJwks(privateJwk, publicJwk);
}

/** Global browser identity; in Node, one cached identity per logical client id. */
export function loadIdentity(clientId: string): Promise<ClientIdentity> {
  const cached = cache.get(clientId);
  if (cached) return cached;
  const promise = (async () => {
    const stored = storageGet();
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'privateJwk' in parsed &&
          'publicJwk' in parsed &&
          parsed.privateJwk &&
          typeof parsed.privateJwk === 'object' &&
          parsed.publicJwk &&
          typeof parsed.publicJwk === 'object'
        ) {
          return await fromJwks(parsed.privateJwk as JsonWebKey, parsed.publicJwk as JsonWebKey);
        }
      } catch {
        // regenerate below
      }
    }
    const identity = await generateIdentity();
    try {
      const privateJwk = await crypto.subtle.exportKey('jwk', identity.privateKey);
      storageSet(JSON.stringify({ privateJwk, publicJwk: identity.publicJwk }));
    } catch {
      // best effort
    }
    return identity;
  })();
  cache.set(clientId, promise);
  return promise;
}

export async function signData(identity: ClientIdentity, data: string): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(data)),
  );
  // WebCrypto specifies P1363 (r||s); WebKit historically has returned DER in some builds.
  const raw = signature.length === 64 ? signature : (derToRaw(signature) ?? signature);
  return bytesToBase64(raw);
}

export async function verifyData(
  publicJwk: JsonWebKey,
  signature: string,
  data: string,
): Promise<boolean> {
  try {
    const key = await importPublic(publicJwk);
    const bytes = base64ToBytes(signature);
    const candidates: Uint8Array<ArrayBuffer>[] = [bytes];
    if (bytes.length === 64) {
      const der = rawToDer(bytes);
      if (der) candidates.push(der);
    } else {
      const raw = derToRaw(bytes);
      if (raw) candidates.push(raw);
    }
    for (const candidate of candidates) {
      try {
        if (
          await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            candidate,
            new TextEncoder().encode(data),
          )
        ) {
          return true;
        }
      } catch {
        // try next encoding
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function publicJwkFromString(value: string | undefined): Promise<JsonWebKey | null> {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && 'kty' in parsed && parsed.kty === 'EC') {
      return parsed as JsonWebKey;
    }
  } catch {
    // ignore
  }
  return null;
}