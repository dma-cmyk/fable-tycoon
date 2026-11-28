// Assembles the static GameData from the JSON files. Shared by the browser client and the servers.
import type { Board, CardDef, Character, City, EmoteDef, GameData, GameEventDef, NpcDef, TurnLines } from '../core/types';
import board from './board.json';
import cards from './cards.json';
import characters from './characters.json';
import cities from './cities.json';
import emotes from './emotes.json';
import events from './events.json';
import npcs from './npcs.json';
import realms from './realms.json';
import turnLines from './turnLines.json';
import { PIPER_CONFISCATE_EVENT, PIPER_DEAL_EVENT } from '../core/piperLines';
import { withFactSpeech } from '../core/eventSpeech';

export const GAME_DATA: GameData = {
  // 異世界の駅（realm 付き City）も物件・独占・収益の対象なので同じ配列に含める
  cities: [...(cities as City[]), ...(realms as City[])],
  board: board as Board,
  characters: characters as Character[],
  // 取り立て屋の示談・没収イベントはコード定義（抽選対象外）なので、抽選用の events.json には置かない。
  // factSpeech（読み上げ版の事実）は events.json ではなく src/core/eventSpeech.ts の表から付ける。
  events: [...(events as GameEventDef[]).map(withFactSpeech), PIPER_DEAL_EVENT, PIPER_CONFISCATE_EVENT],
  cards: cards as CardDef[],
  npcs: npcs as NpcDef[],
  emotes: emotes as unknown as EmoteDef[],
  turnLines: turnLines as Record<string, TurnLines>,
};
