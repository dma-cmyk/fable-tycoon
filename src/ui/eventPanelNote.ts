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

export interface ChoiceDetailPart {
  kind: 'effect' | 'risk' | 'risk-title' | 'risk-loss';
  text: string;
}

/**
 * Split choice detail copy into structured spans so bubble-collapse probability and loss are
 * clearly separated (own lines + explicit colon separator) even in compact landscape viewports.
 */
export function splitChoiceDetail(detail: string): ChoiceDetailPart[] {
  const lines: ChoiceDetailPart[] = [];
  const sentences = detail
    .split('。')
    .map((part) => part.trim())
    .filter(Boolean);
  sentences.forEach((sentence, index) => {
    const collapse = sentence.match(/^(\d+)%でバブル崩壊(?:し|する)?[、,]?(.*)$/);
    if (collapse) {
      lines.push({ kind: 'risk-title', text: `崩壊確率 ${collapse[1]}%` });
      const loss = collapse[2]?.replace(/^[、,]+/, '').trim();
      if (loss) lines.push({ kind: 'risk-loss', text: `崩壊時の損失：${loss}` });
      return;
    }
    const parts = sentence.split(/、/).map((part) => part.trim()).filter(Boolean);
    const riskSentence = /崩壊|失敗|不足|損失|損|リスク|売却/.test(sentence) && index > 0;
    for (const part of parts) {
      lines.push({
        kind: riskSentence ? 'risk' : 'effect',
        text: `${part}${part === parts[parts.length - 1] ? '。' : ''}`,
      });
    }
  });
  return lines;
}
