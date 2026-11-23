import { currentPrice } from '../../core/engine';
import type { City, GameState } from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { h, type ModalHost } from '../dom';
import {
  countryFlag,
  formatOku,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  playerColor,
} from '../format';

export interface PropertyCatalogOptions {
  modal: ModalHost;
  state: GameState;
  seat: number;
}

export function openPropertyCatalog(options: PropertyCatalogOptions): void {
  let query = '';
  const list = h('div', { class: 'catalog-list' });
  const count = h('span', { class: 'catalog-count muted' });

  const render = (): void => {
    const q = query.toLowerCase();
    const cities = GAME_DATA.cities
      .filter((city) => {
        if (!q) return true;
        if (`${city.nameJa} ${city.nameEn} ${city.countryJa}`.toLowerCase().includes(q)) return true;
        return city.properties.some((property) => property.name.toLowerCase().includes(q));
      })
      .sort((a, b) => a.tier - b.tier || (b.properties.length - a.properties.length));

    list.replaceChildren();
    let totalProperties = 0;
    for (const city of cities) {
      totalProperties += city.properties.length;
      list.append(cityBlock(city));
    }
    count.textContent = `${cities.length} 都市 / ${totalProperties} 物件`;
    if (cities.length === 0) {
      list.append(h('p', { class: 'empty-state', text: '見つかりませんでした。都市名や物件名で探してください。' }));
    }
  };

  const cityBlock = (city: City): HTMLElement => {
    const owners = city.properties.map((property) => options.state.owner[property.id]);
    const owned = owners.filter((id) => id !== undefined).length;
    const sole = owned === city.properties.length ? owners[0] : undefined;
    const details = h('details', { class: 'catalog-city' });
    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      const rows = h('div', { class: 'catalog-properties' });
      for (const property of city.properties) {
        const price = Math.round(currentPrice(GAME_DATA, options.state, property.id));
        const owner = options.state.owner[property.id];
        const ownerPlayer = owner !== undefined ? options.state.players[owner] : undefined;
        const isMine = owner === options.seat;
        rows.append(
          h(
            'div',
            { class: `catalog-row ${isMine ? 'is-mine' : ''}`.trim() },
            h('span', { class: 'catalog-industry', text: INDUSTRY_ICON[property.industry], attrs: { 'aria-hidden': 'true' } }),
            h(
              'span',
              { class: 'catalog-main' },
              h('span', { class: 'catalog-name', text: property.name }),
              h('span', {
                class: 'catalog-meta muted',
                text: `${INDUSTRY_JA[property.industry]} ・ 年利 ${property.yieldPct}% ・ 現在価格 ${formatOku(price)}`,
              }),
            ),
            ownerPlayer
              ? h(
                  'span',
                  {
                    class: 'catalog-owner',
                    attrs: { style: `--owner-color:${playerColor(ownerPlayer)}` },
                  },
                  h('span', { class: 'catalog-owner-dot' }),
                  h('span', { text: `${ownerPlayer.name}${isMine ? '（あなた）' : ''}` }),
                )
              : h('span', { class: 'catalog-vacant', text: '空き' }),
          ),
        );
      }
      details.append(rows);
    };
    details.append(
      h(
        'summary',
        { class: 'catalog-summary' },
        h('span', { class: 'catalog-flag', text: countryFlag(city.country) }),
        h('span', { class: 'catalog-city-name', text: city.nameJa }),
        h('span', { class: 'catalog-city-country muted', text: city.countryJa }),
        sole !== undefined && sole === options.seat ? h('span', { class: 'badge badge-gold', text: '👑 独占' }) : null,
        h('span', { class: 'badge', text: `${owned}/${city.properties.length}` }),
      ),
    );
    details.addEventListener('toggle', () => {
      if (details.open) build();
    });
    return details;
  };

  const search = h('input', {
    class: 'input catalog-search',
    attrs: { type: 'search', placeholder: '都市・物件名で検索', 'aria-label': '物件を検索', autocomplete: 'off' },
    on: {
      input: (event) => {
        query = (event.target as HTMLInputElement).value.trim();
        render();
      },
    },
  });

  render();
  options.modal.open(
    h(
      'div',
      { class: 'catalog-dialog' },
      h('div', { class: 'catalog-toolbar' }, search, count),
      list,
    ),
    {
      title: '🏙️ 物件カタログ',
      subtitle: '全都市の物件・所有者・現在価格。都市名をタップで開く。',
      className: 'modal-wide catalog-modal',
    },
  );
}