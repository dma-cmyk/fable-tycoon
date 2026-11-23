import type { PublicState } from '../../core/engine';
import type {YearReport} from '../../core/types';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import { animateCounter, confettiBurst, motionReduced } from '../motion';
import { characterSprite, charsById, displayPlayerName, formatDelta, formatOku, playerColor } from '../format';
import { assetLegend, drawAssetChart } from './assetChart';

export interface YearEndOptions {
  modal: ModalHost;
  state: PublicState;
  canAct: boolean;
  actorName: string;
  onAck: () => void;
}

export interface YearEndHandle {
  update(state: PublicState, canAct: boolean): void;
  close(): void;
}

export function openYearEndDialog(options: YearEndOptions): YearEndHandle {
  let state = options.state;
  let canAct = options.canAct;
  let acked = false;
  const body = h('div', { class: 'yearend' });
  let modalHandle: ModalHandle | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const reportOf = (): YearReport | null => (state.phase.t === 'year_end' ? state.phase.report : null);

  const render = (): void => {
    const report = reportOf();
    if (!report) return;
    resizeObserver?.disconnect();
    const rows = [...report.assets].sort((a, b) => b.total - a.total);
    const incomeById = new Map(report.income.map((entry) => [entry.playerId, entry.amount]));
    const finalYear = report.year >= state.config.years;

    const table = h('div', { class: 'yearend-table' });
    rows.forEach((asset, index) => {
      const player = state.players[asset.playerId];
      if (!player) return;
      const income = incomeById.get(asset.playerId) ?? 0;
      const character = charsById.get(player.characterId);
      table.append(
        h(
          'div',
          { class: `yearend-row ${index === 0 ? 'is-top' : ''}`.trim() },
          h('span', { class: `yearend-rank rank-${index + 1}` }, h('span', { text: `${index + 1}` })),
          avatar(characterSprite(character), character?.color ?? playerColor(player), 44),
          h(
            'span',
            { class: 'yearend-player' },
            h('strong', { class: 'yearend-name', text: displayPlayerName(player) }),
            h('span', { class: 'yearend-char muted', text: player.isCpu ? `CPU ・ ${character?.originRegion ?? ''}` : character?.nameJa ?? '' }),
          ),
          h(
            'span',
            { class: 'yearend-income' },
            h('span', { class: 'muted', text: '収益' }),
            h('strong', { class: income < 0 ? 'money-negative' : 'money-positive', text: formatDelta(income) }),
          ),
          h(
            'span',
            { class: 'yearend-assets' },
            h('span', { class: 'muted', text: '総資産' }),
            h('strong', { text: formatOku(asset.total) }),
          ),
        ),
      );
    });

    const maxAssets = Math.max(1, ...report.assets.map((asset) => asset.total));
    const raceHost = h('div', { class: 'yearend-bars' });
    rows.forEach((asset, index) => {
      const player = state.players[asset.playerId];
      if (!player) return;
      const character = charsById.get(player.characterId);
      const fill = h('span');
      const valueEl = h('strong', { class: 'yearend-bar-value', text: '' });
      const width = Math.max(2, Math.round((asset.total / maxAssets) * 100));
      raceHost.append(
        h(
          'div',
          { class: `yearend-bar-row ${index === 0 ? 'is-top' : ''}`.trim() },
          h('span', { class: 'yearend-bar-avatar' }, avatar(characterSprite(character), character?.color ?? playerColor(player), 32)),
          h('span', { class: 'yearend-bar-name', text: index === 0 ? `👑 ${displayPlayerName(player)}` : displayPlayerName(player) }),
          h('span', { class: 'yearend-bar-track' }, fill),
          valueEl,
        ),
      );
      requestAnimationFrame(() => {
        fill.style.width = `${width}%`;
      });
      if (motionReduced()) valueEl.textContent = formatOku(asset.total);
      else animateCounter(valueEl, 0, asset.total, formatOku, 900);
    });

    const confettiHost = h('div', { class: 'yearend-confetti', attrs: { 'aria-hidden': 'true' } });
    requestAnimationFrame(() => confettiBurst(confettiHost, 22));

    const canvas = h('canvas', { class: 'asset-chart', attrs: { 'aria-label': '資産推移グラフ' } });
    const chartCard = h(
      'div',
      { class: 'yearend-chart-card' },
      h('div', { class: 'yearend-chart-head' }, h('h3', { text: '資産推移' }), assetLegend(state)),
      canvas,
    );

    const ackButton = h(
      'button',
      {
        class: 'btn btn-gold yearend-ack',
        text: finalYear ? '🏆 最終結果を見る' : '▶ 次の年へ',
        attrs: { type: 'button', disabled: !canAct || acked },
        on: {
          click: (event) => {
            if (!canAct || acked) return;
            acked = true;
            const btn = event.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = '確認しています…';
            options.onAck();
          },
        },
      },
    );

    body.replaceChildren(
      h(
        'header',
        { class: 'yearend-head' },
        h('div', { class: 'yearend-year', text: `第 ${report.year} 年` }),
        h('div', { class: 'yearend-year-label', text: '決 算' }),
        h('span', { class: 'badge badge-gold', text: finalYear ? '最終決算' : `全 ${state.config.years} 年` }),
      ),
      h('p', { class: 'yearend-headline', text: report.headline }),
      h(
        'section',
        { class: 'yearend-race-card' },
        h('div', { class: 'yearend-race-head' }, h('h3', { text: '資産レース' }), h('span', { class: 'badge badge-gold', text: '1位に王冠' })),
        raceHost,
        confettiHost,
      ),
      table,
      chartCard,
      h('p', {
        class: 'yearend-note muted',
        text: '物件収益と独占ボーナスを精算し、全員の総資産が確定しました。',
      }),
      h(
        'div',
        { class: 'yearend-footer' },
        canAct
          ? ackButton
          : h('span', { class: 'muted', text: `${options.actorName} の確認を待っています…` }),
        h(
          'span',
          { class: 'yearend-footer-note muted' },
          finalYear ? '次は最終結果です。' : `次の年（第 ${report.year + 1} 年）へ進みます。`,
        ),
      ),
    );

    requestAnimationFrame(() => {
      drawAssetChart({
        canvas,
        state,
        finalAssets: report.assets.map((entry) => entry.total),
      });
      resizeObserver = new ResizeObserver(() => {
        drawAssetChart({
          canvas,
          state,
          finalAssets: report.assets.map((entry) => entry.total),
        });
      });
      resizeObserver.observe(canvas);
    });
  };

  render();
  modalHandle = options.modal.open(body, {
    title: '📊 年度決算',
    subtitle: '収益・総資産ランキングと資産推移',
    className: 'yearend-modal modal-wide',
    // The actor must acknowledge before the game continues; do not let a stray Esc skip it.
    dismissible: false,
  });

  return {
    update(nextState: PublicState, nextCanAct: boolean) {
      state = nextState;
      canAct = nextCanAct;
      if (state.phase.t === 'year_end') render();
      else modalHandle?.close();
    },
    close() {
      resizeObserver?.disconnect();
      modalHandle?.close();
    },
  };
}