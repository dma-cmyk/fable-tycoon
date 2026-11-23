import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptPayload,
  deriveRoomKey,
  encryptPayload,
  roomHash,
} from './crypto';

function randomHex(byteLength: number): string {
  let text = '';
  for (let offset = 0; offset < byteLength; offset += 32_768) {
    const chunk = crypto.getRandomValues(new Uint8Array(Math.min(32_768, byteLength - offset)));
    text += [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return text;
}

describe('encrypted relay payloads', () => {
  it('derives a stable room hash without leaking the room id', async () => {
    const hash = await roomHash('ABC234');
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
    expect(await roomHash('abc234')).toBe(hash);
    expect(await roomHash('ABC235')).not.toBe(hash);
    expect(hash).not.toContain('ABC234');
  });

  it('round-trips small payloads and hides plaintext', async () => {
    const key = await deriveRoomKey('ROOM99');
    const payload = { t: 'chat', text: '秘密の作戦: buy ミダス王' };
    const encrypted = await encryptPayload(key, payload);
    expect(encrypted.body).not.toContain('ミダス');
    expect(encrypted.body).not.toContain('秘密');
    await expect(decryptPayload(key, encrypted.body, encrypted.z)).resolves.toEqual(payload);
    const otherKey = await deriveRoomKey('ROOM98');
    await expect(decryptPayload(otherKey, encrypted.body, encrypted.z)).rejects.toBeTruthy();
  });

  it('compresses and round-trips a snapshot-sized payload', async () => {
    const key = await deriveRoomKey('BIG001');
    const state = {
      kind: 'snapshot',
      cities: Array.from({ length: 150 }, (_, index) => ({
        id: `city-${index}`,
        nameJa: `テスト都市${index}`,
        owner: index % 4,
        price: 100 + index,
      })),
      note: 'あ'.repeat(20_000),
    };
    const encrypted = await encryptPayload(key, state);
    expect(encrypted.z).toBe(true);
    await expect(decryptPayload(key, encrypted.body, encrypted.z)).resolves.toEqual(state);
  });

  it('chunk-sized incompressible data still round-trips', async () => {
    const key = await deriveRoomKey('BIG002');
    const random = randomHex(120_000);
    const encrypted = await encryptPayload(key, { text: random });
    expect(encrypted.body.length).toBeGreaterThan(60_000);
    await expect(decryptPayload(key, encrypted.body, encrypted.z)).resolves.toEqual({ text: random });
  });

  it('base64 helpers preserve binary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(5_000));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});