import type { Effect, Who } from '../core/types';
import { INDUSTRY_JA } from './format';

const WHO_JA: Record<Who, string> = {
  self: '手番',
  all: '全員',
  others: 'ほかの全員',
  richest: '最富裕',
  poorest: '最貧困',
  random_other: 'ランダムな他1人',
};

function signedOku(amount: number): string {
  return `${amount >= 0 ? '+' : '▲'}${Math.abs(amount)}億円`;
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
    case 'sell':
      return `${WHO_JA[effect.who]} の${effect.industry === 'any' ? '物件' : INDUSTRY_JA[effect.industry]}を${effect.count}件売却（価格 ×${effect.priceMult.toFixed(1)}）`;
    case 'card':
      return `${WHO_JA[effect.who]} にカード「${effect.card}」${effect.count && effect.count > 1 ? `×${effect.count}` : ''}`;
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
