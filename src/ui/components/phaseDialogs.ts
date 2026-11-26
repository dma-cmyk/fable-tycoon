import {  currentPrice, distance as boardDistance, type PublicState } from '../../core/engine';
import { WARP_MIN_DEST_STEPS } from '../../core/warpRules';
import type {CardDef, City} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import {
 
  cardsById,
  characterSprite,
  charsById,
  citiesById,
  cityNodeId,
  formatOku,
  formatOkuShort,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  countryFlag,
  nodesById,
  playerColor,
  propertiesById,
} from '../format';
import { cityMoveInfo, moveChipPriceLabel, type CityMoveInfo } from '../moveChipInfo';
import {
  buildWarpCandidates,
  sortWarpCandidates,
  warpDestinationRange,
  warpGainText,
  type WarpCandidate,
  type WarpSortMode,
} from '../warpInfo';

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
  /** Candidate highlight (PC only): pan the map and draw the warp line. */
  onPreview?: (target: string | null) => void;
}

export function openCardTargetDialog(options: CardTargetOptions): ModalHandle {
  const def = cardsById.get(options.cardId);
  const portal = options.cardId === 'portal';
  const rocket = options.cardId === 'rocket';
  const carpet = options.cardId === 'carpet';
  const body = h('div', { class: 'target-dialog' });
  const list = h('div', { class: 'target-list' });
  const actor = options.state.players[options.state.current];
  const cityOptions = options.options.filter((target) => target !== 'r:space' && !/^\d+$/.test(target) && !target.startsWith('p:'));
  const cityByTarget = new Map<string, City>();
  for (const target of cityOptions) {
    const node = nodesById.get(target);
    const city = node?.cityId ? citiesById.get(node.cityId) : undefined;
    if (city) cityByTarget.set(target, city);
  }
  const cityTargets = [...cityByTarget.entries()].map(([target, city]) => ({ target, city }));
  const cityPicker =
    cityTargets.length > 0 &&
    options.options.every((target) => target === 'r:space' || cityByTarget.has(target));
  const errand = options.state.errand ?? null;
  const errandNodeId = errand?.cityId ? cityNodeId(errand.cityId) : null;
  const destinationNodeId = cityNodeId(options.state.destination);
  const hereNodeId = actor?.nodeId ?? null;
  const candidates = cityPicker
    ? buildWarpCandidates({
        sources: cityTargets.map(({ target, city }) => ({ nodeId: target, city })),
        hereNodeId,
        destinationNodeId,
        errandNodeId,
        // The HUD and engine measure realms with effectiveDistance; the picker must agree.
        distance: (from, to) => boardDistance(GAME_DATA, from, to),
      })
    : [];
  const candidateByNode = new Map(candidates.map((candidate) => [candidate.nodeId, candidate]));
  const infoByNode = new Map<string, CityMoveInfo>();
  for (const { target, city } of cityTargets) {
    infoByNode.set(target, cityMoveInfo(GAME_DATA, options.state, options.state.current, city));
  }
  const destinationSteps =
    hereNodeId !== null ? boardDistance(GAME_DATA, hereNodeId, destinationNodeId) : Number.NaN;
  const errandSteps =
    hereNodeId !== null && errandNodeId !== null
      ? boardDistance(GAME_DATA, hereNodeId, errandNodeId)
      : Number.NaN;
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

  const nowDistanceText = Number.isFinite(destinationSteps) ? `いま ${destinationSteps} マス` : 'いまの距離は不明';
  if (cityPicker) {
    const destinationCity = citiesById.get(options.state.destination);
    const range = carpet ? warpDestinationRange(candidates) : null;
    const rangeText = range
      ? range.min === range.max
        ? `${range.min} マス`
        : `${range.min}〜${range.max} マス`
      : '—';
    body.append(
      h(
        'div',
        { class: 'warp-summary' },
        h(
          'p',
          { class: 'warp-summary-line' },
          h('span', { class: 'warp-summary-label', text: '目的地' }),
          h('strong', { text: destinationCity?.nameJa ?? options.state.destination }),
          h('span', {
            class: 'warp-summary-now',
            text: Number.isFinite(destinationSteps) ? `まで いま ${destinationSteps} マス` : 'まで —',
          }),
        ),
        errand
          ? h('p', {
              class: 'warp-summary-errand',
              text: `寄り道依頼「${errand.title}」の街まで ${
                Number.isFinite(errandSteps) ? `${errandSteps} マス` : '—'
              }`,
            })
          : null,
        carpet
          ? h('p', {
              class: 'warp-carpet',
              text:
                range && range.min >= 5 && range.max <= 10
                  ? `じゅうたんは 目的地から ${rangeText}のどこかへ着地する（${nowDistanceText}）。`
                  : `候補は 目的地から ${rangeText}（${nowDistanceText}）。`,
            })
          : null,
        h('p', {
          class: 'warp-summary-note',
          text: `数字は着地した後の目的地までのマス数。小さいほど近い。目的地まで残り ${WARP_MIN_DEST_STEPS} マス未満の都市へは着地できない。`,
        }),
      ),
    );
  }
  if (search) body.append(search);

  let sortMode: WarpSortMode = 'distance';
  const sortButtons: HTMLButtonElement[] = [];
  const itemByNode = new Map<string, HTMLButtonElement>();
  const applySort = (): void => {
    for (const candidate of sortWarpCandidates(candidates, sortMode)) {
      const item = itemByNode.get(candidate.nodeId);
      if (item) list.append(item);
    }
    for (const button of sortButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.sort === sortMode));
    }
  };
  if (cityPicker) {
    const sortSeg = h('div', {
      class: 'seg warp-sort',
      attrs: { role: 'group', 'aria-label': '候補の並べ替え' },
    });
    for (const [mode, label] of [
      ['distance', '目的地まで近い順'],
      ['name', '名前順'],
    ] as const) {
      const sortButton = h('button', {
        class: 'seg-btn',
        text: label,
        dataset: { sort: mode },
        attrs: { type: 'button', 'aria-pressed': String(mode === sortMode) },
        on: {
          click: () => {
            sortMode = mode;
            applySort();
          },
        },
      });
      sortButtons.push(sortButton);
      sortSeg.append(sortButton);
    }
    body.append(
      h(
        'div',
        { class: 'warp-toolbar' },
        sortSeg,
        h('span', { class: 'warp-count muted', text: `${candidates.length} 都市` }),
      ),
    );
  }

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
    const candidate = candidateByNode.get(target);
    const info = infoByNode.get(target);
    const button =
      candidate && info
        ? cityTargetButton(options.state, candidate, info, () => {
            if (!options.canAct) return;
            button.disabled = true;
            button.classList.add('is-busy');
            options.onTarget(target);
          }, (nodeId) => options.onPreview?.(nodeId))
        : targetButton(options.state, target, () => {
            if (!options.canAct) return;
            button.disabled = true;
            button.classList.add('is-busy');
            options.onTarget(target);
          });
    button.disabled = !options.canAct || candidate?.blocked === true;
    list.append(button);
    if (candidate) itemByNode.set(target, button);
  }
  if (cityPicker) applySort();
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

  const handle = options.modal.open(body, {
    title: `🎴 ${def?.name ?? 'カード'} — 対象を選ぶ`,
    subtitle: '対象をえらぶと効果が発動します',
    className: cityPicker ? 'target-modal warp-target-modal' : 'target-modal',
    dismissible: !options.canAct,
    onClose: () => {
      options.onPreview?.(null);
    },
  });
  if (cityPicker) handle.root.classList.add('warp-target-backdrop');
  return handle;
}

function cityTargetButton(
  state: PublicState,
  candidate: WarpCandidate,
  info: CityMoveInfo,
  onPick: () => void,
  onPreview: (nodeId: string | null) => void,
): HTMLButtonElement {
  const ownerNames = info.otherOwnerIds
    .map((id) => state.players[id]?.name)
    .filter((name): name is string => !!name);
  const tone =
    candidate.toDestination === null
      ? ''
      : candidate.toDestination <= 10
        ? 'is-close'
        : candidate.toDestination <= 22
          ? 'is-mid'
          : 'is-far';
  const gainText = warpGainText(candidate.gain);
  return h(
    'button',
    {
      class: 'target-item target-item-city',
      dataset: {
        search: `${candidate.nameJa} ${candidate.nameEn} ${candidate.countryJa}`.toLowerCase(),
        node: candidate.nodeId,
      },
      attrs: { type: 'button' },
      on: {
        click: onPick,
        pointerenter: () => onPreview(candidate.nodeId),
        focus: () => onPreview(candidate.nodeId),
        pointerleave: () => onPreview(null),
      },
    },
    h('span', { class: 'target-icon', text: countryFlag(candidate.country) }),
    h(
      'span',
      { class: 'target-main' },
      h(
        'span',
        { class: 'target-name-row' },
        h('span', { class: 'target-name', text: candidate.nameJa }),
        h(
          'span',
          { class: `warp-dist ${tone}` },
          h('span', { class: 'warp-dist-label', text: '目的地まで' }),
          h('strong', { text: candidate.toDestination === null ? '—' : String(candidate.toDestination) }),
        ),
      ),
      h('span', { class: 'target-meta muted', text: `${candidate.countryJa} ・ ${candidate.nameEn}` }),
      h(
        'span',
        { class: 'warp-tags' },
        gainText
          ? h('span', {
              class: `warp-tag ${
                candidate.gain !== null && candidate.gain < 0
                  ? 'is-gain'
                  : candidate.gain !== null && candidate.gain > 0
                    ? 'is-loss'
                    : ''
              }`,
              text: gainText,
            })
          : null,
        candidate.fromHere !== null
          ? h('span', { class: 'warp-tag', text: `現在地から ${candidate.fromHere}` })
          : null,
        h('span', {
          class: `warp-tag ${
            info.cheapest === null ? '' : info.affordable ? 'is-ok' : 'is-over'
          }`,
          text: info.cheapest === null ? '空きなし' : `最安 ${moveChipPriceLabel(info)}`,
        }),
        ownerNames.length > 0
          ? h('span', {
              class: 'warp-tag is-owner',
              text:
                ownerNames.length === 1
                  ? `${ownerNames[0]}所有`
                  : `${ownerNames[0]}他${ownerNames.length - 1}人`,
            })
          : null,
        candidate.toErrand !== null
          ? h('span', { class: 'warp-tag is-errand', text: `依頼まで ${candidate.toErrand}` })
          : null,
        candidate.blockedReason !== null
          ? h('span', { class: 'warp-tag is-blocked', text: candidate.blockedReason })
          : null,
      ),
    ),
    h('span', { class: 'target-go', text: '▶' }),
  );
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