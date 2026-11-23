import { Audio, voiceKeyOf } from '../../audio/audio';
import type { EmoteDef } from '../../core/types';

export interface EmoteLines {
  speaker: string;
  hit: string | null;
  speakerCharacterId: string | null;
  victimCharacterId: string | null;
}

export function resolveEmoteLines(
  def: EmoteDef,
  speakerCharacterId: string | null,
  victimCharacterId: string | null,
): EmoteLines {
  const speaker = speakerCharacterId ? def.lines[speakerCharacterId] ?? def.lines.default : def.lines.default;
  const hit =
    victimCharacterId && def.hitLines
      ? def.hitLines[victimCharacterId] ?? def.hitLines.default ?? null
      : null;
  return { speaker, hit, speakerCharacterId, victimCharacterId };
}

/** Plays the attacker line, then (for targeted emotes) the victim's return line. */
export async function playEmoteVoice(
  lines: EmoteLines,
  isVoiceMuted: (characterId: string | null) => boolean,
): Promise<void> {
  if (lines.speakerCharacterId && !isVoiceMuted(lines.speakerCharacterId)) {
    await Audio.playChatter(
      voiceKeyOf(`char:${lines.speakerCharacterId}`),
      lines.speaker,
    );
  }
  if (lines.hit && lines.victimCharacterId && !isVoiceMuted(lines.victimCharacterId)) {
    await Audio.playChatter(
      voiceKeyOf(`char:${lines.victimCharacterId}`),
      lines.hit,
    );
  }
}