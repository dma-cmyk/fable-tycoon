// キャラクター固有技（fun overhaul 2026-11-26）。
//
// ルール:
//   - 1 年 1 回、手番開始（turn_start）にだけ使える。使っても手番は続き、サイコロをふれる。
//   - 効果は events.ts の Effect DSL をそのまま再利用する（city_mod / piper も含む）。
//   - target: 'player' の技だけ skill_target フェーズを挟み、選んだ相手を who: 'target' で解決する。
//     cancel すると発動せず turn_start に戻る。
//   - 乱数は state.rng（applyEffects 内）のみ。CPU の判断も決定的。

import type { Action, CharacterSkill, Fx, GameData, GameState, PlayerState } from './types';
import { netWorth } from './economy';
import { applyEffects } from './events';
import { sayCharacterLine } from './speech';

/** そのキャラクターの固有技定義（未登録なら null）。 */
export function skillFor(data: GameData, characterId: string): CharacterSkill | null {
  const character = data.characters.find((c) => c.id === characterId);
  return character?.skill ?? null;
}

export function skillOf(data: GameData, player: PlayerState | undefined): CharacterSkill | null {
  return player ? skillFor(data, player.characterId) : null;
}

/** 今年はまだ使っていないか。 */
export function skillAvailableThisYear(state: GameState, player: PlayerState): boolean {
  return player.skillUsedYear !== state.year;
}

/** skill_target の選択肢（自分以外のプレイヤー id）。 */
export function skillTargetOptions(state: GameState, actor: number): string[] {
  return state.players.filter((p) => p.id !== actor).map((p) => String(p.id));
}

/** use_skill が合法か（今年未使用 & 対象を選ぶ技なら相手がいる）。 */
export function canUseSkill(
  data: GameData,
  state: GameState,
  player: PlayerState | undefined,
): boolean {
  if (!player) return false;
  const skill = skillOf(data, player);
  if (!skill) return false;
  if (!skillAvailableThisYear(state, player)) return false;
  if (skill.target === 'player' && skillTargetOptions(state, player.id).length === 0) return false;
  return true;
}

/** use_skill の本体。対象を選ぶ技は skill_target フェーズへ、それ以外は即時発動。 */
export function beginSkill(data: GameData, state: GameState, fx: Fx[]): void {
  const player = state.players[state.current];
  const skill = skillOf(data, player);
  if (!player || !skill) return;
  if (skill.target === 'player') {
    state.phase = { t: 'skill_target', options: skillTargetOptions(state, player.id) };
    fx.push({ t: 'toast', text: `${player.name} が「${skill.name}」の対象を選んでいる…` });
    return;
  }
  fireSkill(data, state, fx);
}

/**
 * 固有技を発動する。targetId は target: 'player' の技だけ渡す。
 * 発動後は turn_start に戻るので、この手番でまだサイコロをふれる。
 */
export function fireSkill(data: GameData, state: GameState, fx: Fx[], targetId?: number): void {
  const player = state.players[state.current];
  const skill = skillOf(data, player);
  if (!player || !skill) return;
  fx.push({
    t: 'skill',
    playerId: player.id,
    characterId: player.characterId,
    name: skill.name,
    ...(targetId === undefined ? {} : { targetId }),
  });
  sayCharacterLine(data, state, player.id, 'skill', fx);
  player.skillUsedYear = state.year;
  applyEffects(data, state, fx, skill.effects, player.id, targetId);
  state.phase = { t: 'turn_start' };
}

// ---------------------------------------------------------------- CPU

/**
 * CPU の固有技判断。turn_start なら use_skill / null、skill_target なら対象 / cancel を返す。
 * 3 月（年度最後の月）は未使用なら必ず使うので、CPU は年を越して技を余らせない。
 */
export function cpuSkillAction(data: GameData, state: GameState): Action | null {
  const player = state.players[state.current];
  if (!player) return null;
  if (state.phase.t === 'skill_target') {
    const options = state.phase.options.filter((option) => state.players[Number(option)] !== undefined);
    if (options.length === 0) return { t: 'cancel' };
    return { t: 'skill_target', target: chooseSkillTarget(data, state, options) };
  }
  if (state.phase.t !== 'turn_start') return null;
  if (!canUseSkill(data, state, player)) return null;
  const skill = skillOf(data, player);
  if (!skill) return null;
  return wantsSkill(data, state, player, skill) ? { t: 'use_skill' } : null;
}

/** cpuHint と局面から「この手番で使うか」を決める。乱数は使わない。 */
function wantsSkill(
  data: GameData,
  state: GameState,
  player: PlayerState,
  skill: CharacterSkill,
): boolean {
  // 年度最後の月。まだ手番が残っているので、ここで必ず使わせる。
  if (state.month === 3) return true;

  const worth = netWorth(data, state, player.id);
  const others = state.players.filter((p) => p.id !== player.id).map((p) => netWorth(data, state, p.id));
  const best = Math.max(worth, ...others);
  const average = others.length > 0 ? others.reduce((sum, value) => sum + value, 0) / others.length : worth;

  switch (skill.cpuHint ?? 'anytime') {
    case 'early':
      // 4〜7 月 = 年度の前半。
      return state.month >= 4 && state.month <= 7;
    case 'behind':
      return worth < average;
    case 'ahead':
      return worth >= best;
    case 'anytime':
    default:
      // 3 手に 1 手くらい。round / month / 席で決定的に散らす。
      return (state.round + state.month * 2 + player.id) % 3 === 0;
  }
}

/** 攻撃系の対象は基本リーダー。同点は若い席番。 */
function chooseSkillTarget(data: GameData, state: GameState, options: string[]): string {
  let best = options[0];
  let bestWorth = -Infinity;
  for (const option of options) {
    const worth = netWorth(data, state, Number(option));
    if (worth > bestWorth) {
      bestWorth = worth;
      best = option;
    }
  }
  return best;
}