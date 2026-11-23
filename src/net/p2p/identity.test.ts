import { describe, expect, it } from 'vitest';
import { generateIdentity, publicKeyFingerprint, signData, verifyData } from './identity';

describe('P2P signing identity', () => {
  it('signs and verifies with a per-client P-256 key, rejecting tampering and wrong keys', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    expect(alice.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(alice.fingerprint).toBe(await publicKeyFingerprint(alice.publicJwk));
    expect(alice.fingerprint).not.toBe(bob.fingerprint);

    const message = 'peer-a\nmsg-1\n0\nciphertext';
    const signature = await signData(alice, message);
    await expect(verifyData(alice.publicJwk, signature, message)).resolves.toBe(true);
    await expect(verifyData(alice.publicJwk, signature, `${message}tampered`)).resolves.toBe(false);
    await expect(verifyData(bob.publicJwk, signature, message)).resolves.toBe(false);
  });
});
