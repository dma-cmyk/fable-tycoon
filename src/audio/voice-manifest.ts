// Pure manifest-selection rules shared by tools/gen-voice.mjs and its tests.
//
// A voice mp3 may only be published (listed in manifest.json) when it is verified speech:
// - generated in this run and passed the speech QC, or
// - generated earlier and recorded with matching parameters (voices.json), or
// - a previous file that failed regeneration but passes speech QC now; such entries are marked
//   stale so the next run retries them.

export interface VoiceMeta {
  speaker: number;
  speed: number;
  pitch: number;
  intonation: number;
  rev: number;
  stale?: boolean;
}

export interface VoiceManifestCandidate {
  hash: string;
  desired: VoiceMeta;
  hasFile: boolean;
  /** File exists and its voices.json entry matches the desired params and is not stale. */
  verified: boolean;
  /** Existing file passed speech QC in this run (used for failed-regeneration fallback). */
  fallbackVerified: boolean;
  /**
   * Item was NOT retried in this partial run (--only / --limit), already has a speech-QC-verified
   * stale entry published in the previous manifest, and the mp3 still exists on disk.
   */
  preservedStale?: boolean;
  /** Previous voices.json metadata to keep intact while preserving a stale entry. */
  previousMeta?: VoiceMeta;
}

export interface VoiceManifestResult {
  manifest: Record<string, string>;
  meta: Record<string, VoiceMeta>;
  stale: string[];
}

export function voiceMetaMatches(previous: VoiceMeta | undefined, desired: VoiceMeta): boolean {
  return Boolean(
    previous &&
      previous.stale !== true &&
      previous.speaker === desired.speaker &&
      previous.speed === desired.speed &&
      previous.pitch === desired.pitch &&
      previous.intonation === desired.intonation &&
      previous.rev === desired.rev,
  );
}

export function buildVoiceManifest(candidates: readonly VoiceManifestCandidate[]): VoiceManifestResult {
  const manifest: Record<string, string> = {};
  const meta: Record<string, VoiceMeta> = {};
  const stale: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.hasFile) continue;
    if (candidate.verified) {
      manifest[candidate.hash] = `voice/${candidate.hash}.mp3`;
      meta[candidate.hash] = { ...candidate.desired };
      continue;
    }
    if (candidate.fallbackVerified) {
      manifest[candidate.hash] = `voice/${candidate.hash}.mp3`;
      meta[candidate.hash] = { ...candidate.desired, stale: true };
      stale.push(candidate.hash);
      continue;
    }
    if (candidate.preservedStale) {
      manifest[candidate.hash] = `voice/${candidate.hash}.mp3`;
      meta[candidate.hash] = { ...(candidate.previousMeta ?? candidate.desired), stale: true };
      stale.push(candidate.hash);
    }
  }
  return { manifest, meta, stale };
}