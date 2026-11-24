import { describe, expect, it } from 'vitest';
import type { PublicState } from './protocol';
import {
  claimRanksAbove,
  countFollowers,
  isStaleGeneration,
  isVerifiedTransfer,
  nextGeneration,
  reportVoteAckTargets,
  rosterCertPayload,
  rotateBrokers,
  stateHashOf,
  transferApprovalPayload,
  verifyTransferProof,
} from './authority';
import type { FollowRecord, KeyLink, SeatRosterCert, TransferProof } from './authority';
import { generateIdentity, signData } from './p2p/identity';

function follow(hostFp: string, gen: number, at: number): FollowRecord {
  return { hostFp, gen, at };
}

describe('authority generations', () => {
  it('always moves strictly above every generation seen', () => {
    expect(nextGeneration([])).toBe(1);
    expect(nextGeneration([1])).toBe(2);
    expect(nextGeneration([1, 4, 2])).toBe(5);
    expect(nextGeneration([Number.NaN, -3, 7])).toBe(8);
    // A returning old host (gen 1) after a temp host served gen 2 must never re-win.
    expect(isStaleGeneration(1, 2)).toBe(true);
    expect(isStaleGeneration(2, 2)).toBe(false);
    expect(isStaleGeneration(3, 2)).toBe(false);
  });

  it('ranks a claim by generation first, then seq, humans, peer id', () => {
    const base = { gen: 2, seq: 10, connectedHumans: 3, hostPeerId: 'bbb' };
    expect(claimRanksAbove({ ...base, gen: 3, seq: 1 }, base)).toBe(true);
    expect(claimRanksAbove({ ...base, gen: 1, seq: 999 }, base)).toBe(false);
    expect(claimRanksAbove({ ...base, seq: 11 }, base)).toBe(true);
    expect(claimRanksAbove({ ...base, seq: 10, connectedHumans: 4 }, base)).toBe(true);
    expect(claimRanksAbove({ ...base, hostPeerId: 'aaa' }, base)).toBe(true);
    expect(claimRanksAbove(base, base)).toBe(false);
  });
});

describe('single-host following', () => {
  const seatKeys = { '0': 'host-key', '1': 'a-key', '2': 'b-key' };

  it('counts only seats whose latest liveness follows this host and generation', () => {
    const now = 10_000;
    const followers = new Map<string, FollowRecord>([
      ['a-key', follow('host-key', 2, now - 100)],
      // b-key already switched to the new host: the old host loses its majority immediately.
      ['b-key', follow('other-key', 3, now - 50)],
    ]);
    expect(countFollowers(seatKeys, followers, 'host-key', now, 1_000)).toBe(2);
    expect(countFollowers(seatKeys, followers, 'other-key', now, 1_000)).toBe(1);
    // A follower that is one generation behind still follows the same host key (catch-up window).
    expect(countFollowers(seatKeys, followers, 'host-key', now + 1, 1_000)).toBe(2);
    // Stale liveness stops counting (the peer stopped sending).
    expect(countFollowers(seatKeys, followers, 'host-key', now + 2_000, 1_000)).toBe(1);
  });

  it('never counts a CPU/open seat that has no pinned key', () => {
    const now = 5;
    const followers = new Map<string, FollowRecord>([['a-key', follow('host-key', 1, now)]]);
    expect(countFollowers({ '0': 'host-key', '1': 'a-key' }, followers, 'host-key', now, 10)).toBe(2);
    expect(countFollowers({ '0': 'host-key' }, followers, 'host-key', now, 10)).toBe(1);
  });
});

describe('host key chain', () => {
  const agreed = ['host-key', 'a-key', 'b-key'];
  const link = (approvedBy: string[], needed = 1): Pick<KeyLink, 'approvedBy' | 'needed'> => ({
    approvedBy,
    needed,
  });

  it('accepts only a successor approved by agreed seats (strict majority)', () => {
    expect(isVerifiedTransfer(link(['a-key']), agreed, 1)).toBe(true);
    expect(isVerifiedTransfer(link(['a-key']), agreed, 2)).toBe(false);
    expect(isVerifiedTransfer(link(['a-key', 'b-key']), agreed, 2)).toBe(true);
    // An attacker key is never an agreed seat.
    expect(isVerifiedTransfer(link(['evil']), agreed, 1)).toBe(false);
    expect(isVerifiedTransfer(link(['a-key', 'evil']), agreed, 2)).toBe(false);
    // A stored `needed` larger than the current requirement still has to be met.
    expect(isVerifiedTransfer(link(['a-key'], 2), agreed, 1)).toBe(false);
  });
});

describe('broker rotation', () => {
  it('rotates candidates and skips brokers that never answered', () => {
    const brokers = ['mqtt://one', 'mqtt://two', 'mqtt://three'];
    expect(rotateBrokers(brokers, 0)).toEqual(brokers);
    expect(rotateBrokers(brokers, 1)).toEqual(['mqtt://two', 'mqtt://three', 'mqtt://one']);
    expect(rotateBrokers(brokers, 0, new Set(['mqtt://one']))).toEqual(['mqtt://two', 'mqtt://three']);
    // Everything excluded falls back to the full list rather than dropping the connection.
    expect(rotateBrokers(brokers, 0, new Set(brokers))).toEqual(brokers);
  });
});

describe('state hash', () => {
  const state = {
    current: 0,
    phase: { t: 'roll' },
    year: 1,
    month: 4,
    players: [{ id: 0, cash: 1500, nodeId: 'Tokyo', cards: [], skipTurns: 0 }],
    owner: { Osaka: 0 },
  } as unknown as PublicState;

  it('changes when the visible state diverges and is stable otherwise', () => {
    expect(stateHashOf(state, 3)).toBe(stateHashOf({ ...state }, 3));
    expect(stateHashOf(state, 3)).not.toBe(stateHashOf(state, 4));
    expect(stateHashOf(state, 3)).not.toBe(
      stateHashOf({ ...state, players: [{ ...state.players[0], cash: 1499 }] }, 3),
    );
    expect(stateHashOf(state, 3)).not.toBe(stateHashOf({ ...state, owner: {} }, 3));
    expect(stateHashOf(null, 7)).toBe('e:7');
  });
});

describe('reportVoteAckTargets', () => {
  it('includes the voter itself and every non-host human seat so successor keeps the vote', () => {
    const seatKeys = { '0': 'host-fp', '1': 'voter-fp', '2': 'target-fp', '3': 'other-fp' };
    const targets = reportVoteAckTargets(seatKeys, 'host-fp');
    expect(targets.has('voter-fp')).toBe(true);
    expect(targets.has('target-fp')).toBe(true);
    expect(targets.has('other-fp')).toBe(true);
    expect(targets.has('host-fp')).toBe(false);
  });
});

describe('signed host transfer proof', () => {
  it('verifies a transfer anchored to the initial host invite pin and rejects forged or minority proofs', async () => {
    const host0 = await generateIdentity();
    const guest1 = await generateIdentity();
    const guest2 = await generateIdentity();
    const attacker = await generateIdentity();
    const roomId = 'ABCDEF-1234';
    const seats = {
      '0': host0.publicJwk,
      '1': guest1.publicJwk,
      '2': guest2.publicJwk,
    };
    const roster: SeatRosterCert = {
      roomId,
      hostFp: host0.fingerprint,
      hostJwk: host0.publicJwk,
      seats,
      at: 1,
      sig: await signData(host0, rosterCertPayload(roomId, host0.fingerprint, seats)),
    };
    const approvalPayload = transferApprovalPayload(roomId, 2, guest1.fingerprint, host0.fingerprint);
    const sig1 = await signData(guest1, approvalPayload);
    const sig2 = await signData(guest2, approvalPayload);
    const validProof: TransferProof = {
      roomId,
      roster,
      gen: 2,
      newHostFp: guest1.fingerprint,
      prevHostFp: host0.fingerprint,
      approvals: [
        { fp: guest1.fingerprint, jwk: guest1.publicJwk, sig: sig1 },
        { fp: guest2.fingerprint, jwk: guest2.publicJwk, sig: sig2 },
      ],
    };

    const inviteHint = host0.fingerprint.slice(0, 16);
    expect(await verifyTransferProof(validProof, roomId, inviteHint)).toBe(true);
    // Minority (1 of 3) must be rejected.
    expect(
      await verifyTransferProof({ ...validProof, approvals: [validProof.approvals[0]] }, roomId, inviteHint),
    ).toBe(false);
    // Wrong invite pin or wrong room must be rejected.
    expect(await verifyTransferProof(validProof, roomId, attacker.fingerprint.slice(0, 16))).toBe(false);
    expect(await verifyTransferProof(validProof, 'ZZZZZZ-9999', inviteHint)).toBe(false);
    // Attacker claiming to be new host (not in initial host's signed roster) must be rejected.
    const attackerPayload = transferApprovalPayload(roomId, 2, attacker.fingerprint, host0.fingerprint);
    const forgedProof: TransferProof = {
      ...validProof,
      newHostFp: attacker.fingerprint,
      approvals: [
        { fp: attacker.fingerprint, jwk: attacker.publicJwk, sig: await signData(attacker, attackerPayload) },
        { fp: guest1.fingerprint, jwk: guest1.publicJwk, sig: await signData(guest1, attackerPayload) },
      ],
    };
    expect(await verifyTransferProof(forgedProof, roomId, inviteHint)).toBe(false);
  });
});
