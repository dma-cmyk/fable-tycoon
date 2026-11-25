import type { CityModState } from '../../core/types';
import { h, type ModalHost } from '../dom';
import { citiesById } from '../format';
import { rubyName } from '../ruby';
import {
  REALM_MULTIPLIER_ROWS,
  SQUARE_INFO_LIST,
  squareTileUrl,
  tileThumb,
} from '../squareInfo';

export interface SquareLegendOptions {
  /** Compact variant used when embedded inside the broader Help dialog. */
  compact?: boolean;
  /** いま効いている都市効果（≡メニューの一覧に出す）。 */
  cityMods?: CityModState[];
  /** 一覧の都市をタップしたときの移動先。 */
  onLocateCity?: (cityId: string) => void;
}

const CITY_MOD_KIND_JA: Record<CityModState['kind'], { icon: string; label: string }> = {
  bubble: { icon: '▲', label: 'バブル' },
  boom: { icon: '✦', label: '好況' },
  damage: { icon: '▼', label: '打撃' },
  blockade: { icon: '×', label: '封鎖' },
};

/** 継続中の都市効果を行で並べる（都市名・効果・残り年数・実効倍率）。 */
function buildCityModList(mods: CityModState[], onLocateCity?: (cityId: string) => void): HTMLElement | null {
  const byCity = new Map<string, CityModState[]>();
  for (const mod of mods) {
    if (mod.yearsLeft <= 0) continue;
    const list = byCity.get(mod.cityId) ?? [];
    list.push(mod);
    byCity.set(mod.cityId, list);
  }
  if (byCity.size === 0) return null;
  const rows: HTMLElement[] = [];
  // 残り年数の短い順 → 都市名。今にも終わる効果を上に出す。
  const ordered = [...byCity.entries()].sort((a, b) => {
    const ya = Math.min(...a[1].map((m) => m.yearsLeft));
    const yb = Math.min(...b[1].map((m) => m.yearsLeft));
    return ya !== yb ? ya - yb : a[0].localeCompare(b[0]);
  });
  for (const [cityId, list] of ordered) {
    const city = citiesById.get(cityId);
    if (!city) continue;
    const last = list[list.length - 1];
    const kind = CITY_MOD_KIND_JA[last.kind];
    const mult = list.reduce((product, mod) => product * mod.mult, 1);
    const clamped = Math.min(3, Math.max(0.3, mult));
    const yearsLeft = Math.max(...list.map((mod) => mod.yearsLeft));
    const labels = list.map((mod) => mod.label).join('・');
    const row = h(
      'button',
      {
        class: `city-mod-row is-${last.kind}`,
        attrs: {
          type: 'button',
          'aria-label': `${city.nameJa} ${labels} 残り${yearsLeft}年 地図で見る`,
        },
        on: {
          click: () => onLocateCity?.(cityId),
        },
      },
      h('span', { class: 'city-mod-row-icon', text: kind.icon, attrs: { 'aria-hidden': 'true' } }),
      h(
        'span',
        { class: 'city-mod-row-copy' },
        h('span', { class: 'city-mod-row-name' }, rubyName(city.nameJa, city.nameKana)),
        h('span', { class: 'city-mod-row-effect', text: `${labels}（${kind.label}）` }),
      ),
      h('span', { class: 'city-mod-row-mult', text: `×${clamped.toFixed(1)}` }),
      h('span', { class: 'city-mod-row-years', text: `残り${yearsLeft}年` }),
      onLocateCity ? h('span', { class: 'city-mod-row-go', text: '地図で見る' }) : null,
    );
    rows.push(row);
  }
  return h(
    'div',
    { class: 'city-mod-legend' },
    h('h4', { class: 'square-legend-subhead', text: 'いま続いている都市の効果' }),
    h(
      'p',
      {
        class: 'city-mod-legend-note',
        text: '物件の価格（資産価値・購入・売却）と決算収益に掛かる。都市を選ぶと地図が動く。',
      },
    ),
    h('div', { class: 'city-mod-legend-list' }, ...rows),
  );
}

/** Build the reusable "マスの種類" legend block (all 8 square types + realm multipliers). */
export function buildSquareLegend(options: SquareLegendOptions = {}): HTMLElement {
  const grid = h('div', { class: `square-legend-grid ${options.compact ? 'is-compact' : ''}`.trim() });
  for (const info of SQUARE_INFO_LIST) {
    grid.append(
      h(
        'article',
        { class: 'square-legend-item', attrs: { 'data-kind': info.kind } },
        h(
          'span',
          { class: 'square-legend-icon' },
          tileThumb(squareTileUrl(info.kind, true), 'square-legend-img', info.name),
        ),
        h(
          'div',
          { class: 'square-legend-copy' },
          h('strong', { class: 'square-legend-name', text: info.name }),
          h('p', { class: 'square-legend-desc', text: info.effect }),
          info.realmNote ? h('p', { class: 'square-legend-note', text: info.realmNote }) : null,
        ),
      ),
    );
  }

  const realmTable = h(
    'div',
    { class: 'square-legend-realms' },
    h('h4', { class: 'square-legend-subhead', text: '異世界での倍率ちがい' }),
    h(
      'div',
      { class: 'square-legend-realm-list' },
      ...REALM_MULTIPLIER_ROWS.map((row) =>
        h(
          'div',
          { class: `square-legend-realm is-${row.id}` },
          h('strong', { class: 'square-legend-realm-name', text: row.name }),
          h(
            'span',
            { class: 'square-legend-realm-mults' },
            h('span', { class: 'square-legend-pill is-blue', text: `青 ${row.blueMult}` }),
            h('span', { class: 'square-legend-pill is-red', text: `赤 ${row.redMult}` }),
          ),
          h('span', { class: 'square-legend-realm-exit', text: row.exitRule }),
        ),
      ),
    ),
  );

  const tip = h('p', {
    class: 'square-legend-tip',
    text: 'ヒント：盤面のマスにマウスを乗せる（スマホは長押し）と、そのマスの説明が札で出ます。',
  });

  const cityModList = options.cityMods && options.cityMods.length > 0
    ? buildCityModList(options.cityMods, options.onLocateCity)
    : null;

  return h('div', { class: 'square-legend' }, cityModList, grid, realmTable, tip);
}

/** Open the standalone "マスの種類" modal from the ≡ menu. */
export function openSquareLegendDialog(
  modal: ModalHost,
  options: { cityMods?: CityModState[]; onLocateCity?: (cityId: string) => void } = {},
): void {
  const mods = options.cityMods?.filter((mod) => mod.yearsLeft > 0) ?? [];
  modal.open(buildSquareLegend({ cityMods: mods, onLocateCity: options.onLocateCity }), {
    title: 'マスの種類',
    subtitle: mods.length > 0
      ? `全 8 種類のマス ・ いま続いている都市の効果 ${new Set(mods.map((mod) => mod.cityId)).size} 件`
      : '全 8 種類のアイコンと効果・異世界での倍率',
    className: 'modal-wide square-legend-modal',
  });
}
