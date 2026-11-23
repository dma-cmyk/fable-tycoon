// Fixed narrator lines. Everything here is voiced ahead of time, so every string must be a
// constant (no player names, no numbers that depend on the game state). The voice generator calls
// the same functions to enumerate all texts, which keeps audio and subtitles from drifting apart.

import type { City } from '../core/types';

/** Generic narrator lines that do not depend on a city. */
export const NARRATION = {
  gameStart: '世界を巡って、一番儲けた者の勝ちです。ゲーム開始！',
  yearEnd: '決算の時間です！',
  lastYear: '最終年度です。最後の決算まで気を抜かないでください！',
  piperAppear: 'ハーメルンの取り立て屋が現れました！',
  piperLevelUp: '取り立て屋がレベルアップしました！',
  piperMove: '取り立て屋が、別のプレイヤーに憑きました！',
  monopoly: '都市を独占しました。収益が二倍です！',
  blue: '青マスです。臨時収入がありました！',
  red: '赤マスです。想定外の出費です！',
  yellow: '黄色のマスです。カードを引きます！',
  news: '世界ニュースイベントです！',
  gameOver: 'ゲーム終了！',
  winner: '世界一の大富豪が決まりました！',
} as const;

export type NarrationKey = keyof typeof NARRATION;

/** 「〇〇に到着！」 */
export function arrive(cityNameJa: string): string {
  return `${cityNameJa}に到着！`;
}

/** 「次の目的地は〇〇！」 */
export function destination(cityNameJa: string): string {
  return `次の目的地は${cityNameJa}！`;
}

/** 「〇〇に一番乗り！」 */
export function goal(cityNameJa: string): string {
  return `${cityNameJa}に一番乗り！`;
}

/**
 * Every narrator text the game can play: the generic table plus arrival / destination / first-goal
 * lines for each city. Used by tools/gen-voice.mjs to generate the full narrator voice set.
 */
export function allNarrationTexts(cities: readonly Pick<City, 'nameJa'>[]): string[] {
  const texts = new Set<string>(Object.values(NARRATION));
  for (const city of cities) {
    texts.add(arrive(city.nameJa));
    texts.add(destination(city.nameJa));
    texts.add(goal(city.nameJa));
  }
  return [...texts];
}