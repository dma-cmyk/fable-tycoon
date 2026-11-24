import type { GameEventDef } from '../core/types';

/** Bottom hint line for the event panel: choices advertise the 1–3 keys, auto events do not. */
export function eventFootnoteText(event: Pick<GameEventDef, 'choices'>): string {
  const hasChoices = (event.choices?.length ?? 0) > 0;
  return hasChoices
    ? '1〜3 キーまたはボタンで選択 ・ 画面の空きをタップで演出スキップ'
    : '自動で適用されました ・ 画面の空きをタップで次へ';
}

/** True when the event panel is a content-height (choice-less) panel. */
export function isAutoAppliedEvent(event: Pick<GameEventDef, 'choices'>): boolean {
  return (event.choices?.length ?? 0) === 0;
}
