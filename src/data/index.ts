// Assembles the static GameData from the JSON files. Shared by the browser client and the servers.
import type { Board, CardDef, Character, City, EmoteDef, GameData, GameEventDef, NpcDef } from '../core/types';
import board from './board.json';
import cards from './cards.json';
import characters from './characters.json';
import cities from './cities.json';
import emotes from './emotes.json';
import events from './events.json';
import npcs from './npcs.json';

export const GAME_DATA: GameData = {
  cities: cities as City[],
  board: board as Board,
  characters: characters as Character[],
  events: events as GameEventDef[],
  cards: cards as CardDef[],
  npcs: npcs as NpcDef[],
  emotes: emotes as unknown as EmoteDef[],
};
