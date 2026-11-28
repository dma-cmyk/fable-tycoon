import type { PublicState } from '../../core/engine';
import { purchasePrice } from '../../core/economy';
import type {Property} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import { rubyName } from '../ruby';
import { LANDMARK_FILES } from '../assetManifest';
import { cityTileUrl, hasCityTile, tileThumb } from '../squareInfo';
import { buildBuyoutPanel } from './buyoutPanel';
import {
  assetUrl,
  citiesById,
  countryFlag,
  characterSprite,
  charsById,
  displayPlayerName,
  formatOku,
  formatOkuShort,
  INDUSTRY_JA,
  INDUSTRY_SHORT,
  INDUSTRY_TONE,
  playerColor,
} from '../format';

export interface CitySheetOptions {
  modal: ModalHost;
  cityId: string;
  state: PublicState;
  buyMode: boolean;
  canAct: boolean;
  /** This client owns the actor, even if fx are still playing; forces a locked purchase sheet. */
  ownerWillAct?: boolean;
  onBuy: (propertyId: string) => void;
  onBuyAll?: (propertyIds: string[]) => void;
  /** 他プレイヤーの物件を買い取る（buy フェーズのみ）。 */
  onBuyout?: (propertyId: string) => void;
  onEndBuy: () => void;
  onClose?: () => void;
}

export interface CitySheetHandle {
  update(state: PublicState, canAct: boolean): void;
  close(): void;
}

export interface BulkPurchasePlan {
  items: { property: Property; price: number }[];
  total: number;
  vacantCount: number;
  allTotal: number;
  shortfall: number;
}

/** Cheapest-first purchases that fit the actor's cash, shared by label and action. */
export function planBulkPurchase(city: CityLike, state: PublicState, cash: number): BulkPurchasePlan {
  const priced = city.properties
    .filter((property) => state.owner[property.id] === undefined)
    .map((property) => ({
      property,
      price: Math.round(purchasePrice(GAME_DATA, state, state.current, property.id)),
    }))
    .sort((a, b) => a.price - b.price);
  const allTotal = priced.reduce((sum, entry) => sum + entry.price, 0);
  let remaining = Math.max(0, cash);
  const items: { property: Property; price: number }[] = [];
  for (const entry of priced) {
    if (entry.price > remaining) continue;
    items.push(entry);
    remaining -= entry.price;
  }
  return {
    items,
    total: items.reduce((sum, entry) => sum + entry.price, 0),
    vacantCount: priced.length,
    allTotal,
    shortfall: Math.max(0, allTotal - cash),
  };
}

interface CityLike {
  properties: Property[];
}

let buyoutFoldSeq = 0;

/**
 * 買収パネルを「買収する（N件）」の折りたたみに包む。
 * PC（900px 以上）は CSS でトグルを隠して常時展開、スマホは既定で閉じておく。
 * 375x667 では買収カードが購入リストを画面外へ押し出していたため。
 */
function buildBuyoutFold(panel: HTMLElement, count: number, open: boolean): HTMLElement {
  const bodyId = `buyout-fold-body-${++buyoutFoldSeq}`;
  const caret = h('span', { class: 'buyout-fold-caret', text: '▾', attrs: { 'aria-hidden': 'true' } });
  const body = h('div', { class: 'buyout-fold-body', attrs: { id: bodyId } }, panel);
  const toggle = h(
    'button',
    {
      class: 'buyout-fold-toggle',
      attrs: { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
      on: {
        click: () => {
          const next = !fold.classList.contains('is-open');
          fold.classList.toggle('is-open', next);
          toggle.setAttribute('aria-expanded', String(next));
        },
      },
    },
    h('span', { class: 'buyout-fold-label', text: `買収する（${count}件）` }),
    h('span', { class: 'buyout-fold-hint', text: '他プレイヤーの物件を買い取る' }),
    caret,
  );
  const fold = h('section', { class: 'buyout-fold' }, toggle, body);
  if (open) fold.classList.add('is-open');
  return fold;
}

export function openCitySheet(options: CitySheetOptions): CitySheetHandle {
  const city = citiesById.get(options.cityId);
  if (!city) {
    let canAct = options.canAct;
    let modalHandle: ModalHandle | null = null;
    const body = h(
      'div',
      { class: 'city-sheet' },
      h(
        'div',
        { class: 'city-unavailable' },
        h('span', { class: 'city-unavailable-icon', text: '🚧' }),
        h('h3', { text: 'この駅は開業準備中' }),
        h('p', { text: `駅データ「${options.cityId}」はまだ物件カタログに登録されていません。手番を終了してください。` }),
      ),
    );
    const footer = h('div', { class: 'city-sheet-footer' });
    footer.append(
      h('span', { class: 'muted', text: '物件はありません' }),
      options.buyMode && canAct
        ? h('button', {
            class: 'btn btn-gold city-end-buy',
            text: '✔ 手番を終える',
            attrs: { type: 'button' },
            on: { click: (event) => { (event.currentTarget as HTMLButtonElement).disabled = true; options.onEndBuy(); } },
          })
        : h('button', { class: 'btn btn-gold', text: 'とじる', attrs: { type: 'button' }, on: { click: () => modalHandle?.close() } }),
    );
    body.append(footer);
    modalHandle = options.modal.open(body, {
      title: '駅',
      subtitle: '準備中',
      className: 'city-modal',
      dismissible: !(options.buyMode && canAct),
      onClose: options.onClose,
    });
    return {
      update(_nextState, nextCanAct) { canAct = nextCanAct; },
      close() { modalHandle?.close(); },
    };
  }

  let state = options.state;
  let canAct = options.canAct;
  let modalHandle: ModalHandle | null = null;
  let previousOwners = new Map<string, number | undefined>();
  for (const property of city.properties) previousOwners.set(property.id, options.state.owner[property.id]);
  const body = h('div', { class: 'city-sheet' });
  const footer = h('div', { class: 'city-sheet-footer' });

  const render = (): void => {
    // 物件を買うたびに先頭へ戻ると、スマホで 5 件目以降を買うときに毎回探し直しになる。
    const savedScrollTop = body.querySelector('.city-sheet-scroll')?.scrollTop ?? 0;
    const landmarkAsset =
      city.landmark && LANDMARK_FILES.has(city.landmark)
        ? assetUrl(`assets/landmarks/${city.landmark}.webp`)
        : '';
    const citySmallTile = cityTileUrl(city, true);
    const heroArt = hasCityTile(city.id)
      ? cityTileUrl(city, false)
      : landmarkAsset || cityTileUrl(city, false);
    const ownerIds = new Set(
      city.properties.map((property) => state.owner[property.id]).filter((id): id is number => id !== undefined),
    );
    const allSameOwner = ownerIds.size === 1 && city.properties.every((property) => state.owner[property.id] !== undefined);
    const soleOwner = allSameOwner ? [...ownerIds][0] : undefined;
    const actor = state.players[state.current];
    const actorCash = actor?.cash ?? 0;
    const destination = state.destination === city.id;

    const header = h(
      'div',
      {
        class: 'city-hero',
        attrs: { style: `--city-accent:${soleOwner !== undefined ? playerColor(state.players[soleOwner]) : '#45b7ff'}` },
      },
      h('img', {
        class: 'city-hero-landmark city-hero-tile',
        attrs: { src: heroArt, alt: '', loading: 'lazy', draggable: 'false' },
      }),
      h(
        'div',
        { class: 'city-hero-text' },
        h(
          'div',
          { class: 'city-hero-title-row' },
          tileThumb(citySmallTile, 'city-heading-tile'),
          h('h3', { class: 'city-hero-name' }, rubyName(city.nameJa, city.nameKana)),
          h('span', { class: 'city-flag', text: countryFlag(city.country) }),
          destination ? h('span', { class: 'badge badge-gold', text: '🎯 目的地' }) : null,
        ),
        h('p', { class: 'city-hero-sub', text: `${city.countryJa} ・ ${city.nameEn}` }),
        h('p', { class: 'city-hero-blurb', text: city.blurb }),
        h(
          'div',
          { class: 'city-hero-tags' },
          city.port ? h('span', { class: 'badge', text: '⚓ 港' }) : null,
          city.airport ? h('span', { class: 'badge', text: '✈️ 空港' }) : null,
          h('span', { class: 'badge', text: `物件 ${city.properties.length} 件` }),
        ),
      ),
    );

    const actorOwned = city.properties.filter((property) => state.owner[property.id] === state.current).length;
    const occupied = city.properties.filter((property) => state.owner[property.id] !== undefined).length;
    const otherOwned = occupied - actorOwned;
    const progressPct = Math.round((actorOwned / Math.max(1, city.properties.length)) * 100);
    const actorName = actor ? displayPlayerName(actor) : '手番プレイヤー';
    const monopolyLabel = allSameOwner
      ? '👑 都市独占！ 収益 2 倍'
      : otherOwned === city.properties.length
        ? '他のプレイヤーが全て所有中'
        : `${actorName}の所有`;
    const monopoly = h(
      'div',
      { class: `city-monopoly-progress ${allSameOwner ? 'is-monopoly' : ''}`.trim() },
      h(
        'div',
        { class: 'city-monopoly-top' },
        h('span', { class: 'city-monopoly-label', text: monopolyLabel }),
        h('span', { class: 'city-monopoly-count', text: `${actorOwned} / ${city.properties.length} 件` }),
      ),
      h(
        'div',
        { class: 'progress city-monopoly-bar' },
        h('span', { attrs: { style: `width:${progressPct}%` } }),
      ),
      allSameOwner
        ? h('p', { class: 'city-monopoly-note', text: `${soleOwner !== undefined ? displayPlayerName(state.players[soleOwner]) : '誰か'} がすべての物件を所有。決算収益 2 倍。` })
        : otherOwned > 0
          ? h('p', { class: 'city-monopoly-note', text: `他のプレイヤー所有 ${otherOwned} 件。独占には残り ${Math.max(0, city.properties.length - actorOwned)} 件（うち他所有 ${otherOwned} 件）の買い戻しが必要。` })
          : null,
    );

    const list = h('div', { class: 'property-list' });
    const sorted = [...city.properties].sort((a, b) => purchasePrice(GAME_DATA, state, state.current, a.id) - purchasePrice(GAME_DATA, state, state.current, b.id));
    for (const property of sorted) list.append(propertyRow(property));

    const buyoutAvailable = city.properties.filter((property) => {
      const owner = state.owner[property.id];
      return owner !== undefined && owner !== state.current;
    }).length;
    const keepFoldOpen = body.querySelector('.buyout-fold')?.classList.contains('is-open') ?? false;
    const buyout =
      options.buyMode && state.phase.t === 'buy' && state.phase.cityId === city.id
        ? buildBuyoutPanel({
            state,
            cityId: city.id,
            canAct,
            boughtOut: state.phase.t === 'buy' && state.phase.boughtOut === true,
            onBuyout: (propertyId) => options.onBuyout?.(propertyId),
          })
        : null;
    const buyoutFold = buyout && buyoutAvailable > 0 ? buildBuyoutFold(buyout, buyoutAvailable, keepFoldOpen) : buyout;

    const tableHead = h(
      'div',
      { class: 'property-table-head' },
      h('span', { class: 'property-table-spacer', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: '物件' }),
      h('span', { text: '価格' }),
      h('span', { text: '年間収益' }),
      h('span', { text: '収益率' }),
      h('span', { text: '所有者' }),
    );
    const scrollArea = h('div', { class: 'city-sheet-scroll' }, tableHead, list);
    if (buyoutFold) scrollArea.append(buyoutFold);
    const sections: HTMLElement[] = [header, monopoly, scrollArea, footer];
    body.replaceChildren(...sections);
    previousOwners = new Map(city.properties.map((property) => [property.id, state.owner[property.id]]));
    renderFooter(actorCash);
    if (savedScrollTop > 0) scrollArea.scrollTop = savedScrollTop;

    function propertyRow(property: Property): HTMLElement {
      const price = Math.round(purchasePrice(GAME_DATA, state, state.current, property.id));
      const owner = state.owner[property.id];
      const ownerPlayer = owner !== undefined ? state.players[owner] : undefined;
      const baseIncome = Math.round((property.price * property.yieldPct) / 100);
      const canAfford = actorCash >= price;
      const previousOwner = previousOwners.get(property.id);
      const justBought = options.buyMode && owner !== undefined && previousOwner === undefined;
      const buyable =
        options.buyMode && canAct && owner === undefined && canAfford && !(state.phase.t === 'sell' || state.phase.t === 'game_over');
      let action: HTMLElement;
      if (owner !== undefined) {
        action = h(
          'span',
          {
            class: 'property-owner',
            attrs: { style: `--owner-color:${playerColor(ownerPlayer)}` },
          },
          avatar(characterSprite(ownerPlayer ? charsById.get(ownerPlayer.characterId) : undefined), playerColor(ownerPlayer), 26),
          h('span', { text: ownerPlayer ? displayPlayerName(ownerPlayer) : '所有' }),
        );
      } else if (options.buyMode) {
        const buyButton = h('button', {
          class: 'btn btn-gold property-buy',
          text: canAfford ? '買う' : '資金不足',
          attrs: { type: 'button', disabled: !buyable },
          on: {
            click: () => {
              if (!buyable) return;
              buyButton.disabled = true;
              buyButton.textContent = '購入中…';
              options.onBuy(property.id);
            },
          },
        });
        action = buyButton;
      } else {
        action = h('span', { class: 'property-vacant muted', text: '空き物件' });
      }

      return h(
        'div',
        { class: `property-row industry-${property.industry} ${owner !== undefined ? 'is-owned' : ''} ${justBought ? 'just-bought' : ''}`.trim() },
        h(
          'span',
          { class: 'property-industry-chip', attrs: { 'aria-hidden': 'true' } },
          h(
            'span',
            {
              class: 'property-industry-badge',
              attrs: {
                style: `--industry-bg:${INDUSTRY_TONE[property.industry].bg};--industry-fg:${INDUSTRY_TONE[property.industry].fg}`,
                'aria-hidden': 'true',
              },
            },
            INDUSTRY_SHORT[property.industry],
          ),
          h('span', { class: 'property-industry-chip-label', text: INDUSTRY_JA[property.industry] }),
        ),
        h(
          'div',
          { class: 'property-main' },
          h('span', { class: 'property-name', text: property.name }),
        ),
        h(
          'div',
          { class: 'property-stats' },
          h('span', { class: 'property-price', text: formatOku(price) }),
          h('span', { class: 'property-income', text: `約 ${formatOkuShort(baseIncome)}/年` }),
          h('span', { class: 'property-yield', text: `${property.yieldPct}%` }),
        ),
        h(
          'div',
          { class: 'property-side' },
          action,
        ),
      );
    }

    function renderFooter(actorCash: number): void {
      if (!city) return;
      footer.replaceChildren();
      if (options.buyMode) {
        const plan = planBulkPurchase(city, state, actorCash);
        const vacantCount = plan.vacantCount;
        const allTotal = plan.allTotal;
        const shortfall = plan.shortfall;
        footer.append(
          h(
            'div',
            { class: 'city-footer-cash' },
            h('span', { class: 'muted', text: '所持金' }),
            h('strong', { class: actorCash < 0 ? 'money-negative' : '', text: formatOku(actorCash) }),
            !canAct ? h('span', { class: 'badge', text: '他のプレイヤーの手番' }) : null,
            canAct && vacantCount > 0
              ? h('span', {
                  class: 'city-bulk-summary',
                  text: shortfall > 0
            ? `全${vacantCount}件 ${formatOku(allTotal)} ・ 不足 ${formatOku(shortfall)}`
            : `全${vacantCount}件 ${formatOku(allTotal)}`,
                })
              : null,
          ),
        );
        if (canAct) {
          if (plan.items.length > 1 && options.onBuyAll) {
            const buyAll = h('button', {
              class: 'btn btn-gold city-buy-all',
              text: `まとめて買う（${plan.items.length}件・${formatOku(plan.total)}）`,
              attrs: { type: 'button' },
              on: {
                click: (event) => {
                  (event.currentTarget as HTMLButtonElement).disabled = true;
                  options.onBuyAll?.(plan.items.map((entry) => entry.property.id));
                },
              },
            });
            footer.append(buyAll);
          }
          footer.append(
            h('button', {
              class: 'btn btn-ghost city-end-buy',
              text: '購入を終える',
              attrs: { type: 'button' },
              on: {
                click: (event) => {
                  const btn = event.currentTarget as HTMLButtonElement;
                  btn.disabled = true;
                  btn.textContent = '手番を終えています…';
                  options.onEndBuy();
                },
              },
            }),
          );
        } else {
          footer.append(h('span', { class: 'muted', text: '手番の人が購入中です…' }));
        }
      } else {
        footer.append(
          h(
            'div',
            { class: 'city-footer-cash' },
            h('span', { class: 'muted', text: '所持金' }),
            h('strong', { class: actorCash < 0 ? 'money-negative' : '', text: formatOku(actorCash) }),
          ),
        );
        footer.append(
          h('button', {
            class: 'btn btn-gold',
            text: 'とじる',
            attrs: { type: 'button' },
            on: { click: () => modalHandle?.close() },
          }),
        );
      }
    }
  };

  render();

  const buyLocked = options.buyMode && (options.canAct || options.ownerWillAct === true);
  modalHandle = options.modal.open(body, {
    title: options.buyMode ? `${city.nameJa} — 物件を買う` : `${city.nameJa} の物件`,
    subtitle: options.buyMode ? '買える物件を選んでください。何件でも買えます。' : `${city.countryJa} ・ ${city.properties.length} 件の物件`,
    className: 'city-modal',
    dismissible: !buyLocked,
    onClose: options.onClose,
  });

  return {
    update(nextState: PublicState, nextCanAct: boolean) {
      state = nextState;
      canAct = nextCanAct;
      render();
    },
    close() {
      modalHandle?.close();
    },
  };
}