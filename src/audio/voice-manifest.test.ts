import { describe, expect, it } from 'vitest';
import {
  buildVoiceManifest,
  voiceMetaMatches,
  type VoiceManifestCandidate,
  type VoiceMeta,
} from './voice-manifest';

const desired: VoiceMeta = { speaker: 24, speed: 1, pitch: 0, intonation: 1, rev: 2 };

function candidate(overrides: Partial<VoiceManifestCandidate> = {}): VoiceManifestCandidate {
  return { hash: 'a1b2c3d4', desired, hasFile: true, verified: true, fallbackVerified: false, ...overrides };
}

describe('voiceMetaMatches', () => {
  it('accepts a matching non-stale entry', () => {
    expect(voiceMetaMatches({ ...desired }, desired)).toBe(true);
  });

  it('retries stale entries', () => {
    expect(voiceMetaMatches({ ...desired, stale: true }, desired)).toBe(false);
  });

  it('retries when speaker or synthesis params changed', () => {
    expect(voiceMetaMatches({ ...desired, speaker: 105 }, desired)).toBe(false);
    expect(voiceMetaMatches({ ...desired, speed: 0.95 }, desired)).toBe(false);
    expect(voiceMetaMatches({ ...desired, rev: 1 }, desired)).toBe(false);
  });
});

describe('buildVoiceManifest', () => {
  it('publishes files verified in this run', () => {
    const result = buildVoiceManifest([candidate()]);
    expect(result.manifest).toEqual({ a1b2c3d4: 'voice/a1b2c3d4.mp3' });
    expect(result.meta.a1b2c3d4).toEqual(desired);
    expect(result.stale).toEqual([]);
  });

  it('keeps a failed item published only when the existing mp3 passes speech QC, marked stale', () => {
    const result = buildVoiceManifest([
      candidate({ verified: false, fallbackVerified: true }),
    ]);
    expect(result.manifest).toEqual({ a1b2c3d4: 'voice/a1b2c3d4.mp3' });
    expect(result.meta.a1b2c3d4).toEqual({ ...desired, stale: true });
    expect(result.stale).toEqual(['a1b2c3d4']);
  });

  it('excludes a failed item whose existing mp3 fails speech QC (old noise)', () => {
    const result = buildVoiceManifest([
      candidate({ verified: false, fallbackVerified: false }),
    ]);
    expect(result.manifest).toEqual({});
    expect(result.meta).toEqual({});
    expect(result.stale).toEqual([]);
  });

  it('excludes entries without a file', () => {
    const result = buildVoiceManifest([candidate({ hasFile: false, verified: false })]);
    expect(result.manifest).toEqual({});
  });

  it('does not let verified=true override a missing file', () => {
    const result = buildVoiceManifest([candidate({ hasFile: false })]);
    expect(result.manifest).toEqual({});
  });

  it('preserves a previously published stale entry during a partial run (--only / --limit)', () => {
    const previousMeta: VoiceMeta = { ...desired, speaker: 10, stale: true };
    const result = buildVoiceManifest([
      candidate({
        verified: false,
        fallbackVerified: false,
        preservedStale: true,
        previousMeta,
      }),
    ]);
    expect(result.manifest).toEqual({ a1b2c3d4: 'voice/a1b2c3d4.mp3' });
    expect(result.meta.a1b2c3d4).toEqual({ ...previousMeta, stale: true });
    expect(result.stale).toEqual(['a1b2c3d4']);
  });

  it('drops a preserved stale entry if its mp3 file is missing', () => {
    const result = buildVoiceManifest([
      candidate({
        hasFile: false,
        verified: false,
        fallbackVerified: false,
        preservedStale: true,
      }),
    ]);
    expect(result.manifest).toEqual({});
    expect(result.meta).toEqual({});
    expect(result.stale).toEqual([]);
  });
});