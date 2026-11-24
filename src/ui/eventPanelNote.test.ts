import { describe, expect, it } from 'vitest';
import { eventFootnoteText, isAutoAppliedEvent } from './eventPanelNote';

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
