import type { CityModKind, CityTarget, Effect, Who } from '../core/types';
import { cardsById, citiesById, formatOkuShort, INDUSTRY_JA } from './format';

const WHO_JA: Record<Who, string> = {
  self: '手番',
  all: '全員',
  others: 'ほかの全員',
  richest: '最富裕',
  poorest: '最貧困',
  random_other: 'ランダムな他1人',
  target: '選んだ相手',
};

const CITY_MOD_KIND_JA: Record<CityModKind, string> = {
  bubble: 'バブル',
  boom: '好況',
  damage: '打撃',
  blockade: '封鎖',
};

const CITY_TARGET_JA: Partial<Record<CityTarget, string>> = {
  here: '現在地の都市',
  destination: '目的地',
  random: 'ランダムな都市',
  richest_best: '首位が最も持つ都市',
  self_best: '手番が最も持つ都市',
};

function cityLabel(city: CityTarget): string {
  return CITY_TARGET_JA[city] ?? citiesById.get(city)?.nameJa ?? city;
}

function signedOku(amount: number): string {
  return `${amount >= 0 ? '+' : '▲'}${formatOkuShort(Math.abs(amount))}円`;
}

/** Plain-Japanese one-liners for automatically applied event effects. */
export function describeEffect(effect: Effect): string {
  switch (effect.op) {
    case 'cash':
      return `${WHO_JA[effect.who]} ${signedOku(effect.amount)}`;
    case 'cash_pct':
      return `${WHO_JA[effect.who]} 所持金の ${effect.pct >= 0 ? '+' : '▲'}${Math.abs(effect.pct)}%`;
    case 'per_property':
      return `${WHO_JA[effect.who]} の${effect.industry === 'any' ? '全物件' : INDUSTRY_JA[effect.industry]}1件につき ${signedOku(effect.perProperty)}`;
    case 'industry_mod':
      return `${INDUSTRY_JA[effect.industry]}の収益 ×${effect.mult.toFixed(2)}（${effect.years}年）`;
    case 'price_mod':
      return `${INDUSTRY_JA[effect.industry]}の物件価格 ×${effect.mult.toFixed(2)}`;
    case 'city_mod':
      return `${cityLabel(effect.city)}の${CITY_MOD_KIND_JA[effect.kind]}（物件価格・収益 ×${effect.mult.toFixed(2)}、${effect.years}年）`;
    case 'sell':
      return `${WHO_JA[effect.who]} の${effect.industry === 'any' ? '物件' : INDUSTRY_JA[effect.industry]}を${effect.count}件売却（価格 ×${effect.priceMult.toFixed(1)}）`;
    case 'card':
      return `${WHO_JA[effect.who]} にカード「${cardsById.get(effect.card)?.name ?? effect.card}」${effect.count && effect.count > 1 ? `×${effect.count}` : ''}`;
    case 'move':
      return `${WHO_JA[effect.who]} が移動（${effect.to === 'destination_near' ? '目的地の近く' : effect.to === 'random_city' ? 'ランダムな都市' : effect.to === 'nearest_port' ? '最寄りの港' : effect.to}）`;
    case 'skip':
      return `${WHO_JA[effect.who]} は ${effect.turns} 回休み`;
    case 'piper':
      return `取り立て屋が ${WHO_JA[effect.to]} に憑く`;
    case 'realm':
      return `${WHO_JA[effect.who]} を${effect.realm === 'world' ? '地上' : '異世界'}へ`;
    case 'gamble':
      return `確率 ${Math.round(effect.chance * 100)}% で分岐`;
    default:
      return '効果';
  }
}

/**
 * 固有技の効果説明。gamble は勝ち/負けの中身まで開いて読みやすくする。
 * characters.json の skill.desc はこの文字列と同じ数値を含むことをテストで保証する。
 */
export function describeEffects(effects: Effect[] | undefined): string {
  return (effects ?? []).map(describeSkillEffect).join('、');
}

function describeSkillEffect(effect: Effect): string {
  if (effect.op === 'gamble') {
    const chance = Math.round(effect.chance * 100);
    return `確率 ${chance}% で「${describeEffects(effect.win)}」、外れると「${describeEffects(effect.lose)}」`;
  }
  return describeEffect(effect);
}
