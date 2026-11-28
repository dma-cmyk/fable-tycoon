import { describe, expect, it } from 'vitest';
import type { Effect, GameConfig, GameData, GameState, Fx } from './types';
import { fixtureData } from './test-fixture';
import { createGame, step } from './engine';
import { GAME_DATA } from '../data';
import {
  EVENT_RESULT_LINES,
  GAMBLE_LOSE_TOAST,
  GAMBLE_WIN_TOAST,
  allEventSpeechTexts,
  choiceMadeSpeech,
  eventOpeningSpeech,
  eventOpeningTail,
  eventResultSpeech,
  withFactSpeech,
} from './eventSpeech';

const data: GameData = fixtureData;

function config(players = 2, seed = 1): GameConfig {
  const characters = ['momotaro', 'sinbad', 'alice'];
  return {
    years: 3,
    seed,
    players: Array.from({ length: players }, (_, i) => ({
      name: `P${i}`,
      characterId: characters[i],
      isCpu: true,
      cpuLevel: 1 as const,
    })),
  };
}

function fresh(players = 2, seed = 1): GameState {
  return createGame(data, config(players, seed)).state;
}

function says(fx: readonly Fx[], speaker?: string): string[] {
  return fx
    .filter((item): item is Extract<Fx, { t: 'say' }> => item.t === 'say')
    .filter((item) => speaker === undefined || item.speaker === speaker)
    .map((item) => item.text);
}

/** イベントの一幕（event_open 〜 event_close）だけの say。その後の手番開始などは含めない。 */
function eventSays(fx: readonly Fx[], speaker?: string): string[] {
  const open = fx.findIndex((item) => item.t === 'event_open');
  const close = fx.findIndex((item) => item.t === 'event_close');
  const end = close === -1 ? fx.length : close + 1;
  return says(fx.slice(Math.max(0, open), end), speaker);
}

describe('event speech: data coverage', () => {
  it('gives every event with a fact a spoken version, and only those', () => {
    for (const event of GAME_DATA.events) {
      const spoken = event.factSpeech;
      if (event.fact) {
        expect(spoken, `${event.id} has a fact but no factSpeech`).toBeTruthy();
      } else {
        expect(spoken, `${event.id} has no fact but carries a factSpeech`).toBeUndefined();
      }
    }
  });

  it('attaches no factSpeech to the code-defined piper events', () => {
    const piper = GAME_DATA.events.filter((event) => event.id.startsWith('piper'));
    for (const event of piper) expect(event.factSpeech).toBeUndefined();
  });

  it('keeps every narrator line speakable: no latin letters or digits, at most 90 chars', () => {
    for (const text of allEventSpeechTexts(GAME_DATA.events)) {
      expect(text).not.toMatch(/[A-Za-z0-9]/);
      expect([...text].length).toBeLessThanOrEqual(90);
    }
  });

  it('speaks the same text the data carries (single source of truth)', () => {
    const event = GAME_DATA.events.find((item) => item.id === 'ai-bubble-again');
    expect(event?.factSpeech).toBeDefined();
    const lines = eventOpeningSpeech(event!);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(event!.factSpeech);
  });
});

describe('event speech: opening', () => {
  it('reads the headline first, then the fact, with the kind announced', () => {
    const event = withFactSpeech({
      id: 'ai-bubble-again',
      title: 'AIバブル再来!?',
      kind: 'news',
      satireNote: 'x',
      weight: 1,
      lines: [],
      effects: [{ op: 'cash', who: 'self', amount: 1 }],
    });
    const lines = eventOpeningSpeech(event);
    expect(lines[0]).toBe('世界ニュース！エーアイバブル再来');
    expect(lines[1]).toBe(event.factSpeech);
    // 半角の !? は全角にそろえる（VOICEVOX が読みやすい形）。
    expect(lines[0]).not.toMatch(/[!?]/);
  });

  it('uses the monthly intro for month-start events', () => {
    const event = {
      id: 'season-heatwave',
      title: '猛暑で電力が悲鳴',
      kind: 'news' as const,
      monthly: true,
      satireNote: 'x',
      weight: 1,
      lines: [],
      effects: [{ op: 'cash' as const, who: 'self' as const, amount: 1 }],
    };
    expect(eventOpeningSpeech(event)[0]).toBe('月替わりイベント！猛暑で電力が悲鳴');
    expect(eventOpeningTail(event)).toBe(EVENT_RESULT_LINES.autoApplied);
  });

  it('asks どうする？ after the dialogue of a choice event', () => {
    const event = GAME_DATA.events.find((item) => item.choices && item.choices.length > 0);
    expect(event).toBeDefined();
    expect(eventOpeningTail(event!)).toBe(EVENT_RESULT_LINES.choicePrompt);
  });

  it('speaks a choice made in a name-free phrase, with latin labels respelled', () => {
    expect(choiceMadeSpeech('乗る！')).toBe('『乗る！』を選びました。');
    expect(choiceMadeSpeech('BTCを保管する')).toBe('『ビットコインを保管する』を選びました。');
    expect(choiceMadeSpeech('BTCを保管する')).not.toMatch(/[A-Za-z0-9]/);
  });
});

describe('event speech: result', () => {
  const emit = (text: string): Fx[] => [{ t: 'toast', text }];

  it('reads the gamble outcome from the toast the effect pushed', () => {
    const effects: Effect[] = [{ op: 'gamble', chance: 0.5, win: [], lose: [] }];
    expect(eventResultSpeech(effects, emit(GAMBLE_WIN_TOAST))).toBe(EVENT_RESULT_LINES.gambleWin);
    expect(eventResultSpeech(effects, emit(GAMBLE_LOSE_TOAST))).toBe(EVENT_RESULT_LINES.gambleLose);
  });

  it('maps the dominant effect to one reusable line', () => {
    expect(
      eventResultSpeech([{ op: 'city_mod', city: 'shenzhen', mult: 0.55, years: 2, label: '崩壊', kind: 'damage' }], []),
    ).toBe(EVENT_RESULT_LINES.cityDamage);
    expect(
      eventResultSpeech([{ op: 'city_mod', city: 'shenzhen', mult: 1.6, years: 2, label: '泡', kind: 'bubble' }], []),
    ).toBe(EVENT_RESULT_LINES.cityUp);
    expect(
      eventResultSpeech([{ op: 'industry_mod', industry: 'tech', mult: 3, years: 2, label: '泡' }], []),
    ).toBe(EVENT_RESULT_LINES.industryUp);
    expect(
      eventResultSpeech([{ op: 'industry_mod', industry: 'tech', mult: 0.3, years: 2, label: '崩壊' }], []),
    ).toBe(EVENT_RESULT_LINES.industryDown);
    expect(eventResultSpeech([{ op: 'cash', who: 'all', amount: 20 }], [])).toBe(EVENT_RESULT_LINES.allGain);
    expect(eventResultSpeech([{ op: 'cash', who: 'all', amount: -20 }], [])).toBe(EVENT_RESULT_LINES.allPay);
    expect(eventResultSpeech([{ op: 'cash', who: 'self', amount: 20 }], [])).toBe(EVENT_RESULT_LINES.cashGain);
    expect(eventResultSpeech([{ op: 'cash', who: 'self', amount: -20 }], [])).toBe(EVENT_RESULT_LINES.cashLoss);
    expect(eventResultSpeech([{ op: 'skip', who: 'self', turns: 1 }], [])).toBe(EVENT_RESULT_LINES.skipTurn);
    expect(eventResultSpeech([{ op: 'sell', who: 'self', industry: 'any', count: 1, priceMult: 0.5 }], [])).toBe(
      EVENT_RESULT_LINES.sold,
    );
  });

  it('stays silent when the event has no effects', () => {
    expect(eventResultSpeech(undefined, [])).toBeNull();
    expect(eventResultSpeech([], [])).toBeNull();
  });

  it('has a speakable line for every result', () => {
    for (const text of Object.values(EVENT_RESULT_LINES)) {
      expect(text).not.toMatch(/[A-Za-z0-9]/);
    }
  });
});

describe('event speech: engine sequence', () => {
  it('plays headline, fact, dialogue, choice-made and result in the order the player reads them', () => {
    const choiceData: GameData = structuredClone(data);
    const fixtureEvent = data.events.find((item) => item.id === 'ev-ai-bubble');
    expect(fixtureEvent).toBeDefined();
    // テスト用の事実にも読み上げ版を付ける（本番データと同じ形にする）。
    choiceData.events = [{ ...fixtureEvent!, factSpeech: 'テスト用の事実です。' }];
    const state = fresh(2, 5);
    state.players[0].nodeId = 'c:osaka';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:1-0', path: ['s:1-0'] }] };
    const landed = step(choiceData, state, 0, { t: 'move', nodeId: 's:1-0' });
    expect(landed.state.phase.t).toBe('event');

    const opened = eventSays(landed.fx, 'narrator');
    // テスト用イベントは読み上げ表に無いので、画面の title をそのまま全角化して読む。
    expect(opened[0]).toBe('世界ニュース！AIバブル再来！？');
    expect(opened[1]).toBe('テスト用の事実です。');
    expect(eventSays(landed.fx).at(-1)).toBe(EVENT_RESULT_LINES.choicePrompt);

    const chosen = step(choiceData, landed.state, 0, { t: 'choose', index: 0 });
    const played = eventSays(chosen.fx, 'narrator');
    expect(played[0]).toBe('『便乗する』を選びました。');
    // 結果の実況は最後の say。賭けが出る選択なので勝敗のどちらか。
    const result = played.at(-1);
    expect([EVENT_RESULT_LINES.gambleWin, EVENT_RESULT_LINES.gambleLose]).toContain(result);
    expect(chosen.fx.some((item) => item.t === 'event_close')).toBe(true);
    // 結果 → event_close の順（実況を聞き終えてから閉じる）。
    const closeIndex = chosen.fx.findIndex((item) => item.t === 'event_close');
    const resultIndex = chosen.fx.slice(0, closeIndex).findLastIndex((item) => item.t === 'say');
    expect(resultIndex).toBeLessThan(closeIndex);
  });

  it('announces the auto-applied summary and the result of a choice-less event', () => {
    const autoData: GameData = structuredClone(data);
    const fixtureEvent = data.events.find((item) => item.id === 'ev-harvest-fable');
    autoData.events = [fixtureEvent!];
    const state = fresh(2, 3);
    state.players[0].nodeId = 'c:osaka';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:1-0', path: ['s:1-0'] }] };
    const result = step(autoData, state, 0, { t: 'move', nodeId: 's:1-0' });
    const played = eventSays(result.fx, 'narrator');
    expect(played[0]).toBe('創作寓話！豊作の年に');
    expect(played).toContain(EVENT_RESULT_LINES.autoApplied);
    // 効果は 物件収益・現金・最下位への分配・移動。移動が最優先で読まれる。
    expect(played.at(-1)).toBe(EVENT_RESULT_LINES.forcedMove);
    expect(result.fx.some((item) => item.t === 'event_close')).toBe(true);
  });
});