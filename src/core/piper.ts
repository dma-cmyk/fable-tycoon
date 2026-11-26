// ハーメルンの取り立て屋 (DESIGN §2.4) — 2026-11 fun overhaul.
//
// 憑くたびに変身ルーレット（Lv1 72% / Lv2 20% / Lv3 8%）。
// 毎月、憑かれている相手に対して変身・退散ロール（Lv1→2 15%、Lv2→3 10%、Lv3 は 20% で退散/縮小）。
// 憑かれた手番数 8 / 16 で強制エスカレーション。
// 被害は所持金ではなく純資産に比例する:
//   Lv1 3〜6%（現金取り立て・物件没収・カード・ガラクタ商材・1 回休み）
//   Lv2 2 倍
//   Lv3 災害ルーレット（5〜7 種）。1 回の災害は純資産の 35% を上限にする。
// 弁護士軍団 (`shield`) は Lv1/2 を完全無効、キングは半減。`piper_charm` は数値被害を半減。
// 約 5% の手番で気まぐれな善行 (`piper_gift`) が起きる。

import type { Fx, GameData, GameState, PlayerState } from './types';
import { nextRandom, pickOne, randInt, shuffled } from './rng';
import { consumeShield, piperDiscardCount } from './cards';
import {
  characterPerk,
  currentPrice,
  monopolises,
  netWorth,
  ownedProperties,
  sellPrice,
  yearScale,
} from './economy';
import { nodeForCity } from './graph';
import { formatOku } from './formatMoney';
import { sayCharacterLine } from './speech';
import { effectiveDistance, realmEntryNodeId } from './realm';
import {
  PIPER_CONFISCATE_EVENT_ID,
  PIPER_CONFISCATE_NARRATION,
  PIPER_DEAL_EVENT_ID,
  PIPER_DEAL_NARRATION,
  PIPER_DISASTERS,
  PIPER_FORMS,
  PIPER_VOICE_LINES,
  piperDisasterDef,
  piperGiftDef,
  type PiperDisasterKind,
  type PiperGiftKind,
} from './piperLines';
import { piperSeizePlan, type PiperSeizePlan } from './piperSeize';

/** 憑かれた手番数。ここに達するとその姿以上へ強制エスカレートする。 */
export const PIPER_LEVEL_TURNS: readonly number[] = [8, 16];
/** 憑いた瞬間の姿: Lv1 72% / Lv2 20% / Lv3 8%。 */
export const PIPER_ATTACH_LEVEL1 = 0.72;
export const PIPER_ATTACH_LEVEL2 = 0.92;
/** 月替わりの変身確率。 */
export const PIPER_MONTH_UPGRADE_1 = 0.15;
export const PIPER_MONTH_UPGRADE_2 = 0.1;
/** キングが月替わりで退散する確率と、そのうち縮小する確率。 */
export const PIPER_MONTH_KING_LEAVE = 0.08;
export const PIPER_MONTH_KING_CHANGE = 0.2;
/** 気まぐれな善行の確率。 */
export const PIPER_GIFT_CHANCE = 0.05;
/** キングの 1 災害あたりの被害上限（純資産比）。 */
export const KING_DAMAGE_CAP = 0.35;
/** キングが地獄へ引きずり込む確率（災害ルーレットとは別枠）。 */
export const PIPER_HELL_CHANCE = 0.1;

export function piperLevelForHeldTurns(heldTurns: number): 1 | 2 | 3 {
  if (heldTurns >= PIPER_LEVEL_TURNS[1]) return 3;
  if (heldTurns >= PIPER_LEVEL_TURNS[0]) return 2;
  return 1;
}

/** 憑く瞬間の変身ルーレット。72% / 20% / 8%。 */
export function rollPiperForm(state: GameState): 1 | 2 | 3 {
  const r = nextRandom(state);
  return r < PIPER_ATTACH_LEVEL1 ? 1 : r < PIPER_ATTACH_LEVEL2 ? 2 : 3;
}

export interface TransferOptions {
  /**
   * すれ違い・笛の押し付けで憑き先が変わる場合、憑いた姿をそのまま持っていく。
   * 目的地・イベントなど「新たに憑く」場合は false（既定）でルーレットを振り直す。
   */
  keepForm?: boolean;
}

/**
 * Moves the piper to `holder` (null = unassigned) and emits the attach fx.
 * A fresh attach rolls the transformation roulette; `keepForm` carries the current form.
 */
export function transferPiper(
  state: GameState,
  fx: Fx[],
  holder: number | null,
  message: string,
  options: TransferOptions = {},
): void {
  if (holder === null) {
    state.piper = { holder: null, level: 1, heldTurns: 0 };
    fx.push({ t: 'piper', holder: null, level: 1, message });
    return;
  }
  const keepForm = options.keepForm === true && state.piper.holder !== null;
  const level: 1 | 2 | 3 = keepForm ? state.piper.level : rollPiperForm(state);
  state.piper = { holder, level, heldTurns: 0 };
  fx.push({ t: 'piper', holder, level, message });
  if (!keepForm) {
    // 新たに憑くときだけ変身ルーレットを回す。すれ違い・押し付けは姿がそのまま移動する。
    fx.push({ t: 'piper_roulette', holder, from: 1, to: level });
    sayPiperVoice(state, fx, level);
  }
}

/** After a goal: the player farthest (shortest steps) from the claimed city gets the piper. */
export function assignPiperToFarthest(
  data: GameData,
  state: GameState,
  fx: Fx[],
  cityBoardNodeId: string,
  claimedBy: number,
): number | null {
  let holder: number | null = null;
  let best = -1;
  for (const player of state.players) {
    const d = effectiveDistance(data, player.nodeId, cityBoardNodeId);
    const value = Number.isFinite(d) ? d : 9999;
    if (value > best) {
      best = value;
      holder = player.id;
    }
  }
  if (holder === null) return null;
  const target = state.players[holder];
  transferPiper(
    state,
    fx,
    holder,
    `目的地から最も遠い ${target.name} に取り立て屋が憑いた！`,
  );
  sayCharacterLine(data, state, holder, 'piper_get', fx);
  if (holder === claimedBy) {
    fx.push({ t: 'toast', text: `${target.name} は一番乗りなのに取り立て屋まで背負った。世知辛い。` });
  }
  return holder;
}

/**
 * 月替わりの変身ロール。憑かれている相手（state.piper.holder）に対して振る。
 * Lv1→2 15%、Lv2→3 10%、Lv3 は 20% で「退散」8% / 「縮小」12%。
 * 変わらなかった月は何も出さない（テンポ優先）。
 */
export function runPiperMonthStart(state: GameState, fx: Fx[]): void {
  const holder = state.piper.holder;
  if (holder === null) return;
  const player = state.players[holder];
  if (!player) return;
  const level = state.piper.level;
  const roll = nextRandom(state);
  if (level === 1 && roll < PIPER_MONTH_UPGRADE_1) {
    setPiperForm(state, fx, holder, 2, `ブラック取り立て屋が目を覚ました。`);
  } else if (level === 2 && roll < PIPER_MONTH_UPGRADE_2) {
    setPiperForm(state, fx, holder, 3, `ブラック取り立て屋が王冠をかぶった。`);
  } else if (level === 3 && roll < PIPER_MONTH_KING_CHANGE) {
    if (roll < PIPER_MONTH_KING_LEAVE) {
      state.piper = { holder: null, level: 1, heldTurns: 0 };
      fx.push({
        t: 'piper',
        holder: null,
        level: 1,
        message: 'キング取り立て屋は満足して、どこかへ去っていった。',
      });
      fx.push({ t: 'toast', text: `${player.name} は取り立て屋から解放された！` });
      return;
    }
    state.piper.heldTurns = 0;
    setPiperForm(state, fx, holder, 1, 'キングは飽きて、ただの笛吹きに戻った。');
  }
}

/** Runs the holder's turn-start mischief. Returns whether the turn must be skipped. */
export function runPiperTurnStart(
  data: GameData,
  state: GameState,
  fx: Fx[],
): 'continue' | 'skip' {
  const playerId = state.current;
  if (state.piper.holder !== playerId) return 'continue';
  const player = state.players[playerId];
  if (!player) return 'continue';

  state.piper.heldTurns += 1;
  const forced = piperLevelForHeldTurns(state.piper.heldTurns);
  if (forced > state.piper.level) {
    const from = state.piper.level;
    state.piper.level = forced;
    fx.push({ t: 'piper_roulette', holder: playerId, from, to: forced });
    if (forced === 3) sayPiperVoice(state, fx, 3);
  }
  const level = state.piper.level;

  // 弁護士軍団: Lv1/2 は丸ごと無効、キングは半減（PLAN 2026-11）。
  const shielded = consumeShield(state, playerId, fx);
  if (shielded && level < 3) {
    fx.push({ t: 'toast', text: '弁護士軍団が今回の取り立てを丸ごと無効化した。' });
    return 'continue';
  }
  const scale = (shielded ? 0.5 : 1) * (characterPerk(data, state, playerId) === 'piper_charm' ? 0.5 : 1);

  // King piper rare mischief: drag the holder to hell (既存挙動を維持)。
  // 護符の有無で乱数列がずれないよう、抽選自体は必ず 1 回消費する。
  const hellRoll = nextRandom(state);
  if (level === 3 && !shielded && hellRoll < PIPER_HELL_CHANCE) {
    runDisaster(data, state, fx, playerId, 'hell_ride', scale);
    return 'continue';
  }

  // 気まぐれな善行（約 5%）。悪さの代わりにちょっといいことをする。
  if (nextRandom(state) < PIPER_GIFT_CHANCE) {
    runGift(data, state, fx, player);
    return 'continue';
  }

  if (level === 3) {
    const kind = pickOne(state, PIPER_DISASTERS).kind;
    runDisaster(data, state, fx, playerId, kind, scale);
    return 'continue';
  }

  return runMischief(data, state, fx, player, level, scale);
}

// ---------------------------------------------------------------- forms

function sayPiperVoice(state: GameState, fx: Fx[], level: 1 | 2 | 3): void {
  const lines = PIPER_VOICE_LINES[level];
  if (!lines || lines.length === 0) return;
  const form = PIPER_FORMS[level - 1];
  fx.push({ t: 'say', speaker: `npc:${form.npcId}`, text: pickOne(state, lines) });
}

/** 姿を変える。ルーレット演出と、キング昇格時だけ喋る固定台詞を出す。 */
function setPiperForm(
  state: GameState,
  fx: Fx[],
  holder: number,
  to: 1 | 2 | 3,
  message: string,
): void {
  const from = state.piper.level;
  if (from === to) return;
  state.piper.level = to;
  fx.push({ t: 'piper_roulette', holder, from, to });
  fx.push({ t: 'piper', holder, level: to, message });
  if (to === 3) sayPiperVoice(state, fx, 3);
}

// ---------------------------------------------------------------- wealth

/**
 * 純資産から `demand` 億を取り立てる。現金が足りなければ物件を安い順に強制売却して現金化する。
 * 戻り値は実際に取れた額（億）。
 *
 * 注意: 強制売却の代金はそのまま取り立てられるので、現金残高の純変化は -戻り値 と一致しない
 * （物件が現金に変わった分だけ相殺される）。UI の cash fx には「失った富」を出す。
 */
function takeWealth(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  demand: number,
): { paid: number; propertyIds: string[] } {
  if (!(demand > 0)) return { paid: 0, propertyIds: [] };
  const propertyIds: string[] = [];
  if (player.cash < demand) {
    const owned = ownedProperties(data, state, player.id).sort((a, b) => {
      const pa = sellPrice(data, state, a.property.id);
      const pb = sellPrice(data, state, b.property.id);
      return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
    });
    for (const ref of owned) {
      if (player.cash >= demand) break;
      const price = sellPrice(data, state, ref.property.id);
      if (!(price > 0)) continue;
      delete state.owner[ref.property.id];
      player.cash += price;
      propertyIds.push(ref.property.id);
      fx.push({ t: 'sell', playerId: player.id, propertyId: ref.property.id, amount: price });
    }
  }
  const paid = Math.min(demand, Math.max(0, player.cash));
  player.cash -= paid;
  return { paid, propertyIds };
}

/** 純資産の `pct`%（0.03 = 3%）を要求額にする。 */
function demandFromNetWorth(data: GameData, state: GameState, playerId: number, pct: number): number {
  const worth = netWorth(data, state, playerId);
  return Math.max(0, worth) * Math.max(0, pct);
}

// ---------------------------------------------------------------- Lv1 / Lv2 mischief

function runMischief(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  level: 1 | 2,
  scale: number,
): 'continue' | 'skip' {
  const playerId = player.id;
  const form = PIPER_FORMS[level - 1];
  const kind = randInt(state, 0, 4);

  if (kind === 0) {
    runCashMischief(data, state, fx, player, level, scale);
  } else if (kind === 1) {
    // 没収は純資産の 12%（ブラックは 20%）まで。上限内に物件がなければ現金の取り立てへ。
    const plan = piperSeizePlan(data, state, player, level);
    if (plan.propertyIds.length === 0) {
      runCashMischief(data, state, fx, player, level, scale);
    } else if (player.isCpu) {
      if (
        piperConfiscateCpuChoice(data, state, player) === 1 &&
        payConfiscationDeal(data, state, fx, player, plan.propertyIds, plan.dealCost)
      ) {
        sayCharacterLine(data, state, playerId, 'piper_hit', fx);
        fx.push({
          t: 'toast',
          text: `${player.name} は示談金 ${formatOku(plan.dealCost)}を払って物件を守った。`,
        });
      } else {
        seizeProperties(data, state, fx, player, plan.propertyIds, form.nameJa);
      }
    } else {
      // 人間には「物件を差し出す / 示談金を払う」の 2 択を出す。
      openPiperConfiscation(data, state, fx, playerId, form.nameJa, plan);
      return 'continue';
    }
  } else if (kind === 2) {
    const count = Math.min(piperDiscardCount(state), player.cards.length);
    if (count === 0) {
      fx.push({ t: 'toast', text: `${form.nameJa}は捨てるカードがなく、渋々帰った。` });
    } else {
      for (const cardId of shuffled(state, player.cards).slice(0, count)) {
        const i = player.cards.indexOf(cardId);
        if (i >= 0) player.cards.splice(i, 1);
      }
      sayCharacterLine(data, state, playerId, 'piper_hit', fx);
      fx.push({ t: 'toast', text: `${form.nameJa}がカードを${count}枚、勝手に捨てた。` });
    }
  } else if (kind === 3) {
    const cost = 10 * level * scale;
    player.cash -= cost;
    fx.push({ t: 'cash', playerId, delta: -cost, reason: '取り立て' });
    sayCharacterLine(data, state, playerId, 'piper_hit', fx);
    fx.push({
      t: 'toast',
      text: `${form.nameJa}に「金運ブレスレット」を${formatOku(cost)}で買わされた。`,
    });
  } else if (!player.isCpu) {
    // 人間には「休む」か「示談金を払って動く」の 2 択を出す（操作の余地のない待ち時間にしない）。
    openPiperDeal(state, fx, playerId, form.nameJa);
    return 'continue';
  } else {
    player.skipTurns += 1;
    sayCharacterLine(data, state, playerId, 'piper_hit', fx);
    fx.push({ t: 'toast', text: `${form.nameJa}の嫌がらせで1回休み。` });
    return 'skip';
  }

  if (player.cash < 0) {
    fx.push({ t: 'toast', text: `${player.name} は借金を抱えた。` });
  }
  return 'continue';
}

/** 純資産の 3〜6%（Lv2 は 2 倍）を現金で取り立てる。物件没収の代替にも使う。 */
function runCashMischief(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  level: 1 | 2,
  scale: number,
): void {
  const form = PIPER_FORMS[level - 1];
  const pct = randInt(state, 3, 6);
  const demand =
    demandFromNetWorth(data, state, player.id, (pct / 100) * (level === 2 ? 2 : 1)) * scale;
  const { paid } = takeWealth(data, state, fx, player, demand);
  fx.push({ t: 'cash', playerId: player.id, delta: -paid, reason: '取り立て' });
  sayCharacterLine(data, state, player.id, 'piper_hit', fx);
  fx.push({
    t: 'toast',
    text: `${form.nameJa}が純資産の${pct}%相当を持っていった。足りない分は物件が売られた。`,
  });
}

/** 上限内の物件を二束三文（2 割）で没収する。 */
function seizeProperties(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  propertyIds: readonly string[],
  formName: string,
): void {
  let count = 0;
  for (const propertyId of propertyIds) {
    if (state.owner[propertyId] !== player.id) continue;
    const value = Math.max(0, currentPrice(data, state, propertyId));
    const proceeds = value * 0.2;
    delete state.owner[propertyId];
    player.cash += proceeds;
    fx.push({ t: 'sell', playerId: player.id, propertyId, amount: proceeds });
    fx.push({ t: 'cash', playerId: player.id, delta: -(value - proceeds), reason: '取り立て' });
    count += 1;
  }
  if (count === 0) {
    fx.push({ t: 'toast', text: `${formName}は没収する物件を見失った。` });
    return;
  }
  sayCharacterLine(data, state, player.id, 'piper_hit', fx);
  fx.push({ t: 'toast', text: `${formName}が物件${count}件を二束三文で没収した。` });
}

/**
 * 示談金を払って物件を守る。現金で足りなければ、守る物件以外を売って工面する。
 * 工面できなければ何も売らずに false（呼び出し側が物件を差し出す）。
 */
function payConfiscationDeal(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  protectedIds: readonly string[],
  cost: number,
): boolean {
  const guarded = new Set(protectedIds);
  if (player.cash < cost) {
    const sellable = ownedProperties(data, state, player.id)
      .filter((ref) => !guarded.has(ref.property.id))
      .map((ref) => ({
        id: ref.property.id,
        price: Math.max(0, sellPrice(data, state, ref.property.id)),
      }))
      .filter((item) => item.price > 0)
      .sort((a, b) => (a.price !== b.price ? a.price - b.price : a.id.localeCompare(b.id)));
    const available = sellable.reduce((sum, item) => sum + item.price, 0);
    if (player.cash + available < cost) return false;
    for (const item of sellable) {
      if (player.cash >= cost) break;
      delete state.owner[item.id];
      player.cash += item.price;
      fx.push({ t: 'sell', playerId: player.id, propertyId: item.id, amount: item.price });
    }
  }
  player.cash -= cost;
  fx.push({ t: 'cash', playerId: player.id, delta: -cost, reason: '取り立て' });
  return true;
}

/** CPU の没収示談: 現金で示談金を払えるなら守り、足りなければ物件を差し出す。 */
export function piperConfiscateCpuChoice(
  data: GameData,
  state: GameState,
  player: PlayerState,
): number {
  const level: 1 | 2 = state.piper.level === 2 ? 2 : 1;
  const plan = piperSeizePlan(data, state, player, level);
  if (plan.propertyIds.length === 0) return 0;
  return player.cash >= plan.dealCost ? 1 : 0;
}

/** 物件 id から表示名を引く（示談のトースト用）。 */
function propertyNameJa(data: GameData, propertyId: string): string {
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (property.id === propertyId) return property.name;
    }
  }
  return propertyId;
}

/** 「物件を差し出す / 示談金を払う」の 2 択を、既存の event フェーズで開く。 */
function openPiperConfiscation(
  data: GameData,
  state: GameState,
  fx: Fx[],
  playerId: number,
  formName: string,
  plan: PiperSeizePlan,
): void {
  state.activeEventId = PIPER_CONFISCATE_EVENT_ID;
  state.phase = { t: 'event', eventId: PIPER_CONFISCATE_EVENT_ID };
  fx.push({ t: 'event_open', eventId: PIPER_CONFISCATE_EVENT_ID, playerId });
  fx.push({ t: 'say', speaker: 'narrator', text: PIPER_CONFISCATE_NARRATION });
  const names = plan.propertyIds.map((id) => propertyNameJa(data, id)).join('・');
  fx.push({
    t: 'toast',
    text: `${formName}が「${names}をよこせ。示談なら ${formatOku(plan.dealCost)}だ」と迫っている。`,
  });
}

export type PiperConfiscationOutcome = 'surrender' | 'pay';

/**
 * 物件没収の示談を解決する（engine の onEventChoice から呼ぶ）。
 * index 0 = 物件を差し出す、index 1 = 示談金を払って守る（足りなければ差し出す）。
 * 対象は開いたときと同じ決定手順で引き直す（乱数を使わない）。
 */
export function applyPiperConfiscationDeal(
  data: GameData,
  state: GameState,
  fx: Fx[],
  choiceIndex: number,
): PiperConfiscationOutcome {
  const player = state.players[state.current];
  if (!player) return 'surrender';
  const level: 1 | 2 = state.piper.level === 2 ? 2 : 1;
  const plan = piperSeizePlan(data, state, player, level);
  const form = PIPER_FORMS[level - 1];
  if (plan.propertyIds.length === 0) {
    fx.push({ t: 'toast', text: `${form.nameJa}は没収する物件を見失った。` });
    return 'surrender';
  }
  if (choiceIndex >= 1) {
    if (payConfiscationDeal(data, state, fx, player, plan.propertyIds, plan.dealCost)) {
      sayCharacterLine(data, state, player.id, 'piper_hit', fx);
      fx.push({
        t: 'toast',
        text: `${player.name} は示談金 ${formatOku(plan.dealCost)}を払って、物件を守った。`,
      });
      return 'pay';
    }
    fx.push({ t: 'toast', text: '現金も売れる物件も足りず、示談は成立しなかった。' });
  }
  seizeProperties(data, state, fx, player, plan.propertyIds, form.nameJa);
  return 'surrender';
}

/** 「1回休み」の代わりに示談金を払う 2 択を、既存の event フェーズで開く。 */
function openPiperDeal(state: GameState, fx: Fx[], playerId: number, formName: string): void {
  state.activeEventId = PIPER_DEAL_EVENT_ID;
  state.phase = { t: 'event', eventId: PIPER_DEAL_EVENT_ID };
  fx.push({ t: 'event_open', eventId: PIPER_DEAL_EVENT_ID, playerId });
  fx.push({ t: 'say', speaker: 'narrator', text: PIPER_DEAL_NARRATION });
  fx.push({ t: 'toast', text: `${formName}「休むか、示談か。選べ。」` });
}

export type PiperDealOutcome = 'rest' | 'pay';

/**
 * 示談イベントの選択を解決する（engine の onEventChoice から呼ぶ）。
 * index 0 = 休む（この手番を失う）、index 1 = 示談金（純資産の 5% / ブラックは 10%）を払って続行。
 */
export function applyPiperDeal(
  data: GameData,
  state: GameState,
  fx: Fx[],
  choiceIndex: number,
): PiperDealOutcome {
  const player = state.players[state.current];
  if (!player) return 'rest';
  if (choiceIndex <= 0) {
    player.skipTurns += 1;
    fx.push({ t: 'toast', text: `${player.name} は取り立て屋の要求を飲んで、この手番を休んだ。` });
    return 'rest';
  }
  const pct = state.piper.level === 2 ? 0.1 : 0.05;
  const demand = demandFromNetWorth(data, state, player.id, pct);
  const { paid } = takeWealth(data, state, fx, player, demand);
  fx.push({ t: 'cash', playerId: player.id, delta: -paid, reason: '示談金' });
  sayCharacterLine(data, state, player.id, 'piper_hit', fx);
  fx.push({
    t: 'toast',
    text: `${player.name} は示談金 ${formatOku(paid)}を払って、そのまま動く。`,
  });
  return 'pay';
}

// ---------------------------------------------------------------- King disasters

interface DisasterOutcome {
  amount: number;
  propertyIds: string[];
}

/** 物件を没収して 2 割で売り払う。戻り値は失った富（額面 − 手取り）。 */
function confiscate(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  propertyIds: readonly string[],
  saleRate: number,
): number {
  let loss = 0;
  for (const propertyId of propertyIds) {
    if (state.owner[propertyId] !== player.id) continue;
    const value = Math.max(0, currentPrice(data, state, propertyId));
    const proceeds = value * saleRate;
    delete state.owner[propertyId];
    player.cash += proceeds;
    fx.push({ t: 'sell', playerId: player.id, propertyId, amount: proceeds });
    loss += value - proceeds;
  }
  return loss;
}

/** キングの災害 1 件。`cap` は被害上限（億、護符と piper_charm 適用後）。 */
function applyDisaster(
  data: GameData,
  state: GameState,
  fx: Fx[],
  player: PlayerState,
  kind: PiperDisasterKind,
  cap: number,
  scale: number,
): DisasterOutcome {
  const playerId = player.id;
  /**
   * 被害は「純資産 × 35%」で頭打ちにし、さらに `scale`（弁護士軍団 0.5 / piper_charm 0.5）を掛ける。
   * 物件没収では差額を現金で返し、実効被害がちょうど `amount` になるようにする。
   */
  const settlePropertyLoss = (loss: number, propertyIds: string[]): DisasterOutcome => {
    const amount = Math.min(loss, cap) * scale;
    if (loss > amount) player.cash += loss - amount;
    return { amount, propertyIds };
  };
  switch (kind) {
    case 'city_fire_sale': {
      // 物件が一番多い都市（同数なら価値が高い方）の半数の物件が二束三文で売られる。
      const byCity = new Map<string, { id: string; value: number }[]>();
      for (const ref of ownedProperties(data, state, playerId)) {
        const list = byCity.get(ref.cityId) ?? [];
        list.push({ id: ref.property.id, value: currentPrice(data, state, ref.property.id) });
        byCity.set(ref.cityId, list);
      }
      if (byCity.size === 0) return { amount: 0, propertyIds: [] };
      let targetCity = '';
      let bestCount = -1;
      let bestValue = -1;
      for (const [cityId, list] of [...byCity].sort((a, b) => a[0].localeCompare(b[0]))) {
        const value = list.reduce((sum, item) => sum + item.value, 0);
        if (list.length > bestCount || (list.length === bestCount && value > bestValue)) {
          targetCity = cityId;
          bestCount = list.length;
          bestValue = value;
        }
      }
      const list = (byCity.get(targetCity) ?? []).sort(
        (a, b) => a.value - b.value || a.id.localeCompare(b.id),
      );
      const take = Math.max(1, Math.ceil(list.length / 2));
      const propertyIds = list.slice(0, take).map((item) => item.id);
      return settlePropertyLoss(confiscate(data, state, fx, player, propertyIds, 0.2), propertyIds);
    }
    case 'charity_gala': {
      const amount = Math.min(Math.max(0, player.cash) * 0.5, cap) * scale;
      player.cash -= amount;
      return { amount, propertyIds: [] };
    }
    case 'trophy_sale': {
      const owned = ownedProperties(data, state, playerId).sort((a, b) => {
        const pa = currentPrice(data, state, a.property.id);
        const pb = currentPrice(data, state, b.property.id);
        return pa !== pb ? pb - pa : a.property.id.localeCompare(b.property.id);
      });
      const ref = owned[0];
      if (!ref) return { amount: 0, propertyIds: [] };
      return settlePropertyLoss(confiscate(data, state, fx, player, [ref.property.id], 0.2), [
        ref.property.id,
      ]);
    }
    case 'abduction': {
      const cityId = farthestCityId(data, player.nodeId);
      const node = cityId ? nodeForCity(data, cityId) : null;
      if (node) {
        player.nodeId = node;
        player.prevNodeId = null;
        fx.push({ t: 'warp', playerId, nodeId: node, via: 'event' });
      }
      const demand = Math.min(demandFromNetWorth(data, state, playerId, 0.05), cap) * scale;
      const { paid, propertyIds } = takeWealth(data, state, fx, player, demand);
      return { amount: paid, propertyIds };
    }
    case 'card_confiscation': {
      const count = player.cards.length;
      player.cards.length = 0;
      const demand = Math.min(demandFromNetWorth(data, state, playerId, 0.03), cap) * scale;
      const { paid, propertyIds } = takeWealth(data, state, fx, player, demand);
      if (count > 0) fx.push({ t: 'toast', text: `手札${count}枚が全部押収された。` });
      return { amount: paid, propertyIds };
    }
    case 'king_tax': {
      // 全物件に 10% の課税。合計額面の 10% を上限内で現金徴収する。
      const total = ownedProperties(data, state, playerId).reduce(
        (sum, ref) => sum + Math.max(0, currentPrice(data, state, ref.property.id)),
        0,
      );
      const demand = Math.min(total * 0.1, cap) * scale;
      const { paid, propertyIds } = takeWealth(data, state, fx, player, demand);
      return { amount: paid, propertyIds };
    }
    case 'hell_ride': {
      const hell = realmEntryNodeId(data, 'hell');
      if (hell) {
        player.nodeId = hell;
        player.prevNodeId = null;
        fx.push({ t: 'warp', playerId, nodeId: hell, via: 'realm' });
      }
      const demand = Math.min(demandFromNetWorth(data, state, playerId, 0.04), cap) * scale;
      const { paid, propertyIds } = takeWealth(data, state, fx, player, demand);
      return { amount: paid, propertyIds };
    }
    default: {
      const never: never = kind;
      void never;
      return { amount: 0, propertyIds: [] };
    }
  }
}

function runDisaster(
  data: GameData,
  state: GameState,
  fx: Fx[],
  holder: number,
  kind: PiperDisasterKind,
  scale: number,
): void {
  const player = state.players[holder];
  if (!player) return;
  const cap = demandFromNetWorth(data, state, holder, KING_DAMAGE_CAP);
  const outcome = applyDisaster(data, state, fx, player, kind, cap, scale);
  const def = piperDisasterDef(kind);
  fx.push({
    t: 'piper_disaster',
    holder,
    kind,
    title: def.title,
    amount: outcome.amount,
    propertyIds: outcome.propertyIds,
  });
  if (outcome.amount > 0) {
    fx.push({ t: 'cash', playerId: holder, delta: -outcome.amount, reason: 'キング被害' });
  }
  sayCharacterLine(data, state, holder, 'piper_hit', fx);
  fx.push({ t: 'say', speaker: 'narrator', text: def.narration });
  fx.push({
    t: 'toast',
    text: `${def.title}！ ${player.name} は ${formatOku(outcome.amount)}を失った。`,
  });
  if (player.cash < 0) {
    fx.push({ t: 'toast', text: `${player.name} は借金を抱えた。` });
  }
}

// ---------------------------------------------------------------- rare gift

/**
 * 善行の上限（億円）。気まぐれは「ちょっと得した」で止める。上限が無いと、たまたま立っていた
 * 駅の最高額物件（バブル中なら数百〜数千億）が無償で渡り、順位が一発で決まってしまう
 * （Sol のプレイテストで 900 億の物件が渡って 4 位→1 位）。
 */
function giftCap(data: GameData, state: GameState, player: PlayerState): number {
  return Math.max(40 * yearScale(state), Math.min(80 * yearScale(state), Math.max(0, netWorth(data, state, player.id)) * 0.08));
}

function runGift(data: GameData, state: GameState, fx: Fx[], player: PlayerState): void {
  const cap = giftCap(data, state, player);
  const cityId = player.nodeId.startsWith('c:') ? player.nodeId.slice(2) : null;
  const city = cityId ? data.cities.find((c) => c.id === cityId) : undefined;
  const free = (city?.properties ?? [])
    .filter((p) => state.owner[p.id] === undefined && currentPrice(data, state, p.id) <= cap)
    .sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));

  let kind: PiperGiftKind;
  if (player.cash < 0) kind = 'debt_payoff';
  else if (free.length > 0) kind = 'free_property';
  else kind = 'cash_gift';

  let amount = 0;
  if (kind === 'debt_payoff') {
    amount = Math.min(cap, -player.cash);
    player.cash += amount;
  } else if (kind === 'free_property') {
    const property = free[0];
    amount = Math.max(0, currentPrice(data, state, property.id));
    state.owner[property.id] = player.id;
  } else {
    amount = Math.min(cap, 10 + Math.max(0, netWorth(data, state, player.id)) * 0.02);
    player.cash += amount;
  }

  const def = piperGiftDef(kind);
  fx.push({ t: 'piper_gift', holder: player.id, amount, title: def.title });
  if (kind === 'free_property') {
    const property = free[0];
    fx.push({
      t: 'buy',
      playerId: player.id,
      propertyId: property.id,
      monopoly: monopolises(data, state, player.id, city?.id ?? ''),
    });
  } else {
    fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '取り立て屋の気まぐれ' });
  }
  fx.push({ t: 'say', speaker: 'narrator', text: def.narration });
  fx.push({
    t: 'toast',
    text: `${def.title}！ ${player.name} は ${formatOku(amount)}を得した。`,
  });
}

// ---------------------------------------------------------------- geography

/** 現在地から最短歩数が最大の地上都市。タイブレークは cityId 昇順で決定的。 */
function farthestCityId(data: GameData, fromNodeId: string): string | null {
  let bestId: string | null = null;
  let best = -1;
  for (const city of data.cities) {
    if (city.realm !== undefined) continue;
    const node = nodeForCity(data, city.id);
    if (!node) continue;
    const d = effectiveDistance(data, fromNodeId, node);
    if (!Number.isFinite(d)) continue;
    if (d > best || (d === best && bestId !== null && city.id < bestId)) {
      best = d;
      bestId = city.id;
    }
  }
  return bestId;
}