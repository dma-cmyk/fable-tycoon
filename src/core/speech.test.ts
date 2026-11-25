import { describe, expect, it } from 'vitest';
import type { Fx, GameData, GameState, TurnLines } from './types';
import { fixtureData } from './test-fixture';
import { createGame, distance } from './engine';
import { nodeForCity } from './graph';
import { NEAR_DESTINATION_STEPS, pickTurnSituation, sayTurnLine } from './speech';

const PLAYER_CHARACTERS = ['momotaro', 'sinbad', 'alice', 'red_hood'] as const;
const SITUATIONS = ['normal', 'lead', 'last', 'piper', 'near', 'final', 'realm'] as const;
const LINE_COUNTS: Record<(typeof SITUATIONS)[number], number> = {
  normal: 6,
  lead: 2,
  last: 2,
  piper: 2,
  near: 2,
  final: 2,
  realm: 2,
};

function turnLinesFor(characterId: string): TurnLines {
  const out = {} as TurnLines;
  for (const situation of SITUATIONS) {
    out[situation] = Array.from(
      { length: LINE_COUNTS[situation] },
      (_, i) => `${characterId}/${situation}/${i}`,
    );
  }
  return out;
}

const withTurnLines: GameData = {
  ...fixtureData,
  turnLines: Object.fromEntries(PLAYER_CHARACTERS.map((id) => [id, turnLinesFor(id)])),
};

function createState(): GameState {
  const { state } = createGame(fixtureData, {
    years: 3,
    seed: 7,
    players: PLAYER_CHARACTERS.map((characterId, i) => ({
      name: `P${i + 1}`,
      characterId,
      isCpu: true,
      cpuLevel: 2,
    })),
  });
  return state;
}

/** Calls sayTurnLine, asserts one `say` fx, and returns it. */
function emit(data: GameData, state: GameState, playerId: number): Extract<Fx, { t: 'say' }> {
  const fx: Fx[] = [];
  sayTurnLine(data, state, playerId, fx);
  expect(fx).toHaveLength(1);
  const say = fx[0];
  if (say.t !== 'say') throw new Error(`expected a say fx, got ${say.t}`);
  return say;
}

/** Situation prefix of a line produced by `turnLinesFor` (`id/situation/index`). */
function situationOf(text: string): string {
  return text.split('/')[1] ?? '';
}

function nodeWithin(data: GameData, maxSteps: number): string {
  const destinationNode = nodeForCity(data, 'tokyo');
  if (destinationNode === null) throw new Error('fixture has no tokyo node');
  const nodeId = data.board.nodes
    .filter((node) => node.realm === undefined)
    .map((node) => node.id)
    .find((id) => distance(data, id, destinationNode) <= maxSteps);
  if (nodeId === undefined) throw new Error('fixture has no near world node');
  return nodeId;
}

function nodeFartherThan(data: GameData, steps: number): string {
  const destinationNode = nodeForCity(data, 'tokyo');
  if (destinationNode === null) throw new Error('fixture has no tokyo node');
  const nodeId = data.board.nodes
    .filter((node) => node.realm === undefined)
    .map((node) => node.id)
    .find((id) => distance(data, id, destinationNode) > steps);
  if (nodeId === undefined) throw new Error('fixture has no far world node');
  return nodeId;
}

/** Plain world position, no piper, no standing: only `normal` is possible. */
function parkEveryone(state: GameState, nodeId: string): void {
  for (const player of state.players) {
    player.nodeId = nodeId;
    player.cash = 300;
  }
  state.piper = { holder: null, level: 1, heldTurns: 0 };
  state.destination = 'tokyo';
}

function situationsOver(data: GameData, state: GameState, playerId: number, rounds: number): string[] {
  const seen: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    state.round = round;
    seen.push(situationOf(emit(data, state, playerId).text));
  }
  return seen;
}

describe('sayTurnLine', () => {
  it('never repeats the same text on two consecutive turns of one player', () => {
    const state = createState();
    state.year = 1;
    parkEveryone(state, nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS));

    const textsByPlayer = new Map<number, string[]>();
    for (let round = 0; round < 36; round += 1) {
      state.round = round;
      for (const player of state.players) {
        const text = emit(withTurnLines, state, player.id).text;
        const texts = textsByPlayer.get(player.id) ?? [];
        expect(text, `player ${player.id} repeated on round ${round}`).not.toBe(texts[texts.length - 1]);
        texts.push(text);
        textsByPlayer.set(player.id, texts);
      }
    }
    // 6 normal lines rotate: 36 consecutive turns cover the whole pool.
    for (const texts of textsByPlayer.values()) expect(new Set(texts).size).toBe(6);
  });

  it('never repeats a line in the final year either', () => {
    const state = createState();
    state.year = state.config.years;
    parkEveryone(state, nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS));

    const last = new Map<number, string>();
    const situations = new Set<string>();
    for (let round = 0; round < 36; round += 1) {
      state.round = round;
      for (const player of state.players) {
        const text = emit(withTurnLines, state, player.id).text;
        expect(text).not.toBe(last.get(player.id));
        last.set(player.id, text);
        situations.add(situationOf(text));
      }
    }
    expect(situations.has('final')).toBe(true);
    expect(situations.has('normal')).toBe(true);
  });

  it('picks situations by priority and folds about half of them into normal', () => {
    const rounds = 60;
    // normal share ~0.5 for a situational turn; the final year splits 50/50 first, so ~0.25.
    const cases: Array<{
      name: string;
      setup: (state: GameState) => void;
      allowed: string[];
      required: string;
      normalShare?: [number, number];
    }> = [
      {
        name: 'final year beats piper and standing',
        setup: (state) => {
          state.year = state.config.years;
          state.piper = { holder: 0, level: 1, heldTurns: 0 };
          state.players[0].cash = 5000;
          state.destination = 'tokyo';
          state.players[0].nodeId = nodeForCity(withTurnLines, 'tokyo') ?? 'c:tokyo';
        },
        allowed: ['final', 'piper', 'normal'],
        required: 'final',
        normalShare: [0.08, 0.45],
      },
      {
        name: 'piper beats realm and standing',
        setup: (state) => {
          state.piper = { holder: 0, level: 1, heldTurns: 0 };
          state.players[0].nodeId = 'c:heaven-gate';
          state.players[0].cash = 5000;
        },
        allowed: ['piper', 'normal'],
        required: 'piper',
        normalShare: [0.3, 0.7],
      },
      {
        name: 'realm beats standing',
        setup: (state) => {
          state.players[0].nodeId = 'c:hell-gate';
          state.players[0].cash = 5000;
        },
        allowed: ['realm', 'normal'],
        required: 'realm',
        normalShare: [0.3, 0.7],
      },
      {
        name: 'near beats standing',
        setup: (state) => {
          state.players[0].nodeId = nodeWithin(withTurnLines, NEAR_DESTINATION_STEPS);
          state.players[0].cash = 5000;
        },
        allowed: ['near', 'normal'],
        required: 'near',
        normalShare: [0.3, 0.7],
      },
      {
        name: 'clear lead',
        setup: (state) => {
          state.players[0].nodeId = nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS);
          state.players[0].cash = 5000;
        },
        allowed: ['lead', 'normal'],
        required: 'lead',
        normalShare: [0.3, 0.7],
      },
      {
        name: 'clear last place',
        setup: (state) => {
          state.players[0].nodeId = nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS);
          state.players[0].cash = 0;
          for (const player of state.players.slice(1)) player.cash = 5000;
        },
        allowed: ['last', 'normal'],
        required: 'last',
        normalShare: [0.3, 0.7],
      },
      {
        name: 'no situation stays normal',
        setup: (state) => {
          state.players[0].nodeId = nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS);
          for (const player of state.players) player.cash = 300;
        },
        allowed: ['normal'],
        required: 'normal',
      },
    ];

    for (const testCase of cases) {
      const state = createState();
      state.year = 1;
      parkEveryone(state, nodeFartherThan(withTurnLines, NEAR_DESTINATION_STEPS));
      testCase.setup(state);
      const seen = situationsOver(withTurnLines, state, 0, rounds);
      expect(new Set(seen).size, testCase.name).toBeGreaterThan(0);
      for (const situation of seen) {
        expect(testCase.allowed, `${testCase.name}: unexpected ${situation}`).toContain(situation);
      }
      expect(seen, testCase.name).toContain(testCase.required);
      if (testCase.normalShare) {
        // 状況台詞は半分ほどに抑え、残りは normal に戻す
        const share = seen.filter((situation) => situation === 'normal').length / rounds;
        expect(share, `${testCase.name}: normal share ${share}`).toBeGreaterThanOrEqual(testCase.normalShare[0]);
        expect(share, `${testCase.name}: normal share ${share}`).toBeLessThanOrEqual(testCase.normalShare[1]);
      }
    }
  });

  it('picks the same situation for the same state, without consuming rng', () => {
    const state = createState();
    state.year = state.config.years;
    state.piper = { holder: 1, level: 2, heldTurns: 4 };
    state.players[1].nodeId = 'c:heaven-gate';
    state.round = 12;
    state.rng = 0x1234abcd;

    const before = structuredClone(state);
    const fx: Fx[] = [];
    sayTurnLine(withTurnLines, state, 1, fx);
    sayTurnLine(withTurnLines, state, 1, fx);

    expect(state.rng).toBe(0x1234abcd);
    expect(state).toEqual(before);
    // 決定的: 同じ状態なら同じ台詞
    expect(fx[0]).toEqual(fx[1]);
    expect(pickTurnSituation(withTurnLines, state, 1)).toBe(situationOf(emit(withTurnLines, state, 1).text));
  });

  it('falls back to lines.turn when turnLines are missing', () => {
    const state = createState();
    for (const [index, characterId] of PLAYER_CHARACTERS.entries()) {
      const character = fixtureData.characters.find((c) => c.id === characterId);
      if (!character) throw new Error(`fixture character ${characterId} missing`);
      const say = emit(fixtureData, state, index);
      expect(say.text).toBe(character.lines.turn);
      expect(say.speaker).toBe('self');
      expect(say.playerId).toBe(index);
      expect(say.lineKey).toBe('turn');
    }
  });

  it('falls back for a character without a turnLines entry', () => {
    const partial: GameData = {
      ...fixtureData,
      turnLines: { momotaro: turnLinesFor('momotaro') },
    };
    const state = createState();
    const sinbad = fixtureData.characters.find((c) => c.id === 'sinbad');
    if (!sinbad) throw new Error('fixture character sinbad missing');
    expect(emit(partial, state, 0).text.startsWith('momotaro/')).toBe(true);
    expect(emit(partial, state, 1).text).toBe(sinbad.lines.turn);
  });
});