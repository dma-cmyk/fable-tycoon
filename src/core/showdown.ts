// 最終年の逆転演出・下剋上カード・都市での買収 (fun overhaul 2026-11-26)。
//
// ここにある判定はすべて純粋で決定的。オンラインではホストだけが engine 経由で呼ぶ。
// 状態は `step` が渡す複製に対してだけ書き換える。

import type { Action, Fx, GameData, GameState, PlayerState, StateView } from './types';
import {
  currentPrice,
  findProperty,
  monopolises,
  netWorth,
  ownCount,
  ownedProperties,
  sellPrice,
} from './economy';
import { sayCharacterLine } from './speech';
import { NARRATION } from '../audio/narration';

/** 下剋上カードの id（cards.json / cards.ts と一致させる）。 */
export const UNDERDOG_CARD_ID = 'underdog';

/** 首位との総資産差のうち、下剋上カードが奪う割合。 */
export const UNDERDOG_GAP_SHARE = 0.18;

/** 現金で足りない分を物件の強制売却で補うときの上限件数（首位を丸裸にしない）。 */
const UNDERDOG_MAX_SEIZURES = 2;

/** 他人の物件を買い取る価格倍率（通常）。 */
export const BUYOUT_MULT = 1.5;

/** 相手がその都市を独占している場合の価格倍率（独占が崩れる）。 */
export const BUYOUT_MONOPOLY_MULT = 2;

/** 最終年の判定に必要な最小限のビュー（GameState と PublicState の両方を受ける）。 */
export interface FinalYearView {
  year: number;
  month: number;
  config: { years: number };
}

/**
 * 最終年（1年制のゲームは最終3か月「最終盤」）かどうか。
 * 目的地ボーナス倍率・最終年イベントの抽選・HUD バッジのすべてがこの述語を使う。
 * - 3年以上: 第 N 年（年の初めから決算まで）
 * - 1年制: 1月〜3月（年度末の3か月）
 */
export function isFinalYearActive(state: FinalYearView): boolean {
  if (state.config.years <= 1) {
    return state.year === 1 && state.month >= 1 && state.month <= 3;
  }
  return state.year >= state.config.years;
}

/** 1年制ゲームの「最終盤」（最終3か月）か。 */
export function isFinalStretch(state: FinalYearView): boolean {
  return state.config.years <= 1;
}

/** 最終年の開幕演出を出す、ちょうど1回だけの状態か。 */
export function isFinalYearOpening(state: FinalYearView): boolean {
  if (state.config.years <= 1) return state.year === 1 && state.month === 1;
  return state.year === state.config.years && state.month === 4;
}

/** バナー見出し。 */
export function finalYearTitle(state: FinalYearView): string {
  return isFinalStretch(state) ? '最終盤' : '最終年';
}

/** 開幕バナーに並べるルール変更。UI とログの両方がこれを使う。 */
export function finalYearRules(state: FinalYearView): string[] {
  const rules = [
    '目的地ボーナス ×2',
    '最終年イベント解禁（首位を狙い撃ち）',
    '青マス +50%（首位以外）',
  ];
  if (isFinalStretch(state)) rules.unshift('残り3か月、ここが最終盤');
  return rules;
}

/** 最終年開幕の fx（開幕でなければ空配列）。 */
export function finalYearFx(state: FinalYearView): Fx[] {
  if (!isFinalYearOpening(state)) return [];
  return [{ t: 'final_year', year: state.year, rules: finalYearRules(state) }];
}

/** 開幕バナーで読み上げる固定ナレーション（音声は事前生成済みの1本）。 */
export function finalYearNarration(state: FinalYearView): string {
  return isFinalStretch(state) ? NARRATION.finalStretch : NARRATION.finalYear;
}

/** 目的地ボーナスに掛ける倍率（最終年は2倍）。 */
export function destinationBonusMultiplier(state: FinalYearView): number {
  return isFinalYearActive(state) ? 2 : 1;
}

/**
 * 最終年の青マスの倍率。首位には掛けない（1.5倍）。
 * 指標: 青マスは1ゲームで平均+396億、赤は-97億。全員の青を増やすと首位も一緒に増えて
 * 差が開くだけなので、最下位争いをしている側にだけ配る。
 */
export function finalYearBlueMultiplier(data: GameData, state: StateView, playerId: number): number {
  if (!isFinalYearActive(state)) return 1;
  return leaderOf(data, state) === playerId ? 1 : 1.5;
}

/** 総資産が最大のプレイヤー（同額なら小さい id）。 */
export function leaderOf(data: GameData, state: StateView): number {
  let best = state.players[0]?.id ?? 0;
  let bestWorth = Number.NEGATIVE_INFINITY;
  for (const player of state.players) {
    const worth = netWorth(data, state, player.id);
    if (worth > bestWorth || (worth === bestWorth && player.id < best)) {
      best = player.id;
      bestWorth = worth;
    }
  }
  return best;
}

/**
 * 下剋上カードを使えるか。
 * 最下位のときだけ。2人対戦は「下位半分」＝劣勢側なら使える。
 * 同率首位（差額0）では使えない。
 */
export function canUseUnderdog(data: GameData, state: StateView, playerId: number): boolean {
  if (state.players.length < 2) return false;
  const worths = state.players.map((p) => netWorth(data, state, p.id));
  const mine = netWorth(data, state, playerId);
  if (mine >= Math.max(...worths)) return false;
  if (state.players.length === 2) return true;
  return mine === Math.min(...worths);
}

/** 下剋上カードが奪う額（首位との総資産差 × 18%）。 */
export function underdogShare(data: GameData, state: StateView, playerId: number): number {
  const leader = leaderOf(data, state);
  if (leader === playerId) return 0;
  const gap = netWorth(data, state, leader) - netWorth(data, state, playerId);
  if (!(gap > 0)) return 0;
  return Math.max(0, Math.round(gap * UNDERDOG_GAP_SHARE));
}

/**
 * 下剋上カードを実行する。使えない状況なら false（engine 側で illegal にする）。
 * 首位の現金から奪い、足りない分は首位の安い物件を強制売却して支払わせる。
 */
export function playUnderdogCard(
  data: GameData,
  state: GameState,
  fx: Fx[],
  playerId: number,
): boolean {
  if (!canUseUnderdog(data, state, playerId)) return false;
  const target = underdogShare(data, state, playerId);
  if (target <= 0) return false;
  const player = state.players[playerId];
  const leaderId = leaderOf(data, state);
  const leader = state.players[leaderId];
  if (!player || !leader || leaderId === playerId) return false;

  let taken = 0;
  const fromCash = Math.min(target, Math.max(0, leader.cash));
  if (fromCash > 0) {
    leader.cash -= fromCash;
    player.cash += fromCash;
    taken += fromCash;
    fx.push({ t: 'cash', playerId: leader.id, delta: -fromCash, reason: '下剋上の豆' });
    fx.push({ t: 'cash', playerId: player.id, delta: fromCash, reason: '下剋上の豆' });
  }

  if (taken < target) {
    const owned = ownedProperties(data, state, leader.id).sort((a, b) => {
      const pa = currentPrice(data, state, a.property.id);
      const pb = currentPrice(data, state, b.property.id);
      return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
    });
    let seized = 0;
    for (const ref of owned) {
      if (taken >= target || seized >= UNDERDOG_MAX_SEIZURES) break;
      const saleAmount = sellPrice(data, state, ref.property.id);
      if (saleAmount <= 0) continue;
      const toPlayer = Math.min(saleAmount, target - taken);
      delete state.owner[ref.property.id];
      player.cash += toPlayer;
      const backToLeader = saleAmount - toPlayer;
      if (backToLeader > 0) {
        leader.cash += backToLeader;
        fx.push({ t: 'cash', playerId: leader.id, delta: backToLeader, reason: '下剋上の豆（換金）' });
      }
      taken += toPlayer;
      seized += 1;
      fx.push({ t: 'sell', playerId: leader.id, propertyId: ref.property.id, amount: saleAmount });
      fx.push({ t: 'cash', playerId: player.id, delta: toPlayer, reason: '下剋上の豆（物件）' });
    }
  }

  fx.push({ t: 'toast', text: `下剋上の豆が育ち、${leader.name} から ${Math.round(taken)} 億円を奪い取った！` });
  fx.push({ t: 'say', speaker: 'narrator', text: NARRATION.underdog });
  sayCharacterLine(data, state, leader.id, 'piper_hit', fx);
  return true;
}

/**
 * 年末決算（最終年を除く）で最下位に下剋上カードを無料配布する。
 * すでに持っている場合は重複させない（1枚を使い切るまで次の豆は来ない）。
 */
export function grantUnderdogCard(
  state: GameState,
  fx: Fx[],
  ranking: number[],
): void {
  if (state.year >= state.config.years) return;
  if (state.players.length < 2) return;
  const lastId = ranking[ranking.length - 1];
  const last = state.players[lastId];
  if (!last) return;
  if (last.cards.includes(UNDERDOG_CARD_ID)) {
    fx.push({ t: 'toast', text: `${last.name} はすでに下剋上の豆を持っている。` });
    return;
  }
  last.cards.push(UNDERDOG_CARD_ID);
  fx.push({ t: 'card_get', playerId: last.id, cardId: UNDERDOG_CARD_ID });
  fx.push({ t: 'toast', text: `最下位の ${last.name} に、下剋上の豆が授けられた。` });
  fx.push({ t: 'say', speaker: 'narrator', text: NARRATION.underdogGrant });
}

// ---------------------------------------------------------------- buyout

export interface BuyoutQuote {
  propertyId: string;
  ownerId: number;
  /** 現在価格（時価）。買収額はこれに倍率を掛けたもの。 */
  basePrice: number;
  /** 実際に支払う買収額（時価 × 1.5、独占中は × 2.0）。 */
  price: number;
  /** 買収額の倍率（1.5 / 2.0）。 */
  mult: number;
  /** 所有者がこの都市を独占している（買うと独占が崩れる）。 */
  brokeMonopoly: boolean;
}

/** 買収価格の見積り。所有者がいなければ null。 */
export function buyoutQuote(data: GameData, state: StateView, propertyId: string): BuyoutQuote | null {
  const ref = findProperty(data, propertyId);
  const ownerId = state.owner[propertyId];
  if (!ref || ownerId === undefined) return null;
  const monopoly = monopolises(data, state, ownerId, ref.cityId);
  const basePrice = currentPrice(data, state, propertyId);
  const mult = monopoly ? BUYOUT_MONOPOLY_MULT : BUYOUT_MULT;
  return { propertyId, ownerId, basePrice, price: basePrice * mult, mult, brokeMonopoly: monopoly };
}

export type BuyoutCheck =
  | { ok: true; quote: BuyoutQuote }
  | { ok: false; reason: string };

/**
 * `buy` フェーズの買収を検証する。1訪問1回の制限もここで見る。
 * 価格・独占判定は `buyoutQuote` と完全に同じ計算。
 */
export function checkBuyout(
  data: GameData,
  state: StateView,
  playerId: number,
  cityId: string,
  propertyId: string,
  alreadyBoughtOut: boolean,
): BuyoutCheck {
  if (alreadyBoughtOut) return { ok: false, reason: 'この駅での買収は1回まで' };
  const city = data.cities.find((c) => c.id === cityId);
  if (!city || !city.properties.some((p) => p.id === propertyId)) {
    return { ok: false, reason: 'property does not belong to this city' };
  }
  const quote = buyoutQuote(data, state, propertyId);
  if (!quote) return { ok: false, reason: 'この物件はまだ誰のものでもない' };
  if (quote.ownerId === playerId) return { ok: false, reason: '自分の物件は買収できない' };
  const player = state.players[playerId];
  if (!player || player.cash < quote.price) return { ok: false, reason: 'not enough cash' };
  return { ok: true, quote };
}

/**
 * checkBuyout が ok のときに呼ぶ。代金の移動・所有者の変更・演出（fx）をまとめて行う。
 * 独占が崩れた場合は独占破壊のナレーション、買い手が独占を完成させた場合は独占演出を出す。
 */
export function applyBuyout(
  data: GameData,
  state: GameState,
  fx: Fx[],
  playerId: number,
  quote: BuyoutQuote,
): void {
  const player = state.players[playerId];
  const owner = state.players[quote.ownerId];
  if (!player || !owner) return;
  const ref = findProperty(data, quote.propertyId);
  player.cash -= quote.price;
  owner.cash += quote.price;
  state.owner[quote.propertyId] = playerId;

  fx.push({
    t: 'buyout',
    playerId,
    fromId: owner.id,
    propertyId: quote.propertyId,
    amount: quote.price,
    brokeMonopoly: quote.brokeMonopoly,
  });
  fx.push({ t: 'cash', playerId, delta: -quote.price, reason: '買収' });
  fx.push({ t: 'cash', playerId: owner.id, delta: quote.price, reason: '買収' });
  fx.push({ t: 'say', speaker: 'narrator', text: NARRATION.buyout });
  sayCharacterLine(data, state, owner.id, 'piper_hit', fx);
  fx.push({
    t: 'toast',
    text: `${player.name} が ${owner.name} の ${ref?.property.name ?? quote.propertyId} を ${Math.round(quote.price)} 億で買収！`,
  });
  if (quote.brokeMonopoly) {
    fx.push({ t: 'say', speaker: 'narrator', text: NARRATION.monopolyBreak });
    fx.push({ t: 'toast', text: `${ref?.city.nameJa ?? ''} の独占が崩れた！` });
  }
  if (ref && monopolises(data, state, playerId, ref.cityId)) {
    fx.push({ t: 'buy', playerId, propertyId: quote.propertyId, monopoly: true });
    fx.push({ t: 'toast', text: `${ref.city.nameJa} を独占！ 決算収益が2倍になる。` });
    sayCharacterLine(data, state, playerId, 'monopoly', fx);
  }
}

// ---------------------------------------------------------------- CPU

/**
 * CPU の買収判断（Lv2 以上）。
 * 自分の独占が完成する / 首位の独占が崩れる / 利回りが高い、のいずれかで買う。
 * 買収後も現金の余力を残す。
 */
export function chooseBuyoutAction(data: GameData, state: GameState, player: PlayerState): Action | null {
  const phase = state.phase;
  if (phase.t !== 'buy' || phase.boughtOut === true) return null;
  if (player.cpuLevel < 2) return null;
  const city = data.cities.find((c) => c.id === phase.cityId);
  if (!city || city.properties.length === 0) return null;
  const leader = leaderOf(data, state);
  const reserveRate = player.cpuLevel >= 3 ? 0.2 : 0.3;

  interface Candidate {
    propertyId: string;
    score: number;
  }
  const candidates: Candidate[] = [];
  for (const property of city.properties) {
    const quote = buyoutQuote(data, state, property.id);
    if (!quote || quote.ownerId === player.id) continue;
    if (player.cash < quote.price) continue;
    if (player.cash - quote.price < player.cash * reserveRate) continue;
    const completesOwn =
      ownCount(data, state, player.id, city.id) === city.properties.length - 1;
    const breaksLeader = quote.brokeMonopoly && quote.ownerId === leader;
    const highYield = property.yieldPct >= 6;
    if (!completesOwn && !breaksLeader && !highYield) continue;
    let score = property.yieldPct * 10 - quote.price * 0.01;
    if (completesOwn) score += 1000;
    if (breaksLeader) score += 500;
    candidates.push({ propertyId: property.id, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.propertyId.localeCompare(b.propertyId)));
  return { t: 'buyout', propertyId: candidates[0].propertyId };
}

/**
 * 下剋上カードと敵対的買収の CPU 使用判断。
 * - 下剋上: 最下位で、奪える額が意味のある大きさのとき
 * - 買収カード: 独占完成 / 首位の独占破壊 / 高利回り物件（現金の余力を残す）
 */
export function chooseShowdownCardAction(
  data: GameData,
  state: GameState,
  player: PlayerState,
): Action | null {
  if (player.cpuLevel < 2) return null;
  if (state.phase.t !== 'turn_start') return null;
  const hand = new Set(player.cards);

  if (hand.has(UNDERDOG_CARD_ID) && canUseUnderdog(data, state, player.id)) {
    const gain = underdogShare(data, state, player.id);
    if (gain >= 15) return { t: 'use_card', cardId: UNDERDOG_CARD_ID };
  }

  if (hand.has('takeover')) {
    const options = takeoverOptions(data, state, player);
    const best = options.length > 0 ? chooseTakeoverTarget(data, state, player, options) : null;
    if (best) return { t: 'use_card', cardId: 'takeover' };
  }
  return null;
}

/** `card_target` の `p:<propertyId>` 候補（エンジンの takeover と同じ条件）。 */
export function takeoverOptions(data: GameData, state: GameState, player: PlayerState): string[] {
  const out: string[] = [];
  for (const city of data.cities) {
    for (const property of city.properties) {
      const owner = state.owner[property.id];
      if (owner === undefined || owner === player.id) continue;
      if (player.cash >= currentPrice(data, state, property.id) * BUYOUT_MULT) out.push(`p:${property.id}`);
    }
  }
  return out.sort();
}

/**
 * 敵対的買収の対象選び（UI の CPU 用）。
 * 独占完成 > 首位の独占破壊 > 高利回り、で選び、現金の余力が残らない対象は避ける。
 */
export function chooseTakeoverTarget(
  data: GameData,
  state: GameState,
  player: PlayerState,
  options: string[],
): string | null {
  const leader = leaderOf(data, state);
  const reserveRate = player.cpuLevel >= 3 ? 0.15 : 0.25;
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const option of options) {
    if (!option.startsWith('p:')) continue;
    const propertyId = option.slice(2);
    const ref = findProperty(data, propertyId);
    const ownerId = state.owner[propertyId];
    if (!ref || ownerId === undefined) continue;
    const cost = currentPrice(data, state, propertyId) * BUYOUT_MULT;
    if (player.cash < cost) continue;
    if (player.cash - cost < player.cash * reserveRate) continue;
    const completesOwn = ownCount(data, state, player.id, ref.cityId) === ref.city.properties.length - 1;
    const breaksLeader = monopolises(data, state, ownerId, ref.cityId) && ownerId === leader;
    const highYield = ref.property.yieldPct >= 6;
    // 首位から奪う物件は、利回りが並でも価値がある（攻めの一手）。
    const fromLeader = ownerId === leader && ref.property.yieldPct >= 5;
    if (!completesOwn && !breaksLeader && !highYield && !fromLeader) continue;
    let score = ref.property.yieldPct - cost * 0.001;
    if (completesOwn) score += 1000;
    if (breaksLeader) score += 500;
    if (fromLeader) score += 60;
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best;
}