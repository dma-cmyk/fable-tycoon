import type { PublicState } from '../../core/engine';
import { purchasePrice } from '../../core/economy';
import type {Property} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import { LANDMARK_FILES } from '../assetManifest';
import {
  assetUrl,
  citiesById,
  cityNodeId,
  countryFlag,
  characterSprite,
  charsById,
  formatOku,
  formatOkuShort,
  INDUSTRY_ICON,
  INDUSTRY_JA,
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
  onBuyAll?: () => void;
  onEndBuy: () => void;
  onClose?: () => void;
}

export interface CitySheetHandle {
  update(state: PublicState, canAct: boolean): void;
  close(): void;
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
    const nodeId = cityNodeId(city.id);
    const landmarkAsset =
      city.landmark && LANDMARK_FILES.has(city.landmark)
        ? assetUrl(`assets/landmarks/${city.landmark}.webp`)
        : '';
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
      landmarkAsset
        ? h('img', {
            class: 'city-hero-landmark',
            attrs: { src: landmarkAsset, alt: '', loading: 'lazy', draggable: 'false' },
          })
        : h('span', { class: 'city-hero-emoji', text: '🏙️', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'city-hero-text' },
        h(
          'div',
          { class: 'city-hero-title-row' },
          h('h3', { class: 'city-hero-name', text: city.nameJa }),
          h('span', { class: 'city-flag', text: countryFlag(city.country) }),
          destination ? h('span', { class: 'badge badge-gold', text: '🎯 目的地' }) : null,
        ),
        h('p', { class: 'city-hero-sub', text: `${city.countryJa} ・ ${city.nameEn} ・ tier${city.tier}` }),
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

    const ownerCounts = new Map<number, number>();
    for (const property of city.properties) {
      const owner = state.owner[property.id];
      if (owner !== undefined) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    }
    const maxOwned = Math.max(0, ...ownerCounts.values());
    const progressPct = Math.round((maxOwned / Math.max(1, city.properties.length)) * 100);
    const monopoly = h(
      'div',
      { class: `city-monopoly-progress ${allSameOwner ? 'is-monopoly' : ''}`.trim() },
      h(
        'div',
        { class: 'city-monopoly-top' },
        h('span', { class: 'city-monopoly-label', text: allSameOwner ? '👑 都市独占！ 収益 2 倍' : '独占まであと少し' }),
        h('span', { class: 'city-monopoly-count', text: `${maxOwned} / ${city.properties.length} 件` }),
      ),
      h(
        'div',
        { class: 'progress city-monopoly-bar' },
        h('span', { attrs: { style: `width:${progressPct}%` } }),
      ),
      allSameOwner
        ? h('p', { class: 'city-monopoly-note', text: `${soleOwner !== undefined ? state.players[soleOwner]?.name ?? '誰か' : '誰か'} がすべての物件を所有。決算収益 2 倍。` })
        : null,
    );

    const list = h('div', { class: 'property-list' });
    const sorted = [...city.properties].sort((a, b) => purchasePrice(GAME_DATA, state, state.current, a.id) - purchasePrice(GAME_DATA, state, state.current, b.id));
    for (const property of sorted) list.append(propertyRow(property));

    body.replaceChildren(
      header,
      monopoly,
      h(
        'div',
        { class: 'property-table-head' },
        h('span', { text: '物件' }),
        h('span', { text: '価格 / オーナー' }),
      ),
      list,
      h('p', { class: 'city-node-note muted', text: `盤面マス: ${nodeId}` }),
      footer,
    );
    previousOwners = new Map(city.properties.map((property) => [property.id, state.owner[property.id]]));
    renderFooter(actorCash);

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
          h('span', { text: ownerPlayer?.name ?? '所有' }),
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
          h('span', { text: INDUSTRY_ICON[property.industry] }),
          h('span', { class: 'property-industry-chip-label', text: INDUSTRY_JA[property.industry] }),
        ),
        h(
          'div',
          { class: 'property-main' },
          h('span', { class: 'property-name', text: property.name }),
          h(
            'span',
            { class: 'property-meta' },
            h('span', { text: `収益率 ${property.yieldPct}%` }),
            h('span', { text: `約 ${formatOkuShort(baseIncome)}/年` }),
          ),
        ),
        h(
          'div',
          { class: 'property-side' },
          h('span', { class: 'property-price', text: formatOku(price) }),
          action,
        ),
      );
    }

    function renderFooter(actorCash: number): void {
      if (!city) return;
      footer.replaceChildren();
      if (options.buyMode) {
        footer.append(
          h(
            'div',
            { class: 'city-footer-cash' },
            h('span', { class: 'muted', text: '手番プレイヤーの所持金' }),
            h('strong', { class: actorCash < 0 ? 'money-negative' : '', text: formatOku(actorCash) }),
            !canAct ? h('span', { class: 'badge', text: '他のプレイヤーの手番' }) : null,
          ),
        );
        if (canAct) {
          const affordable = city.properties.filter(
            (property) => state.owner[property.id] === undefined && actorCash >= Math.round(purchasePrice(GAME_DATA, state, state.current, property.id)),
          ).length;
          if (affordable > 1 && options.onBuyAll) {
            footer.append(
              h('button', {
                class: 'btn btn-red city-buy-all',
                text: `🛒 まとめて買う（${affordable}件）`,
                attrs: { type: 'button' },
                on: {
                  click: (event) => {
                    (event.currentTarget as HTMLButtonElement).disabled = true;
                    options.onBuyAll?.();
                  },
                },
              }),
            );
          }
          footer.append(
            h('button', {
              class: 'btn btn-gold city-end-buy',
              text: '✔ 購入を終える',
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
            h('span', { class: 'muted', text: '現在の所持金（手番）' }),
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