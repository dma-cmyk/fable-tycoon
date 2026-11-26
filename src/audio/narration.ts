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
  // --- fun overhaul 2026-11-26 (Showdown) ---
  finalYear: '最終年です。目的地ボーナスは二倍。ここからが本番です！',
  finalStretch: '最終盤です。目的地ボーナスは二倍。逆転はここからです！',
  underdogGrant: '最下位に、下剋上の豆を授けます。形勢逆転なるか。',
  underdog: '下剋上の豆が爆ぜました。最下位が首位から搾り取ります！',
  buyout: '買収成立。持ち主の悲鳴が世界に響きます。',
  monopolyBreak: '独占が、買収によって崩れました！',
  // --- fun overhaul 2026-11-26 第2弾 (寄り道依頼) ---
  errandDone: '寄り道の依頼を果たしました。報酬をどうぞ。',
} as const;

export type NarrationKey = keyof typeof NARRATION;

/**
 * 寄り道依頼の依頼主ごとの固定ナレーション。1 人 1 件。
 * キャラクター本人の声は `lines` に新しいキーを足さずに済ませるため、ナレーターが読み上げる。
 * 45 文字以内・英字と数字なし（`tools/gen-voice.mjs` がそのまま音声化する）。
 */
export const ERRAND_NARRATION: Readonly<Record<string, string>> = {
  momotaro: '桃太郎から頼みがある。鬼ヶ島の下見をしてほしいそうだ。',
  momo_dog: '犬がお使いを頼みたいそうだ。きびだんごを届けてあげて。',
  momo_monkey: '猿の頼みだ。桃の数をかぞえてきてほしい。',
  momo_pheasant: 'キジが鬼の偵察を頼んでいる。そっと見てきてあげて。',
  aka_oni: '赤鬼が泣き虫をなぐさめてほしいと頼んでいる。',
  kintaro: '金太郎が熊の背中を洗ってほしいと頼んでいる。',
  urashima: '浦島太郎が玉手箱を届けてほしいと頼んでいる。',
  kaguya: 'かぐや姫が月への手紙を託したいそうだ。',
  issun: '一寸法師が針の刀を研いでほしいと頼んでいる。',
  bunbuku: 'たぬきが茶釜を返してほしいと頼んでいる。',
  wukong: '孫悟空が仙桃を届けてほしいと頼んでいる。',
  sinbad: 'シンドバッドが七つ目の港へ行ってほしいそうだ。',
  aladdin: 'アラジンがランプを磨いてほしいと頼んでいる。',
  lamp_genie: '魔人が願い事を集めている。聞いてきてあげて。',
  ali_baba: 'アリババが合言葉を届けてほしいと頼んでいる。',
  anansi: 'アナンシが知恵の壺を探してほしいと頼んでいる。',
  alice: 'アリスが白ウサギを追ってほしいと頼んでいる。',
  white_rabbit: '白ウサギが懐中時計を直してほしいと頼んでいる。',
  cheshire: 'チェシャ猫が笑い方を教えてほしいと頼んでいる。',
  heart_queen: 'ハートの女王がタルトを焼いてほしいと命じている。',
  mad_hatter: '帽子屋がお茶会の席を確保してほしいと頼んでいる。',
  naked_emperor: '王様が見えない服を仕立ててほしいと頼んでいる。',
  pinocchio: 'ピノキオが鼻を短くしてほしいと頼んでいる。',
  puss: '長靴をはいた猫が王様への贈り物を頼んでいる。',
  red_hood: '赤ずきんからお使いの頼み。ワインを届けてあげて。',
  wolf: 'オオカミが森の道を案内してほしいと頼んでいる。',
  granny: 'おばあさんが毛糸を買ってきてほしいと頼んでいる。',
  gretel: 'グレーテルがお菓子を届けてほしいと頼んでいる。',
  candy_witch: 'お菓子の家の魔女が砂糖の買い出しを頼んでいる。',
  rumpel: 'ルンペルが自分の名前を当ててほしいと頼んでいる。',
  jack: 'ジャックが豆の種を届けてほしいと頼んでいる。',
  giant: '豆の木の巨人が金の卵を探してほしいと頼んでいる。',
  cinderella: 'シンデレラがガラスの靴を探してほしいと頼んでいる。',
  stepmother: '継母が舞踏会の招待状を届けてほしいと頼んでいる。',
  stepsister: '義姉がドレスを借りてきてほしいと頼んでいる。',
  snow_white: '白雪姫が毒りんごを捨ててほしいと頼んでいる。',
  evil_queen: '魔女のお妃が鏡を磨いてほしいと頼んでいる。',
  dwarf: '小人が鉱石を届けてほしいと頼んでいる。',
  mermaid: '人魚姫が声を届けてほしいと頼んでいる。',
  ugly_duckling: 'みにくいアヒルの子が白鳥を探してほしいそうだ。',
  ant: 'アリが砂糖を運んでほしいと頼んでいる。',
  grasshopper: 'キリギリスが冬支度を手伝ってほしいと頼んでいる。',
  golden_goose: '金の卵のガチョウが卵を届けてほしいと頼んでいる。',
  baba_yaga: 'バーバ・ヤーガが臼を返してほしいと頼んでいる。',
  tortoise: 'カメがウサギに手紙を届けてほしいと頼んでいる。',
  thumbelina: 'おやゆび姫が花の露を集めてほしいと頼んでいる。',
  robin_hood: 'ロビン・フッドが貧しい家への配達を頼んでいる。',
  kappa: '河童がきゅうりを届けてほしいと頼んでいる。',
};

/** 依頼主が未知でも音声が欠けないようにする固定の受け皿。 */
export const ERRAND_NARRATION_FALLBACK = '寄り道の依頼が届きました。受けてみてはどうでしょう。';

export function errandNarration(requesterId: string): string {
  return ERRAND_NARRATION[requesterId] ?? ERRAND_NARRATION_FALLBACK;
}

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
  for (const text of Object.values(ERRAND_NARRATION)) texts.add(text);
  texts.add(ERRAND_NARRATION_FALLBACK);
  for (const city of cities) {
    texts.add(arrive(city.nameJa));
    texts.add(destination(city.nameJa));
    texts.add(goal(city.nameJa));
  }
  return [...texts];
}