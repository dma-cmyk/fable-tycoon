import type { PublicState } from '../../core/engine';
import { yearScale } from '../../core/economy';
import type {CardDef} from '../../core/types';
import { h, uiIcon, type ModalHandle, type ModalHost } from '../dom';
import {
  assetUrl,
  cardsById,
  charsById,
  formatOku,
  npcsById,
} from '../format';
import { cardVehicle, vehicleBadge } from '../vehicles';

export interface ShopDialogOptions {
  modal: ModalHost;
  state: PublicState;
  canAct: boolean;
  onBuy: (cardId: string) => void;
  onSell: (cardId: string) => void;
  onEnd: () => void;
}

export interface ShopHandle {
  update(state: PublicState, canAct: boolean): void;
  close(): void;
}

export function openShopDialog(options: ShopDialogOptions): ShopHandle {
  let state = options.state;
  let canAct = options.canAct;
  let modalHandle: ModalHandle | null = null;
  let renderedOnce = false;
  const scroll = h('div', { class: 'shop-scroll scroll-y' });
  const footer = h('footer', { class: 'shop-footer' });
  const body = h('div', { class: 'shop-dialog' }, scroll, footer);

  const render = (): void => {
    const player = state.players[state.current];
    if (!player) return;
    const savedScrollTop = scroll.scrollTop;
    const savedScrollLeft = scroll.scrollLeft;
    if (renderedOnce) body.classList.add('is-updated');
    const character = charsById.get(player.characterId);
    const shopkeeper = npcsById.get('midas');
    const shopkeeperSprite = shopkeeper?.sprite ? assetUrl(shopkeeper.sprite) : '';
    const scale = yearScale(state);
    const handLimit = character?.perk === 'card_shark' ? 10 : 8;
    const priceOf = (card: CardDef): number => Math.round((card.price || 30) * scale);
    const sellPrice = (card: CardDef): number => Math.round(priceOf(card) * 0.5);

    const stockHost = h('div', { class: 'shop-stock' });
    const stock = state.phase.t === 'shop' ? state.phase.stock : [];
    const stockCount = stock.length;
    stock.forEach((cardId, index) => {
      const card = cardsById.get(cardId);
      if (!card) return;
      const price = priceOf(card);
      const canBuy = canAct && player.cash >= price;
      stockHost.append(
        h(
          'article',
          { class: `shop-card ${canBuy ? '' : 'is-unaffordable'}`.trim(), attrs: { style: `--i:${index}` } },
          h('span', { class: 'shop-card-art' }, cardVehicleBadge(card)),
          h(
            'span',
            { class: 'shop-card-main' },
            h('span', { class: 'shop-card-name', text: card.name }),
            h('span', { class: 'shop-card-desc', text: card.desc }),
          ),
          h('span', { class: 'shop-price-tag', text: formatOku(price) }),
          h('button', {
            class: 'btn btn-gold btn-small shop-buy',
            text: canBuy ? '買う' : player.cash >= price ? '手番待ち' : '資金不足',
            attrs: { type: 'button', disabled: !canBuy },
            on: {
              click: (event) => {
                (event.currentTarget as HTMLButtonElement).disabled = true;
                options.onBuy(cardId);
              },
            },
          }),
        ),
      );
    });
    if (stockCount === 0) {
      stockHost.append(h('p', { class: 'shop-empty', text: '棚は空っぽだ。また来たまえ。' }));
    }

    const handCounts = new Map<string, number>();
    for (const id of player.cards) handCounts.set(id, (handCounts.get(id) ?? 0) + 1);
    const handHost = h('div', { class: 'shop-hand' });
    if (player.cards.length === 0) {
      handHost.append(h('p', { class: 'shop-empty', text: '手持ちのカードはない。' }));
    } else {
      for (const [cardId, count] of handCounts) {
        const card = cardsById.get(cardId);
        if (!card) continue;
        handHost.append(
          h(
            'div',
            { class: 'shop-hand-card' },
            cardVehicleBadge(card, 26),
            h(
              'span',
              { class: 'shop-hand-main' },
              h('span', { class: 'shop-hand-name', text: card.name }),
              h('span', { class: 'shop-hand-meta muted', text: `売値 ${formatOku(sellPrice(card))} ×${count}` }),
            ),
            h('button', {
              class: 'btn btn-ghost btn-small',
              text: '売る',
              attrs: { type: 'button', disabled: !canAct },
              on: {
                click: (event) => {
                  (event.currentTarget as HTMLButtonElement).disabled = true;
                  options.onSell(cardId);
                },
              },
            }),
          ),
        );
      }
    }

    const speech = canAct
      ? stockCount > 0
        ? `残り${stockCount}枚の在庫だ。買うも売るも、金次第。気に入ったら札束を置いていきな。`
        : '棚は売り切れだ。手持ちカードを売るか、また来たまえ。'
      : `${player.name} が品定め中だ。ゆっくり待とう。`;

    scroll.replaceChildren(
      h(
        'header',
        { class: 'shop-head' },
        h(
          'span',
          { class: 'shopkeeper' },
          shopkeeperSprite
            ? h('img', { attrs: { src: shopkeeperSprite, alt: 'ミダス商会の店主', draggable: 'false' } })
            : h('span', { class: 'shopkeeper-fallback', text: '👑' }),
        ),
        h(
          'div',
          { class: 'shop-head-text' },
          h('span', { class: 'shop-name', text: 'ミダス商会 カード売り場' }),
          h('p', { class: 'shop-speech', text: speech }),
        ),
        h(
          'div',
          { class: 'shop-cash' },
          h('span', { class: 'muted', text: '所持金' }),
          h('strong', { class: player.cash < 0 ? 'money-negative' : '', text: formatOku(player.cash) }),
        ),
      ),
      h(
        'section',
        { class: 'shop-section' },
        h(
          'div',
          { class: 'shop-section-head' },
          h('h3', { class: 'shop-section-title' }, uiIcon('cards', '🃏', 'shop-section-icon'), `棚のカード（残り ${stockCount}枚）`),
          h('span', { class: 'muted', text: '価格は年数で変動' }),
        ),
        stockHost,
      ),
      h(
        'section',
        { class: 'shop-section' },
        h(
          'div',
          { class: 'shop-section-head' },
          h('h3', { class: 'shop-section-title' }, uiIcon('cards', '🃏', 'shop-section-icon'), '手持ちのカード'),
          h('span', { class: 'badge', text: `手札 ${player.cards.length} / ${handLimit}` }),
        ),
        handHost,
      ),
    );
    footer.replaceChildren(
      h('span', { class: 'muted shop-footer-note', text: '売却は半額。買い物のあと「店を出る」で手番を続けます。' }),
      h(
        'span',
        { class: 'shop-footer-cash' },
        h('span', { class: 'muted', text: '所持金 ' }),
        h('strong', { class: player.cash < 0 ? 'money-negative' : '', text: formatOku(player.cash) }),
      ),
      canAct
        ? h('button', {
            class: 'btn btn-ghost shop-leave',
            text: '店を出る',
            attrs: { type: 'button' },
            on: {
              click: (event) => {
                (event.currentTarget as HTMLButtonElement).disabled = true;
                options.onEnd();
              },
            },
          })
        : h('span', { class: 'muted', text: '手番の人が買い物中…' }),
    );
    if (renderedOnce) {
      scroll.scrollTop = savedScrollTop;
      scroll.scrollLeft = savedScrollLeft;
    }
    renderedOnce = true;
  };

  render();
  modalHandle = options.modal.open(body, {
    title: 'カード売り場',
    subtitle: '買うも売るも、所持金しだい。',
    className: 'modal-wide shop-modal',
    dismissible: !canAct,
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

function cardVehicleBadge(card: CardDef, size = 40): HTMLElement {
  const vehicle = cardVehicle(card.id);
  return h(
    'span',
    { class: 'shop-card-vehicle', attrs: { style: `--vsize:${size}px` } },
    vehicle ? vehicleBadge(vehicle, size) : cardKindIcon(card),
  );
}

const CARD_KIND_ICON: Record<CardDef['kind'], [string, string]> = {
  move: ['flag', '🚩'],
  money: ['moneybag', '💰'],
  attack: ['treasure', '⚔️'],
  defense: ['property', '🛡️'],
  special: ['keyart', '✨'],
};

function cardKindIcon(card: CardDef): HTMLElement {
  const [name, fallback] = CARD_KIND_ICON[card.kind] ?? ['cards', '🃏'];
  return h('span', { class: 'shop-card-icon' }, uiIcon(name, fallback, 'shop-card-icon-mark'));
}

