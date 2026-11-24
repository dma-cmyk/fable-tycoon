import { h, type ModalHost } from '../dom';
import {
  REALM_MULTIPLIER_ROWS,
  SQUARE_INFO_LIST,
  squareTileUrl,
  tileThumb,
} from '../squareInfo';

export interface SquareLegendOptions {
  /** Compact variant used when embedded inside the broader Help dialog. */
  compact?: boolean;
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

  return h('div', { class: 'square-legend' }, grid, realmTable, tip);
}

/** Open the standalone "マスの種類" modal from the ≡ menu. */
export function openSquareLegendDialog(modal: ModalHost): void {
  modal.open(buildSquareLegend(), {
    title: 'マスの種類',
    subtitle: '全 8 種類のアイコンと効果・異世界での倍率',
    className: 'modal-wide square-legend-modal',
  });
}
