import type { GameState } from '../../core/types';
import { h, type ModalHandle, type ModalHost } from '../dom';
import { cardsById } from '../format';
import { cardVehicle, vehicleBadge } from '../vehicles';

export interface CardsDialogOptions {
  modal: ModalHost;
  state: GameState;
  seat: number;
  canAct: boolean;
  onUse: (cardId: string) => void;
}

const KIND_LABEL = {
  move: '移動',
  money: 'お金',
  attack: '攻撃',
  defense: '防御',
  special: '特殊',
} as const;

export function openCardsDialog(options: CardsDialogOptions): ModalHandle | null {
  const player = options.state.players[options.seat];
  if (!player) return null;
  const handLimit = player.characterId === 'momo_monkey' ? 10 : 8;
  const body = h('div', { class: 'cards-dialog' });

  body.append(
    h(
      'div',
      { class: 'cards-summary' },
      h('span', { class: 'badge badge-gold', text: `手札 ${player.cards.length} / ${handLimit}` }),
      h('span', {
        class: 'muted',
        text:
          options.state.phase.t === 'turn_start'
            ? '手番開始時のみ使えます。1 手番に 1 枚。'
            : 'カードは自分の手番開始時に使えます。',
      }),
    ),
  );

  if (player.cards.length === 0) {
    body.append(
      h(
        'div',
        { class: 'empty-state' },
        h('span', { class: 'empty-state-icon', text: '🃏' }),
        h('p', { text: '手札はありません。黄マスに止まるとカードがもらえます。' }),
      ),
    );
  } else {
    const list = h('div', { class: 'cards-list' });
    const counts = new Map<string, number>();
    for (const id of player.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => {
      const ca = cardsById.get(a[0]);
      const cb = cardsById.get(b[0]);
      return (ca?.kind ?? '').localeCompare(cb?.kind ?? '') || (ca?.name ?? '').localeCompare(cb?.name ?? '');
    });
    for (const [cardId, count] of sorted) {
      const def = cardsById.get(cardId);
      if (!def) continue;
      const usable = options.canAct && options.state.phase.t === 'turn_start';
      list.append(
        h(
          'div',
          { class: `card-item card-kind-${def.kind}` },
          h(
            'div',
            { class: 'card-item-top' },
            cardVehicle(def.id)
              ? vehicleBadge(cardVehicle(def.id)!, 30)
              : h('span', { class: 'card-item-icon', text: KIND_ICON[def.kind], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'card-item-name', text: def.name }),
            count > 1 ? h('span', { class: 'badge', text: `×${count}` }) : null,
            h('span', { class: 'badge badge-kind', text: KIND_LABEL[def.kind] }),
          ),
          h('p', { class: 'card-item-desc', text: def.desc }),
          h(
            'div',
            { class: 'card-item-actions' },
            h('span', {
              class: 'card-item-note',
              text: def.needsTarget ? '使用後に相手・都市を選びます' : '',
            }),
            h('button', {
              class: 'btn btn-gold btn-small',
              text: usable ? 'このカードを使う' : 'いまは使えない',
              attrs: { type: 'button', disabled: !usable },
              on: {
                click: (event) => {
                  const btn = event.currentTarget as HTMLButtonElement;
                  btn.disabled = true;
                  btn.textContent = '使用中…';
                  options.onUse(cardId);
                },
              },
            }),
          ),
        ),
      );
    }
    body.append(list);
  }

  return options.modal.open(body, {
    title: `🃏 カード（${player.name}）`,
    subtitle: 'カードは演出ではなく、ゲームを動かす。',
    className: 'cards-modal',
  });
}

const KIND_ICON = {
  move: '🚄',
  money: '💴',
  attack: '⚔️',
  defense: '🛡️',
  special: '✨',
} as const;