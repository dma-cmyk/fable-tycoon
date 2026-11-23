// Voice manifest keys. The generator (tools/gen-voice.mjs) and the client must produce the
// exact same key for the same (speaker, text) pair, otherwise a generated line is never found.

import type { SpeakerRef } from '../core/types';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit over the UTF-8 bytes of `voiceKey + "\n" + text`, as 8 lowercase hex digits.
 * UTF-8 keeps the result identical in the browser and in Node regardless of JS string encoding.
 */
export function voiceHash(voiceKey: string, text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(`${voiceKey}\n${text}`)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Maps a dialogue speaker to its manifest voice key: `char:<id>`, `npc:<id>` or `narrator`.
 * `self` needs the acting player's character id; without one the resulting key has an empty id,
 * which never matches the manifest and therefore plays silently instead of throwing.
 */
export function voiceKeyOf(speaker: SpeakerRef, playerCharacterId?: string): string {
  if (speaker === 'self') return `char:${playerCharacterId ?? ''}`;
  return speaker;
}