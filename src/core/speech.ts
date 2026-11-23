// Small helpers that turn character lines and event dialogue into presentation `say` fx.

import type { DialogueLine, Fx, GameData, GameState, LineKey } from './types';

/** Emits a fixed character voice line (`lineKey`) for a player. */
export function sayCharacterLine(
  data: GameData,
  state: GameState,
  playerId: number,
  lineKey: LineKey,
  fx: Fx[],
): void {
  const player = state.players[playerId];
  const character = data.characters.find((c) => c.id === player?.characterId);
  fx.push({
    t: 'say',
    speaker: 'self',
    playerId,
    text: character?.lines[lineKey] ?? '',
    lineKey,
  });
}

/** Emits every DialogueLine in order; `self` is resolved to the acting player. */
export function emitDialogueLines(
  state: GameState,
  fx: Fx[],
  lines: DialogueLine[] | undefined,
  actorId: number,
): void {
  for (const line of lines ?? []) {
    if (line.speaker === 'self') {
      fx.push({ t: 'say', speaker: 'self', playerId: state.players[actorId]?.id ?? actorId, text: line.text });
    } else {
      fx.push({ t: 'say', speaker: line.speaker, text: line.text });
    }
  }
}