// 取り立て屋の物件没収（Lv1 / Lv2）の上限と示談 (2026-11-26 Sol プレイテスト対応)。
//
// 従来は所持物件からランダムに 1〜2 件を選んでいたため、純資産 466 億の相手が 160 億の
// 目玉物件を一撃で失うことがあった（Sol の報告: 466→338 億、独占も消滅）。
// 通常形態の没収は「持ち主の純資産の 12%（ブラックは 20%）」を上限にし、
// 上限内の物件が 1 つもなければ現金の取り立てへ切り替える。
// 人間には「物件を差し出す / 示談金（価格の約 6 割）を払う」の選択を出す。
// キングの災害（既存の 35% 上限ルーレット）はこの上限の対象外。

import type { GameData, GameState, PlayerState } from './types';
import { currentPrice, netWorth, ownedProperties } from './economy';

/** Lv1 / Lv2 が没収できる物件価格の合計上限（持ち主の純資産比）。 */
export const PIPER_SEIZE_CAP: Readonly<Record<1 | 2, number>> = { 1: 0.12, 2: 0.2 };

/** 示談で物件を守るときに払う額（没収対象の現在価格比）。 */
export const PIPER_SEIZE_DEAL_RATE = 0.6;

export interface PiperSeizePlan {
  /** 没収対象（価格の高い順）。空なら現金の取り立てに切り替える。 */
  propertyIds: string[];
  /** 対象の現在価格の合計（億）。 */
  value: number;
  /** 示談金（億）。 */
  dealCost: number;
}

/**
 * 没収対象を決める。価格の高い順に、上限内で Lv1 は 1 件・Lv2 は 2 件まで。
 * 乱数を使わないので、示談イベントを開いたときと解決したときで同じ対象になる。
 */
export function piperSeizePlan(
  data: GameData,
  state: GameState,
  player: PlayerState,
  level: 1 | 2,
): PiperSeizePlan {
  const cap = Math.max(0, netWorth(data, state, player.id)) * PIPER_SEIZE_CAP[level];
  const maxCount = level === 2 ? 2 : 1;
  const candidates = ownedProperties(data, state, player.id)
    .map((ref) => ({
      id: ref.property.id,
      value: Math.max(0, currentPrice(data, state, ref.property.id)),
    }))
    .filter((candidate) => candidate.value > 0 && candidate.value <= cap)
    .sort((a, b) => (b.value !== a.value ? b.value - a.value : a.id.localeCompare(b.id)));

  const propertyIds: string[] = [];
  let value = 0;
  for (const candidate of candidates) {
    if (propertyIds.length >= maxCount) break;
    if (value + candidate.value > cap) continue;
    propertyIds.push(candidate.id);
    value += candidate.value;
  }
  return { propertyIds, value, dealCost: value * PIPER_SEIZE_DEAL_RATE };
}