import { describe, expect, it } from 'vitest';
import { eventFootnoteText, isAutoAppliedEvent, splitChoiceDetail } from './eventPanelNote';

const choice = { label: 'x', detail: 'y', effects: [] };

describe('event panel footnote', () => {
  it('advertises the 1–3 keys only for choice events', () => {
    const text = eventFootnoteText({ choices: [choice] });
    expect(text).toContain('1〜3 キー');
    expect(isAutoAppliedEvent({ choices: [choice] })).toBe(false);
  });

  it('uses the auto-applied hint when there are no choices', () => {
    const text = eventFootnoteText({ choices: [] });
    expect(text).not.toContain('1〜3 キー');
    expect(text).toContain('自動で適用');
    expect(isAutoAppliedEvent({ choices: [] })).toBe(true);
    expect(isAutoAppliedEvent({})).toBe(true);
  });
});

describe('splitChoiceDetail (#8)', () => {
  it('separates bubble-collapse probability and loss with an explicit colon', () => {
    const parts = splitChoiceDetail('IT系物件の収益2倍。35%でバブル崩壊し、全プレイヤーの所持金が半減する。');
    expect(parts).toEqual([
      { kind: 'effect', text: 'IT系物件の収益2倍。' },
      { kind: 'risk-title', text: '崩壊確率 35%' },
      { kind: 'risk-loss', text: '崩壊時の損失：全プレイヤーの所持金が半減する' },
    ]);
  });

  it('handles normal effect and risk sentences without losing punctuation', () => {
    const parts = splitChoiceDetail('現金1億を得る。失敗すると所持金10%損失。');
    expect(parts).toEqual([
      { kind: 'effect', text: '現金1億を得る。' },
      { kind: 'risk', text: '失敗すると所持金10%損失。' },
    ]);
  });
});
