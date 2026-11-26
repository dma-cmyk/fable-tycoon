// 寄り道依頼（fun overhaul 2026-11-26 第2弾）。
//
// 目的地が遠い区間の「青一択」を崩すための小目標。都市に 6〜14 歩で寄れる依頼を出し、
// 最初にその駅へ「止まった」人が報酬を受け取る。通過は無効（目的地との差別化）。
// ここにある判定はすべて純粋で決定的。乱数は state.rng だけを使う。

import type { Fx, GameData, GameState, MoveOption, PlayerState } from './types';
import { distancesFrom, getGraph, nodeForCity } from './graph';
import { destinationBonus } from './economy';
import { destinationBonusMultiplier } from './showdown';
import { effectiveDistance, nodeRealm } from './realm';
import { nextRandom, pickOne, weightedPick } from './rng';

/** 依頼都市は「2 人以上が 6〜14 歩で止まれる」駅だけ。 */
export const ERRAND_MIN_STEPS = 6;
export const ERRAND_MAX_STEPS = 14;
/** 誰も達成しないまま 8 ラウンド過ぎたら引き直す。 */
export const ERRAND_MAX_ROUNDS = 8;
/** 報酬は同じ距離の目的地ボーナスの 35〜45%。 */
export const ERRAND_SHARE_MIN = 0.35;
export const ERRAND_SHARE_MAX = 0.45;

/**
 * 依頼主ごとの固定の童話のお使い。1 人 1 件。
 * 48 文字キャラ全員分を `characters.json` の id で引く（未知の id は汎用の文言に落とす）。
 */
export const ERRAND_TITLES: Readonly<Record<string, string>> = {
  momotaro: '桃太郎の頼み：鬼ヶ島の下見',
  momo_dog: '犬の頼み：きびだんごを届けて',
  momo_monkey: '猿の頼み：桃の数をかぞえて',
  momo_pheasant: 'キジの頼み：鬼の偵察',
  aka_oni: '赤鬼の頼み：泣き虫をなぐさめて',
  kintaro: '金太郎の頼み：熊の背中を洗って',
  urashima: '浦島太郎の頼み：玉手箱を届けて',
  kaguya: 'かぐや姫の頼み：月への手紙',
  issun: '一寸法師の頼み：針の刀を研いで',
  bunbuku: 'たぬきの頼み：茶釜を返して',
  wukong: '孫悟空の頼み：仙桃を届けて',
  sinbad: 'シンドバッドの頼み：七つ目の港へ',
  aladdin: 'アラジンの頼み：ランプを磨いて',
  lamp_genie: '魔人の頼み：願い事を集めて',
  ali_baba: 'アリババの頼み：合言葉を届けて',
  anansi: 'アナンシの頼み：知恵の壺を探して',
  alice: 'アリスの頼み：白ウサギを追って',
  white_rabbit: '白ウサギの頼み：懐中時計を直して',
  cheshire: 'チェシャ猫の頼み：笑い方を教えて',
  heart_queen: '女王の頼み：タルトを焼いて',
  mad_hatter: '帽子屋の頼み：お茶会の席を確保',
  naked_emperor: '王様の頼み：見えない服を仕立てて',
  pinocchio: 'ピノキオの頼み：鼻を短くして',
  puss: '長靴の猫の頼み：王様に贈り物',
  red_hood: '赤ずきんのお使い：ワインを届けて',
  wolf: 'オオカミの頼み：森の道を案内して',
  granny: 'おばあさんの頼み：毛糸を買ってきて',
  gretel: 'グレーテルの頼み：お菓子を届けて',
  candy_witch: '魔女の頼み：砂糖を買い出し',
  rumpel: 'ルンペルの頼み：名前を当てて',
  jack: 'ジャックの頼み：豆の種を届けて',
  giant: '巨人の頼み：金の卵を探して',
  cinderella: 'シンデレラの依頼：ガラスの靴を探して',
  stepmother: '継母の頼み：舞踏会の招待状',
  stepsister: '義姉の頼み：ドレスを借りて',
  snow_white: '白雪姫の頼み：毒りんごを捨てて',
  evil_queen: '王妃の頼み：鏡を磨いて',
  dwarf: '小人の頼み：鉱石を届けて',
  mermaid: '人魚姫の頼み：声を届けて',
  ugly_duckling: 'アヒルの子の頼み：白鳥を探して',
  ant: 'アリの頼み：砂糖を運んで',
  grasshopper: 'キリギリスの頼み：冬支度を手伝って',
  golden_goose: 'ガチョウの頼み：金の卵を届けて',
  baba_yaga: 'バーバの頼み：臼を返して',
  tortoise: 'カメの頼み：ウサギに手紙を',
  thumbelina: 'おやゆび姫の頼み：花の露を集めて',
  robin_hood: 'ロビンの頼み：貧しい家へ配達',
  kappa: '河童の頼み：きゅうりを届けて',
};

/** 依頼名。未知のキャラクターでも壊れないよう汎用の文言に落とす。 */
export function errandTitleFor(characterId: string, nameJa: string): string {
  return ERRAND_TITLES[characterId] ?? `${nameJa}の頼み：届け物`;
}

/**
 * 依頼の報酬。同じ距離の目的地ボーナス × `share`（0.35〜0.45）。
 * 最終年は目的地と同じく 2 倍になる。
 */
export function errandBonus(
  state: Pick<GameState, 'year' | 'month' | 'config'>,
  distance: number,
  share: number,
): number {
  return Math.round(destinationBonus(state, distance) * share * destinationBonusMultiplier(state));
}

interface ErrandCandidate {
  cityId: string;
  /** 対象プレイヤーのうち最も近い人までの歩数（報酬の基準）。 */
  minDistance: number;
  inRange: number;
  /** 誰かの「今いる場所 → 目的地」の通り道にある。 */
  onRoute: boolean;
  /** どのプレイヤーも今いない地方（寄り道する価値のある空白地帯）。 */
  quietRegion: boolean;
}

/** 依頼を置ける都市を選ぶ。置けなければ null（1 人プレイなど）。 */
export function pickErrandCity(
  data: GameData,
  state: GameState,
): { cityId: string; minDistance: number } | null {
  if (state.players.length < 2) return null;
  const destNode = nodeForCity(data, state.destination);
  if (!destNode) return null;
  const destDistances = distancesFrom(data, destNode);
  const currentErrand = state.errand?.cityId ?? null;

  const players = state.players;
  const playerRegions = players.map((p) => {
    const node = getGraph(data).nodes.get(p.nodeId);
    return node?.cityId ? data.cities.find((c) => c.id === node.cityId)?.region ?? null : null;
  });

  const candidates: ErrandCandidate[] = [];
  for (const city of data.cities) {
    if (city.realm !== undefined) continue;
    if (city.id === state.destination || city.id === currentErrand) continue;
    const nodeId = nodeForCity(data, city.id);
    if (!nodeId) continue;
    let inRange = 0;
    let minDistance = Infinity;
    let onRoute = false;
    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      const toCity = effectiveDistance(data, player.nodeId, nodeId);
      if (!Number.isFinite(toCity)) continue;
      if (toCity >= ERRAND_MIN_STEPS && toCity <= ERRAND_MAX_STEPS) {
        inRange += 1;
        if (toCity < minDistance) minDistance = toCity;
      }
      if (nodeRealm(data, player.nodeId) === 'world') {
        const toDest = effectiveDistance(data, player.nodeId, destNode);
        const cityToDest = destDistances.get(nodeId) ?? Infinity;
        if (toCity + cityToDest <= toDest + 2) onRoute = true;
      }
    }
    if (inRange < 2 || !Number.isFinite(minDistance)) continue;
    const quietRegion = !playerRegions.some((region) => region !== null && region === city.region);
    candidates.push({ cityId: city.id, minDistance, inRange, onRoute, quietRegion });
  }
  if (candidates.length === 0) return null;
  // 決定的な重み付き抽選。通勤路にある駅と、誰も向かっていない地方の駅を好む。
  const chosen = weightedPick(
    state,
    candidates,
    (candidate) =>
      1 +
      Math.max(0, candidate.inRange - 2) * 0.2 +
      (candidate.onRoute ? 0.6 : 0) +
      (candidate.quietRegion ? 1.6 : 0),
  );
  if (!chosen) return null;
  return { cityId: chosen.cityId, minDistance: chosen.minDistance };
}

/**
 * 依頼を 1 件引いて `state.errand` に載せ、`errand` fx を積む。
 * 乱数は「都市 → 報酬率 → 依頼主」の順に消費する（順序を変えると既存シードの再現が崩れる）。
 */
export function drawErrand(data: GameData, state: GameState, fx: Fx[]): void {
  const picked = pickErrandCity(data, state);
  if (!picked) return;
  const share = ERRAND_SHARE_MIN + nextRandom(state) * (ERRAND_SHARE_MAX - ERRAND_SHARE_MIN);
  const requester =
    data.characters.length > 0
      ? pickOne(state, data.characters)
      : { id: 'narrator', nameJa: 'ナレーター' };
  const bonus = errandBonus(state, picked.minDistance, Number(share.toFixed(3)));
  state.errand = {
    cityId: picked.cityId,
    bonus,
    requester: requester.id,
    title: errandTitleFor(requester.id, requester.nameJa),
    drawnRound: state.round,
  };
  fx.push({
    t: 'errand',
    cityId: picked.cityId,
    bonus,
    requester: requester.id,
    title: state.errand.title,
  });
}

/**
 * 止まった駅が依頼都市なら達成。報酬を払い、次の依頼を引く。
 * 取り立て屋は動かさない（目的地一番乗りとの差別化）。戻り値は達成したか。
 */
export function claimErrand(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
): boolean {
  const errand = state.errand;
  if (!errand) return false;
  const node = getGraph(data).nodes.get(player.nodeId);
  if (!node || node.kind !== 'city' || node.cityId !== errand.cityId) return false;
  player.cash += errand.bonus;
  fx.push({ t: 'errand_done', playerId: player.id, cityId: errand.cityId, bonus: errand.bonus });
  fx.push({ t: 'cash', playerId: player.id, delta: errand.bonus, reason: '寄り道の依頼' });
  drawErrand(data, state, fx);
  return true;
}

/**
 * 月替わり（`advanceTurn`）。依頼が 8 ラウンド放置されていたら引き直す。
 * 依頼が無いとき（開始時に置けなかった等）は、置けるようになっていれば出す。
 */
export function maybeRedrawErrand(data: GameData, state: GameState, fx: Fx[]): void {
  const errand = state.errand;
  if (!errand) {
    drawErrand(data, state, fx);
    return;
  }
  if (state.round - errand.drawnRound < ERRAND_MAX_ROUNDS) return;
  const city = data.cities.find((c) => c.id === errand.cityId);
  fx.push({
    t: 'toast',
    text: `📜 ${city?.nameJa ?? errand.cityId} の依頼は誰も受けず、立ち消えになった。`,
  });
  drawErrand(data, state, fx);
}

/** 依頼都市の盤面ノード。 */
export function errandCityNode(data: GameData, state: Pick<GameState, 'errand'>): string | null {
  return state.errand ? nodeForCity(data, state.errand.cityId) : null;
}

/** ある地点から依頼都市までの歩数（不明は null）。 */
export function errandStepsFor(
  data: GameData,
  state: Pick<GameState, 'errand'>,
  fromNodeId: string,
): number | null {
  const node = errandCityNode(data, state);
  if (!node) return null;
  const steps = effectiveDistance(data, fromNodeId, node);
  return Number.isFinite(steps) ? steps : null;
}

/**
 * CPU（Lv2/Lv3）の進路評価に足す寄り道の価値。小さいほど良い（目的地距離と同じ符号）。
 * 報酬を「目的地ボーナスの 1 歩あたりの価値」で歩数に換算し、寄り道の損を差し引く。
 */
export function errandMoveBias(
  data: GameData,
  state: GameState,
  player: PlayerState,
  option: MoveOption,
): number {
  const errand = state.errand;
  if (!errand || player.cpuLevel < 2) return 0;
  const errandNode = nodeForCity(data, errand.cityId);
  if (!errandNode) return 0;
  const destNode = nodeForCity(data, state.destination);
  const destDistance = destNode ? effectiveDistance(data, player.nodeId, destNode) : 0;
  if (!Number.isFinite(destDistance) || destDistance <= 0) return 0;
  const weight = player.cpuLevel >= 3 ? 1 : 0.6;
  // 目的地ボーナス 1 歩あたりの価値（億円）。同じ年倍率なので依頼と直接比べられる。
  const perStep = destinationBonus(state, destDistance) / destDistance;
  if (option.nodeId === errandNode) {
    return -weight * (errand.bonus / Math.max(0.5, perStep));
  }
  // 目的地がまだ遠いときだけ、依頼へ近づく進路を少し優遇する（寄り道の「匂い」）。
  if (destDistance >= 16) {
    const toErrand = effectiveDistance(data, option.nodeId, errandNode);
    if (toErrand <= 3) return -weight * 0.5 * (4 - toErrand);
  }
  return 0;
}