// CPU の取り立て屋戦略 (2026-11 fun overhaul).
//
// 目的は「Lv2/Lv3 の取り立て屋を押し付け合う」こと。cpu.ts の chooseMove は目的地までの
// 歩数スコアを最小化するので、ここでは加算するスコア（負 = 好ましい）だけを返す。
//
//   * 憑かれている側: 通過するマスに他プレイヤーがいれば押し付けられるので、その選択肢を優遇する。
//     Lv1 では弱く、Lv2/Lv3 では目的地から多少遠回りしても押し付けを選ぶ。
//   * 憑かれていない側: Lv2/Lv3 の取り立て屋に近づくと、相手の移動で憑き移される危険がある。
//     終点が holder の近くになる選択肢を避ける。
//
// 純粋関数。rng も時計も使わない（決定性はエンジン側で担保される）。

import type { GameData, GameState, MoveOption, PlayerState } from './types';
import { effectiveDistance } from './realm';
import { netWorth } from './economy';

/** 通過 1 人あたりの押し付けボーナス（スコア加算値）。 */
const PASS_BONUS: Readonly<Record<1 | 2 | 3, number>> = { 1: 2.5, 2: 8, 3: 11 };
/** 押し付けポイントに到達するために許す遠回り（歩数）。 */
const PASS_EXTRA_STEPS = 8;
/** 非保持者が holder に近づくペナルティの最大値と、危険とみなす距離。 */
const DANGER_MAX_PENALTY = 7;
const DANGER_STEPS = 4;

export interface PiperCpuContext {
  player: PlayerState;
  /** この手番で holder が持つ取り立て屋のレベル（holder でなければ 0）。 */
  heldLevel: 1 | 2 | 3 | 0;
  /** holder の player id（null なら未憑依）。 */
  holder: number | null;
}

/** cpu.ts から呼ぶ唯一の入口。chooseMove の目的地距離スコアに加算する。 */
export function piperMoveBias(
  data: GameData,
  state: GameState,
  player: PlayerState,
  option: MoveOption,
): number {
  const context = piperContext(state, player);
  if (context.heldLevel !== 0) return passBias(state, option, context.heldLevel);
  return dangerBias(data, state, option, context.holder);
}

export function piperContext(state: GameState, player: PlayerState): PiperCpuContext {
  if (state.piper.holder === player.id) {
    return { player, heldLevel: state.piper.level, holder: state.piper.holder };
  }
  return { player, heldLevel: 0, holder: state.piper.holder };
}

/** 憑かれている側: 通過する他プレイヤーの人数に応じてスコアを下げる。 */
function passBias(state: GameState, option: MoveOption, level: 1 | 2 | 3): number {
  if (level === 1) return 0;
  const others = new Map<number, string>();
  for (const other of state.players) {
    if (other.id === state.current) continue;
    others.set(other.id, other.nodeId);
  }
  if (others.size === 0) return 0;
  const nodes = new Set(others.values());
  let firstIndex = -1;
  let count = 0;
  const seen = new Set<string>();
  for (let i = 0; i < option.path.length; i += 1) {
    const nodeId = option.path[i];
    if (!nodes.has(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (firstIndex < 0) firstIndex = i;
    count += 1;
  }
  if (count === 0) return 0;
  // 遠回りしてでも最初の押し付けポイントに寄せる。目的地までの実歩数差は呼び出し側の
  // スコアが持っているので、ここでは「押し付け 1 人ぶん」を割り引くだけにする。
  const detourAllowance = firstIndex > 0 ? Math.min(firstIndex, PASS_EXTRA_STEPS) * 0.5 : 0;
  return -(PASS_BONUS[level] * count + detourAllowance);
}

/** 憑かれていない側: Lv2/Lv3 の holder の近くに止まる選択肢を避ける。 */
function dangerBias(
  data: GameData,
  state: GameState,
  option: MoveOption,
  holder: number | null,
): number {
  if (holder === null || holder === state.current) return 0;
  if (state.piper.level < 2) return 0;
  const holderNode = state.players[holder]?.nodeId;
  if (!holderNode) return 0;
  const d = effectiveDistance(data, holderNode, option.nodeId);
  if (!Number.isFinite(d)) return 0;
  if (d > DANGER_STEPS) return 0;
  return DANGER_MAX_PENALTY * (1 - d / (DANGER_STEPS + 1));
}

/**
 * 取り立て屋の示談イベント（1回休み vs 示談金）の CPU 判断。
 * 示談金は純資産の 5%（ブラックは 10%）。1 手番の価値に比べれば安いので、
 * 現金で払えるなら払う。手持ちで足りないときだけ休む（物件を手放してまでは払わない）。
 */
export function piperDealCpuChoice(
  data: GameData,
  state: GameState,
  player: PlayerState,
): number {
  const pct = state.piper.level === 2 ? 0.1 : 0.05;
  const fee = Math.max(0, netWorth(data, state, player.id)) * pct;
  return player.cash >= fee ? 1 : 0;
}
