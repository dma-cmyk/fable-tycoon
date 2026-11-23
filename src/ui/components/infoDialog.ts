import {  distance, type PublicState } from '../../core/engine';
import { INDUSTRIES, type Industry } from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { h, type ModalHost } from '../dom';
import {
  citiesById,
  cityNodeId,
  eventsById,
  formatOku,
  INDUSTRY_ICON,
  INDUSTRY_JA,
  KIND_ICON,
  KIND_JA,
  playerColor,
} from '../format';

export interface NewsLogEntry {
  eventId: string;
  year: number;
  month: number;
}

export interface InfoDialogOptions {
  modal: ModalHost;
  state: PublicState;
  newsLog: NewsLogEntry[];
  logs: string[];
}

export function openInfoDialog(options: InfoDialogOptions): void {
  const state = options.state;
  const multipliers = new Map<Industry, { mult: number; labels: string[] }>();
  for (const mod of state.industryMods) {
    if (mod.yearsLeft <= 0) continue;
    const entry = multipliers.get(mod.industry) ?? { mult: 1, labels: [] };
    entry.mult *= mod.mult;
    entry.labels.push(`${mod.label}（残${mod.yearsLeft}年）`);
    multipliers.set(mod.industry, entry);
  }

  const industryRows = h('div', { class: 'info-industries' });
  for (const industry of INDUSTRIES) {
    const entry = multipliers.get(industry);
    const priceMod = state.priceMod[industry];
    industryRows.append(
      h(
        'div',
        { class: 'info-industry' },
        h('span', { class: 'info-industry-icon', text: INDUSTRY_ICON[industry], attrs: { 'aria-hidden': 'true' } }),
        h(
          'span',
          { class: 'info-industry-main' },
          h('span', { class: 'info-industry-name', text: INDUSTRY_JA[industry] }),
          entry
            ? h('span', { class: 'info-industry-note', text: entry.labels.join(' / ') })
            : h('span', { class: 'info-industry-note muted', text: '変動なし' }),
        ),
        h(
          'span',
          { class: `info-industry-mult ${entry ? 'is-boosted' : ''}`.trim() },
          h('span', { text: `収益 ×${(entry?.mult ?? 1).toFixed(2)}` }),
          priceMod !== undefined && priceMod !== 1
            ? h('span', { class: 'muted', text: ` 価格 ${priceMod > 1 ? '+' : ''}${((priceMod - 1) * 100).toFixed(0)}%` })
            : null,
        ),
      ),
    );
  }

  const destCity = citiesById.get(state.destination);
  const destRows = h('div', { class: 'info-destination-rows' });
  for (const player of state.players) {
    const steps = distance(GAME_DATA, player.nodeId, cityNodeId(state.destination));
    destRows.append(
      h(
        'div',
        { class: 'info-destination-row' },
        h('span', { class: 'info-dest-dot', attrs: { style: `background:${playerColor(player)}` } }),
        h('span', { text: player.name }),
        h('span', { class: 'muted', text: `${player.isCpu ? 'CPU' : '人間'}` }),
        h('span', { class: 'info-dest-steps', text: `あと ${steps} マス` }),
      ),
    );
  }

  const piperHolder = state.piper.holder !== null ? state.players[state.piper.holder] : null;
  const piperLine = h('p', {
    class: 'info-piper-line',
    text: piperHolder
      ? `🎺 ${piperHolder.name} に取り立て屋 Lv${state.piper.level} が憑いています（${state.piper.heldTurns} 手番）。`
      : '取り立て屋はいま誰にも憑いていません。目的地一番乗りで、一番遠い人に憑きます。',
  });

  const news = h('div', { class: 'info-news' });
  if (options.newsLog.length === 0) {
    news.append(h('p', { class: 'muted', text: 'まだ世界ニュースは起きていません。ニュースマスに止まると発生します。' }));
  } else {
    for (const entry of [...options.newsLog].reverse().slice(0, 20)) {
      const event = eventsById.get(entry.eventId);
      if (!event) continue;
      news.append(
        h(
          'div',
          { class: 'info-news-item' },
          h('span', { class: 'info-news-icon', text: KIND_ICON[event.kind], attrs: { 'aria-hidden': 'true' } }),
          h(
            'span',
            { class: 'info-news-main' },
            h('span', { class: 'info-news-title', text: event.title }),
            h('span', { class: 'info-news-meta muted', text: `${KIND_JA[event.kind]} ・ ${entry.year}年目${entry.month}月` }),
          ),
        ),
      );
    }
  }

  const logs = h('div', { class: 'info-log' });
  if (options.logs.length === 0) {
    logs.append(h('p', { class: 'muted', text: 'ログはまだありません。' }));
  } else {
    for (const line of [...options.logs].reverse().slice(0, 60)) {
      logs.append(h('p', { class: 'info-log-line', text: line }));
    }
  }

  const body = h(
    'div',
    { class: 'info-dialog' },
    h(
      'section',
      { class: 'info-section' },
      h('h3', { class: 'section-title', text: '📈 業種倍率' }),
      industryRows,
    ),
    h(
      'section',
      { class: 'info-section' },
      h('h3', { class: 'section-title', text: '🎯 目的地と取り立て屋' }),
      h(
        'div',
        { class: 'info-destination' },
        h('strong', { class: 'info-destination-name', text: destCity?.nameJa ?? state.destination }),
        h('span', { class: 'muted', text: destCity ? `${destCity.countryJa} ・ 一番乗りボーナスあり` : '' }),
      ),
      destRows,
      piperLine,
    ),
    h(
      'section',
      { class: 'info-section' },
      h('h3', { class: 'section-title', text: '📰 経済ニュース' }),
      news,
    ),
    h(
      'section',
      { class: 'info-section' },
      h('h3', { class: 'section-title', text: '📜 ログ' }),
      logs,
    ),
    h(
      'p',
      { class: 'info-footnote muted' },
      `所持金 ${formatOku(state.players[state.current]?.cash ?? 0)} ・ 手番 ${state.players[state.current]?.name ?? '—'}`,
    ),
  );

  options.modal.open(body, {
    title: '📊 情報',
    subtitle: '業種倍率・目的地・経済ニュース・ログ',
    className: 'info-modal',
  });
}