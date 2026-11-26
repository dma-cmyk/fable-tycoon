// 都市の購入画面に出す「買収」パネル。
// 他プレイヤーが持つ物件を、所有者の色・顔つき・独占崩壊の警告つきで並べる。

import type { PublicState } from '../../core/engine';
import { annualIncome, netWorth, propertyAnnualIncome } from '../../core/economy';
import type { City, Property } from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h } from '../dom';
import {
  characterSprite,
  charsById,
  citiesById,
  displayPlayerName,
  formatDelta,
  formatOku,
  formatOkuShort,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  playerColor,
} from '../format';
import { buyoutQuote } from '../../core/showdown';
import '../../styles/showdown.css';

export interface BuyoutPanelOptions {
  state: PublicState;
  cityId: string;
  /** 自分の手番で操作できるか。 */
  canAct: boolean;
  /** この訪問ですでに買収したか（1訪問1回）。 */
  boughtOut: boolean;
  onBuyout: (propertyId: string) => void;
}

interface Quote {
  property: Property;
  ownerId: number;
  /** 時価（倍率を掛ける前の現在価格）。 */
  basePrice: number;
  /** 買収額（時価 × 1.5、独占中は × 2.0）。 */
  price: number;
  mult: number;
  /** 決算と同じ計算の年収益（所有者の業種倍率・都市倍率・独占を反映）。 */
  income: number;
  monopoly: boolean;
}

function quotesFor(state: PublicState, city: City): Quote[] {
  const actor = state.current;
  const out: Quote[] = [];
  for (const property of city.properties) {
    const ownerId = state.owner[property.id];
    if (ownerId === undefined || ownerId === actor) continue;
    const quote = buyoutQuote(GAME_DATA, state, property.id);
    if (!quote) continue;
    out.push({
      property,
      ownerId,
      basePrice: quote.basePrice,
      price: quote.price,
      mult: quote.mult,
      income: propertyAnnualIncome(GAME_DATA, state, ownerId, property, city.id),
      monopoly: quote.brokeMonopoly,
    });
  }
  return out.sort((a, b) => (a.monopoly === b.monopoly ? a.price - b.price : a.monopoly ? -1 : 1));
}

export interface BuyoutImpact {
  /** 時価を超えて払う分（= 買い手の総資産の減り幅）。 */
  premium: number;
  buyerNet: number;
  sellerNet: number;
  buyerIncome: number;
  sellerIncome: number;
}

/**
 * 買収した場合の両者の総資産・年収の変化。資産は「現金 − 買収額 + 時価」、
 * 年収は所有者を入れ替えた状態で決算と同じ式（独占・都市効果・業種倍率込み）で数える。
 * Sol の指摘: 時価36億の物件を54億で買って資産が18億減ったことが、確定前に見えなかった。
 */
export function buyoutImpact(
  state: PublicState,
  propertyId: string,
  buyerId: number,
  sellerId: number,
  price: number,
  basePrice: number,
): BuyoutImpact {
  const after: PublicState = {
    ...state,
    players: state.players.map((player) => {
      if (player.id === buyerId) return { ...player, cash: player.cash - price };
      if (player.id === sellerId) return { ...player, cash: player.cash + price };
      return player;
    }),
    owner: { ...state.owner, [propertyId]: buyerId },
  };
  return {
    premium: price - basePrice,
    buyerNet: netWorth(GAME_DATA, after, buyerId) - netWorth(GAME_DATA, state, buyerId),
    sellerNet: netWorth(GAME_DATA, after, sellerId) - netWorth(GAME_DATA, state, sellerId),
    buyerIncome: annualIncome(GAME_DATA, after, buyerId) - annualIncome(GAME_DATA, state, buyerId),
    sellerIncome: annualIncome(GAME_DATA, after, sellerId) - annualIncome(GAME_DATA, state, sellerId),
  };
}

/**
 * 買収パネルを組み立てる。他プレイヤーの物件がこの都市に無ければ null。
 * 買収ボタンは2段階（押す → 確認）にして、スマホの誤タップで大金が飛ばないようにする。
 */
export function buildBuyoutPanel(options: BuyoutPanelOptions): HTMLElement | null {
  const city = citiesById.get(options.cityId);
  if (!city) return null;
  const quotes = quotesFor(options.state, city);
  if (quotes.length === 0) return null;
  const actor = options.state.players[options.state.current];
  const cash = actor?.cash ?? 0;
  const list = h('div', { class: 'buyout-list' });

  for (const quote of quotes) {
    const owner = options.state.players[quote.ownerId];
    const color = playerColor(owner);
    const affordable = cash >= quote.price;
    const impact = buyoutImpact(
      options.state,
      quote.property.id,
      actor?.id ?? options.state.current,
      quote.ownerId,
      quote.price,
      quote.basePrice,
    );
    const sellerName = owner ? displayPlayerName(owner) : '持ち主';
    const impactText =
      `あなた 総資産 ${formatDelta(impact.buyerNet)} / 年収 ${formatDelta(impact.buyerIncome)}` +
      ` ・ ${sellerName} 総資産 ${formatDelta(impact.sellerNet)} / 年収 ${formatDelta(impact.sellerIncome)}`;
    let disabled = !options.canAct || options.boughtOut || !affordable;
    let armed = false;
    const button = h('button', { class: 'btn btn-gold buyout-button', attrs: { type: 'button' } });
    const confirm = h('div', { class: 'buyout-confirm', attrs: { hidden: 'hidden' } });
    const paint = (): void => {
      if (options.boughtOut) {
        button.textContent = 'この駅の買収は済み';
      } else if (!affordable) {
        button.textContent = `資金不足（${formatOku(quote.price)}）`;
      } else {
        button.textContent = `買収 ${formatOku(quote.price)}`;
      }
      button.disabled = disabled;
      button.classList.toggle('is-armed', armed);
      // 確認中はボタンを隠し、同じ位置に確認行を出す（スマホでも押し間違えない）。
      button.hidden = armed;
      confirm.hidden = !armed;
    };
    button.addEventListener('click', () => {
      if (disabled) return;
      armed = true;
      paint();
      confirm.replaceChildren(
        h('span', { class: 'buyout-confirm-text', text: `本当に ${formatOku(quote.price)} で買収しますか？` }),
        h('p', { class: 'buyout-confirm-impact', text: impactText }),
        h('button', {
          class: 'btn btn-red buyout-go',
          text: '買収する',
          attrs: { type: 'button' },
          on: {
            click: () => {
              armed = false;
              disabled = true;
              paint();
              options.onBuyout(quote.property.id);
            },
          },
        }),
        h('button', {
          class: 'btn btn-ghost buyout-cancel',
          text: 'やめる',
          attrs: { type: 'button' },
          on: {
            click: () => {
              armed = false;
              paint();
            },
          },
        }),
      );
    });
    paint();

    list.append(
      h(
        'div',
        {
          class: `buyout-row ${quote.monopoly ? 'is-monopoly' : ''}`.trim(),
          attrs: { style: `--buyout-owner:${color}` },
        },
        h(
          'div',
          { class: 'buyout-owner' },
          avatar(characterSprite(owner ? charsById.get(owner.characterId) : undefined), color, 34),
          h('span', { class: 'buyout-owner-name', text: owner ? displayPlayerName(owner) : '持ち主不明' }),
        ),
        h(
          'div',
          { class: 'buyout-main' },
          h(
            'div',
            { class: 'buyout-name-row' },
            h('span', { class: 'buyout-industry', text: INDUSTRY_ICON[quote.property.industry], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'buyout-name', text: quote.property.name }),
          ),
          h('div', {
            class: 'buyout-meta',
            text: `${INDUSTRY_JA[quote.property.industry]} ・ 年 ${formatOkuShort(quote.income)}`,
          }),
          h(
            'div',
            { class: 'buyout-price-line' },
            h('span', { class: 'buyout-price-from', text: `時価 ${formatOku(quote.basePrice)}` }),
            h('span', { class: 'buyout-price-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'buyout-price-to', text: `買収 ${formatOku(quote.price)}` }),
            h('span', { class: 'buyout-price-mult', text: `（×${quote.mult}）` }),
            h('span', { class: 'buyout-price-premium', text: `割増 +${formatOkuShort(impact.premium)}` }),
          ),
          h(
            'div',
            { class: 'buyout-impact', attrs: { role: 'group', 'aria-label': '買収後の資産と年収の変化' } },
            h(
              'span',
              { class: 'buyout-impact-side' },
              h('span', { class: 'buyout-impact-who', text: 'あなた' }),
              h('span', {
                class: `buyout-impact-net ${impact.buyerNet < 0 ? 'is-down' : 'is-up'}`,
                text: `総資産 ${formatDelta(impact.buyerNet)}`,
              }),
              h('span', {
                class: `buyout-impact-income ${impact.buyerIncome < 0 ? 'is-down' : 'is-up'}`,
                text: `年収 ${formatDelta(impact.buyerIncome)}`,
              }),
            ),
            h(
              'span',
              { class: 'buyout-impact-side' },
              h('span', { class: 'buyout-impact-who', text: sellerName }),
              h('span', {
                class: `buyout-impact-net ${impact.sellerNet < 0 ? 'is-down' : 'is-up'}`,
                text: `総資産 ${formatDelta(impact.sellerNet)}`,
              }),
              h('span', {
                class: `buyout-impact-income ${impact.sellerIncome < 0 ? 'is-down' : 'is-up'}`,
                text: `年収 ${formatDelta(impact.sellerIncome)}`,
              }),
            ),
          ),
          quote.monopoly
            ? h(
                'p',
                { class: 'buyout-warning' },
                h('span', { class: 'buyout-warning-icon', text: '⚠', attrs: { 'aria-hidden': 'true' } }),
                h('span', {
                  text: `${owner ? displayPlayerName(owner) : '持ち主'}の都市独占が崩れます`,
                }),
              )
            : null,
        ),
        h('div', { class: 'buyout-side' }, button, confirm),
      ),
    );
  }

  return h(
    'section',
    { class: 'buyout-panel', attrs: { 'aria-label': '買収' } },
    h(
      'header',
      { class: 'buyout-head' },
      h('span', { class: 'buyout-head-icon', text: '🤝', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'buyout-head-text' },
        h('h4', { text: '買収' }),
        h('p', {
          text: options.boughtOut
            ? 'この駅での買収は1回まで。すでに使い切った。'
            : '他プレイヤーの物件を現在価格×1.5で買い取れる（独占中は×2）。1訪問1回。',
        }),
      ),
    ),
    list,
  );
}