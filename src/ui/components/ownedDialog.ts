import { annualIncome, currentPrice, netWorth } from '../../core/engine';
import type { GameState } from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { h, type ModalHost } from '../dom';
import {
  citiesById,
  formatOku,
  formatOkuShort,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  playerColor,
  propertiesById,
} from '../format';

export interface OwnedDialogOptions {
  modal: ModalHost;
  state: GameState;
  seat: number;
}

export function openOwnedDialog(options: OwnedDialogOptions): void {
  const player = options.state.players[options.seat];
  if (!player) return;
  const income = annualIncome(GAME_DATA, options.state, options.seat);
  const net = netWorth(GAME_DATA, options.state, options.seat);
  const byCity = new Map<string, string[]>();
  for (const [propertyId, owner] of Object.entries(options.state.owner)) {
    if (owner !== options.seat) continue;
    const cityId = propertiesById.get(propertyId)?.city.id;
    if (!cityId) continue;
    const list = byCity.get(cityId) ?? [];
    list.push(propertyId);
    byCity.set(cityId, list);
  }

  const body = h(
    'div',
    { class: 'owned-dialog' },
    h(
      'div',
      { class: 'owned-summary' },
      h(
        'div',
        { class: 'owned-summary-main' },
        h('span', { class: 'owned-summary-name', text: player.name }),
        h('span', { class: 'muted', text: `所持金 ${formatOku(player.cash)} ・ ${byCity.size} 都市 / ${Object.values(options.state.owner).filter((id) => id === options.seat).length} 物件` }),
      ),
      h(
        'div',
        { class: 'owned-summary-stats' },
        h(
          'div',
          { class: 'owned-stat' },
          h('span', { class: 'muted', text: '年間収益見込み' }),
          h('strong', { class: 'money-positive', text: `+${formatOkuShort(Math.round(income))}` }),
        ),
        h(
          'div',
          { class: 'owned-stat' },
          h('span', { class: 'muted', text: '総資産' }),
          h('strong', { text: formatOku(net) }),
        ),
      ),
    ),
  );

  if (byCity.size === 0) {
    body.append(
      h(
        'div',
        { class: 'empty-state' },
        h('span', { class: 'empty-state-icon', text: '🏙️' }),
        h('p', { text: '物件はまだ持っていません。都市に止まって買いましょう。' }),
      ),
    );
  } else {
    const citiesHost = h('div', { class: 'owned-cities' });
    for (const [cityId, propertyIds] of byCity) {
      const city = citiesById.get(cityId);
      if (!city) continue;
      const allOwned = city.properties.length === propertyIds.length;
      const rows = h('div', { class: 'owned-properties' });
      let cityBase = 0;
      for (const propertyId of propertyIds) {
        const property = city.properties.find((p) => p.id === propertyId);
        if (!property) continue;
        const price = Math.round(currentPrice(GAME_DATA, options.state, propertyId));
        const base = Math.round((property.price * property.yieldPct) / 100);
        cityBase += base;
        rows.append(
          h(
            'div',
            { class: 'owned-property' },
            h('span', { class: 'owned-property-icon', text: INDUSTRY_ICON[property.industry], attrs: { 'aria-hidden': 'true' } }),
            h(
              'span',
              { class: 'owned-property-main' },
              h('span', { class: 'owned-property-name', text: property.name }),
              h('span', {
                class: 'owned-property-meta muted',
                text: `${INDUSTRY_JA[property.industry]} ・ 年利 ${property.yieldPct}% ・ 約 ${formatOkuShort(base)}/年`,
              }),
            ),
            h('span', { class: 'owned-property-price', text: formatOku(price) }),
          ),
        );
      }
      citiesHost.append(
        h(
          'section',
          {
            class: 'owned-city',
            attrs: { style: `--city-color:${playerColor(player)}` },
          },
          h(
            'header',
            { class: 'owned-city-head' },
            h('h3', { text: city.nameJa }),
            h('span', { class: 'muted', text: `${propertyIds.length} / ${city.properties.length} 件` }),
            allOwned ? h('span', { class: 'badge badge-gold', text: '👑 独占（収益2倍）' }) : null,
            h('span', { class: 'owned-city-income', text: `約 ${formatOkuShort(cityBase)}/年` }),
          ),
          rows,
        ),
      );
    }
    body.append(citiesHost);
    body.append(
      h('p', {
        class: 'owned-note muted',
        text: '収益は年利・業種倍率・独占倍率を反映した概算。決算時にまとめて入金されます。',
      }),
    );
  }

  options.modal.open(body, {
    title: `🏠 持ち物 — ${player.name}`,
    subtitle: '所有物件と年間収益の見込み',
    className: 'owned-modal',
  });
}