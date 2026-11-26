import { describe, expect, it } from 'vitest';
import { createGame } from '../../core/engine';
import { annualIncome, currentPrice } from '../../core/economy';
import { GAME_DATA } from '../../data/index';
import { buyoutImpact } from './buyoutPanel';

function twoPlayerState() {
  const created = createGame(GAME_DATA, {
    years: 3,
    seed: 7,
    players: [
      { name: '買い手', characterId: 'momotaro', isCpu: false, cpuLevel: 1 },
      { name: '売り手', characterId: 'red_hood', isCpu: true, cpuLevel: 2 },
    ],
  });
  const state = created.state;
  const city = GAME_DATA.cities.find((c) => c.id === 'tokyo')!;
  const property = city.properties[0];
  state.owner[property.id] = 1;
  return { state, property };
}

describe('buyoutImpact', () => {
  it('shows the premium as the buyer loss and the seller gain, plus the income swap', () => {
    const { state, property } = twoPlayerState();
    // buyoutQuote と同じく時価を基準にする（買収額 = 時価 × 1.5）。
    const basePrice = currentPrice(GAME_DATA, state, property.id);
    const price = basePrice * 1.5;
    const sellerIncomeBefore = annualIncome(GAME_DATA, state, 1);
    const buyerIncomeBefore = annualIncome(GAME_DATA, state, 0);

    const impact = buyoutImpact(state, property.id, 0, 1, price, basePrice);

    // 時価を超えて払った割増ぶんだけ、買い手の総資産が減り売り手が増える。
    expect(impact.premium).toBeCloseTo(basePrice * 0.5, 6);
    expect(impact.buyerNet).toBeCloseTo(-impact.premium, 6);
    expect(impact.sellerNet).toBeCloseTo(impact.premium, 6);
    // 現金と物件が移るだけなので、両者の総資産の変化は差し引きゼロ。
    expect(impact.buyerNet + impact.sellerNet).toBeCloseTo(0, 6);
    // 年収は物件1件ぶん入れ替わる（売り手は他に物件を持たないので丸ごと失う）。
    expect(buyerIncomeBefore).toBe(0);
    expect(impact.buyerIncome).toBeGreaterThan(0);
    expect(impact.sellerIncome).toBeCloseTo(-sellerIncomeBefore, 6);
  });

  it('matches the engine numbers for the Sol cartagena case (54 paid for a 36 property)', () => {
    const { state, property } = twoPlayerState();
    const basePrice = currentPrice(GAME_DATA, state, property.id);
    const impact = buyoutImpact(state, property.id, 0, 1, basePrice + 18, basePrice);
    expect(impact.premium).toBeCloseTo(18, 6);
    expect(impact.buyerNet).toBeCloseTo(-18, 6);
    expect(impact.sellerNet).toBeCloseTo(18, 6);
  });
});