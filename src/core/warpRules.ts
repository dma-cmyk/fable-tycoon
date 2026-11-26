// 目的地直前へのワープ禁止 (2026-11-26 Sol プレイテスト対応)。
//
// 飛行機・ロケット・出口・「目的地の近くへ」系の効果が目的地のすぐ隣へ着地できると、
// 歩いて競う意味が消える（Sol の報告: 飛行機 1 枚で目的地へ直接着地し、57 マスの差が一手で消えた）。
// そこで「着地した後の目的地までの残りマス」が WARP_MIN_DEST_STEPS 未満になる着地を禁止する。
// 最後の数マスは盤上で取り合い、ワープは「目的地の少し手前まで」の強いカードとして残す。
//
// 距離は盤面の歩数（effectiveDistance）で数える。異世界から地上へ戻る出口も同じ扱い。

import type { GameData, GameState } from './types';
import { nodeForCity } from './graph';
import { effectiveDistance } from './realm';

/** ワープ着地後に目的地まで残っていなければならない最少歩数。 */
export const WARP_MIN_DEST_STEPS = 4;

/** 候補リストで着地できない都市に添える理由（UI 表示用）。 */
export const WARP_TOO_CLOSE_REASON = '目的地に近すぎる';

/** ワープ着地後の目的地までの残り歩数。目的地が不明なら Infinity。 */
export function stepsAfterWarp(data: GameData, state: GameState, nodeId: string): number {
  const destNode = nodeForCity(data, state.destination);
  if (!destNode) return Number.POSITIVE_INFINITY;
  return effectiveDistance(data, nodeId, destNode);
}

/** その都市へ着地してよいか。目的地から WARP_MIN_DEST_STEPS 未満なら false。 */
export function isWarpLandingAllowed(data: GameData, state: GameState, nodeId: string): boolean {
  const steps = stepsAfterWarp(data, state, nodeId);
  return !Number.isFinite(steps) || steps >= WARP_MIN_DEST_STEPS;
}

/** 着地できない理由（着地できるなら null）。 */
export function warpBlockedReason(
  data: GameData,
  state: GameState,
  nodeId: string,
): string | null {
  return isWarpLandingAllowed(data, state, nodeId) ? null : WARP_TOO_CLOSE_REASON;
}

/** 候補のうち着地できるものだけを残す（順序は保つ）。 */
export function filterWarpTargets(
  data: GameData,
  state: GameState,
  nodeIds: readonly string[],
): string[] {
  return nodeIds.filter((nodeId) => isWarpLandingAllowed(data, state, nodeId));
}