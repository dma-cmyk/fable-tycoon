import {  currentPrice, type PublicState } from '../../core/engine';
import type {CardDef} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import {
 
  cardsById,
  characterSprite,
  charsById,
  citiesById,
  formatOku,
  formatOkuShort,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  countryFlag,
  nodesById,
  playerColor,
  propertiesById,
} from '../format';

// ---------------------------------------------------------------- card target

export interface CardTargetOptions {
  modal: ModalHost;
  state: PublicState;
  canAct: boolean;
  cardId: string;
  options: string[];
  onTarget: (target: string) => void;
  onCancel: () => void;
  onPickOnMap?: () => void;
}

export function openCardTargetDialog(options: CardTargetOptions): ModalHandle {
  const def = cardsById.get(options.cardId);
  const portal = options.cardId === 'portal';
  const rocket = options.cardId === 'rocket';
  const body = h('div', { class: 'target-dialog' });
  const list = h('div', { class: 'target-list' });
  const actor = options.state.players[options.state.current];
  const cityOptions = options.options.filter((target) => target !== 'r:space' && !/^\d+$/.test(target) && !target.startsWith('p:'));
  const search = cityOptions.length > 6
    ? h('input', {
        class: 'input target-search',
        attrs: { type: 'search', placeholder: '都市名で絞り込む', 'aria-label': '対象都市を検索', autocomplete: 'off' },
        on: {
          input: () => {
            const q = (search?.value ?? '').trim().toLowerCase();
            for (const child of list.children) {
              if (!(child instanceof HTMLElement) || !child.dataset.search) continue;
              child.hidden = !!q && !child.dataset.search.includes(q);
            }
          },
        },
      })
    : null;
  body.append(
    h('p', {
      class: 'target-copy',
      text: portal
        ? '出口の行き先を選んでください。空港都市へ再突入します。'
        : rocket
          ? 'ロケットの行き先を選んでください。すべての都市へ打ち上げ可能。宇宙特区も選べます。'
          : def
            ? `${def.name} の対象を選んでください。${def.needsTarget === 'city' || def.needsTarget === 'airport' ? '都市を選ぶとワープします。' : ''}`
            : '対象を選んでください。',
    }),
  );
  if (search) body.append(search);
  if (options.canAct && options.onPickOnMap && cityOptions.length > 0) {
    body.append(
      h('button', {
        class: 'btn btn-ghost target-map-btn',
        text: '📍 地図の都市をタップして選ぶ',
        attrs: { type: 'button' },
        on: {
          click: () => {
            options.onPickOnMap?.();
          },
        },
      }),
    );
  }

  if (rocket && options.options.includes('r:space')) {
    const button = h(
      'button',
      {
        class: 'target-space',
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (!options.canAct) return;
            button.disabled = true;
            options.onTarget('r:space');
          },
        },
      },
      h('span', { class: 'target-space-icon', text: '🚀' }),
      h(
        'span',
        { class: 'target-space-text' },
        h('strong', { text: '宇宙へ行く' }),
        h('span', { text: '宇宙ビジネス特区へ打ち上げ。青・赤マス 1.5 倍。' }),
      ),
      h('span', { class: 'target-go', text: '▶' }),
    );
    button.disabled = !options.canAct;
    list.append(button);
  }

  for (const target of options.options) {
    if (target === 'r:space') continue;
    const button = targetButton(options.state, target, () => {
      if (!options.canAct) return;
      button.disabled = true;
      button.classList.add('is-busy');
      options.onTarget(target);
    });
    button.disabled = !options.canAct;
    list.append(button);
  }
  if (options.options.length === 0) {
    list.append(h('p', { class: 'empty-state', text: '選べる対象がありません。' }));
  }
  body.append(list);

  if (options.canAct && !portal) {
    body.append(
      h(
        'div',
        { class: 'target-footer' },
        h('span', {
          class: 'muted',
          text: def?.name === '敵対的買収' ? '現在価格の 1.5 倍で強制購入します。' : 'カードの使用を取り消すと手札に戻ります。',
        }),
        h('button', {
          class: 'btn btn-ghost',
          text: 'キャンセル',
          attrs: { type: 'button' },
          on: {
            click: (event) => {
              (event.currentTarget as HTMLButtonElement).disabled = true;
              options.onCancel();
            },
          },
        }),
      ),
    );
  } else {
    body.append(h('p', { class: 'muted center', text: `${actor?.name ?? '手番の人'} が対象を選んでいます…` }));
  }

  return options.modal.open(body, {
    title: `🎴 ${def?.name ?? 'カード'} — 対象を選ぶ`,
    subtitle: '対象をえらぶと効果が発動します',
    className: 'target-modal',
    dismissible: !options.canAct,
  });
}

function targetButton(state: PublicState, target: string, onClick: () => void): HTMLButtonElement {
  if (/^\d+$/.test(target)) {
    const player = state.players[Number(target)];
    const character = player ? charsById.get(player.characterId) : undefined;
    return h(
      'button',
      {
        class: 'target-item',
        dataset: { search: `${player?.name ?? ''} ${character?.nameJa ?? ''}`.toLowerCase() },
        attrs: { type: 'button' },
        on: { click: onClick },
      },
      player
        ? avatar(characterSprite(character), character?.color ?? playerColor(player), 46)
        : h('span', { class: 'target-icon', text: '👤' }),
      h(
        'span',
        { class: 'target-main' },
        h('span', { class: 'target-name', text: player?.name ?? `プレイヤー ${target}` }),
        h('span', {
          class: 'target-meta muted',
          text: player ? `${character?.nameJa ?? ''} ・ 所持金 ${formatOku(player.cash)}` : '',
        }),
      ),
      h('span', { class: 'target-go', text: '▶' }),
    );
  }
  if (target.startsWith('p:')) {
    const propertyId = target.slice(2);
    const ref = propertiesById.get(propertyId);
    const owner = state.owner[propertyId];
    const ownerPlayer = owner !== undefined ? state.players[owner] : undefined;
    const cost = Math.round(currentPrice(GAME_DATA, state, propertyId) * 1.5);
    return h(
      'button',
      {
        class: 'target-item',
        dataset: { search: `${ref?.city.nameJa ?? ''} ${ref?.property.name ?? ''}`.toLowerCase() },
        attrs: { type: 'button' },
        on: { click: onClick },
      },
      h('span', { class: 'target-icon', text: ref ? INDUSTRY_ICON[ref.property.industry] : '🏢' }),
      h(
        'span',
        { class: 'target-main' },
        h('span', { class: 'target-name', text: ref?.property.name ?? propertyId }),
        h('span', {
          class: 'target-meta muted',
          text: ref ? `${ref.city.nameJa} ・ ${INDUSTRY_JA[ref.property.industry]} ・ 所有者 ${ownerPlayer?.name ?? '—'} ・ 買収額 ${formatOku(cost)}` : '',
        }),
      ),
      h('span', { class: 'target-go', text: '▶' }),
    );
  }
  const city = nodesById.get(target)?.cityId ? citiesById.get(nodesById.get(target)?.cityId ?? '') : undefined;
  return h(
    'button',
    {
      class: 'target-item',
      dataset: { search: `${city?.nameJa ?? target} ${city?.nameEn ?? ''} ${city?.countryJa ?? ''}`.toLowerCase() },
      attrs: { type: 'button' },
      on: { click: onClick },
    },
    h('span', { class: 'target-icon', text: city ? countryFlag(city.country) : '✈️' }),
    h(
      'span',
      { class: 'target-main' },
      h('span', { class: 'target-name', text: city?.nameJa ?? target }),
      h('span', { class: 'target-meta muted', text: city ? `${city.countryJa} ・ ${city.nameEn}` : '' }),
    ),
    h('span', { class: 'target-go', text: '▶' }),
  );
}

// ---------------------------------------------------------------- discard

export interface DiscardOptions {
  modal: ModalHost;
  state: PublicState;
  canAct: boolean;
  onDiscard: (cardId: string) => void;
}

export function openDiscardDialog(options: DiscardOptions): ModalHandle | null {
  const player = options.state.players[options.state.current];
  if (!player) return null;
  const character = charsById.get(player.characterId);
  const limit = character?.perk === 'card_shark' ? 10 : 8;
  const body = h(
    'div',
    { class: 'discard-dialog' },
    h('p', {
      class: 'target-copy',
      text: `手札が上限を超えています（${player.cards.length} / ${limit}）。捨てるカードを選んでください。`,
    }),
  );
  if (options.canAct) {
    const list = h('div', { class: 'discard-list' });
    const counts = new Map<string, number>();
    for (const cardId of player.cards) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
    for (const [cardId, count] of counts) {
      const def = cardsById.get(cardId);
      if (!def) continue;
      list.append(discardRow(def, count, () => options.onDiscard(cardId)));
    }
    body.append(list);
  } else {
    body.append(h('p', { class: 'muted center', text: `${player.name} がカードを捨てています…` }));
  }
  return options.modal.open(body, {
    title: '🃏 手札を減らす',
    subtitle: '手札上限を超えた分を捨てる',
    className: 'discard-modal',
    dismissible: !options.canAct,
  });
}

function discardRow(def: CardDef, count: number, onDiscard: () => void): HTMLElement {
  return h(
    'div',
    { class: 'discard-row' },
    h(
      'span',
      { class: 'discard-main' },
      h('span', { class: 'discard-name', text: def.name }),
      h('span', { class: 'discard-desc muted', text: def.desc }),
    ),
    count > 1 ? h('span', { class: 'badge', text: `×${count}` }) : null,
    h('button', {
      class: 'btn btn-red btn-small',
      text: '捨てる',
      attrs: { type: 'button' },
      on: { click: onDiscard },
    }),
  );
}

// ---------------------------------------------------------------- sell

export interface SellOptions {
  modal: ModalHost;
  state: PublicState;
  canAct: boolean;
  onSell: (propertyId: string) => void;
}

export function openSellDialog(options: SellOptions): ModalHandle | null {
  const player = options.state.players[options.state.current];
  if (!player) return null;
  const owned = Object.entries(options.state.owner)
    .filter((entry) => entry[1] === player.id)
    .map((entry) => entry[0]);
  const need = Math.max(0, -player.cash);
  const body = h(
    'div',
    { class: 'sell-dialog' },
    h(
      'div',
      { class: 'sell-head' },
      h('span', { class: 'sell-badge', text: '支払い不足' }),
      h('strong', { class: 'sell-amount', text: formatOku(player.cash) }),
      h('span', { class: 'muted', text: `あと ${formatOku(need)} を用意する必要があります` }),
    ),
    h('p', {
      class: 'target-copy',
      text: '物件を売却すると、現在価格の 7 割が手元に入ります。売れる物件がなくなると、借金として繰り越します。',
    }),
  );
  if (owned.length === 0) {
    body.append(h('p', { class: 'empty-state', text: '売却できる物件がありません。借金として次の手番へ繰り越します。' }));
  } else if (options.canAct) {
    const list = h('div', { class: 'sell-list' });
    for (const propertyId of owned) {
      const ref = propertiesById.get(propertyId);
      if (!ref) continue;
      const value = Math.round(currentPrice(GAME_DATA, options.state, propertyId) * 0.7);
      const button = h('button', {
        class: 'btn btn-gold btn-small sell-button',
        text: '売る',
        attrs: { type: 'button' },
        on: {
          click: () => {
            button.disabled = true;
            button.textContent = '売却中…';
            options.onSell(propertyId);
          },
        },
      });
      list.append(
        h(
          'div',
          { class: 'sell-row' },
          h('span', { class: 'sell-icon', text: INDUSTRY_ICON[ref.property.industry], attrs: { 'aria-hidden': 'true' } }),
          h(
            'span',
            { class: 'sell-main' },
            h('span', { class: 'sell-name', text: ref.property.name }),
            h('span', { class: 'sell-meta muted', text: `${ref.city.nameJa} ・ 現在価格 ${formatOku(Math.round(currentPrice(GAME_DATA, options.state, propertyId)))}` }),
          ),
          h('span', { class: 'sell-value', text: `+${formatOkuShort(value)}` }),
          button,
        ),
      );
    }
    body.append(list);
  } else {
    body.append(h('p', { class: 'muted center', text: `${player.name} が支払いのため物件を売却しています…` }));
  }
  return options.modal.open(body, {
    title: '💸 支払いのため売却',
    subtitle: '所持金がマイナス。物件を 7 割で現金化',
    className: 'sell-modal',
    dismissible: !options.canAct,
  });
}