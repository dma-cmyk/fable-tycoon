import { describe, expect, it } from 'vitest';
import { describeEffect } from './eventEffects';

describe('event effect summary', () => {
  it('summarizes cash and industry modifiers', () => {
    expect(describeEffect({ op: 'cash', who: 'all', amount: 12 })).toBe('全員 +12億円');
    expect(describeEffect({ op: 'industry_mod', industry: 'media', mult: 1.2, years: 1, label: 'x' })).toBe('娯楽・メディアの収益 ×1.20（1年）');
  });

  it('summarizes negative cash, cards and forced movement', () => {
    expect(describeEffect({ op: 'cash', who: 'self', amount: -8 })).toBe('手番 ▲8億円');
    expect(describeEffect({ op: 'card', who: 'self', card: 'teleport' })).toBe('手番 にカード「teleport」');
    expect(describeEffect({ op: 'move', who: 'others', to: 'nearest_port' })).toBe('ほかの全員 が移動（最寄りの港）');
  });
});
