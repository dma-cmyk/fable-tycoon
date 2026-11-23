import { Audio, voiceKeyOf } from '../../audio/audio';
import { annualIncome, netWorth } from '../../core/engine';
import type { GameState } from '../../core/types';
import { GAME_DATA } from '../../data/index';
import { avatar, h } from '../dom';
import {
  characterSprite,
  charsById,
  formatOku,
  playerColor,
} from '../format';
import { assetLegend, drawAssetChart } from '../components/assetChart';

export interface ResultScreenOptions {
  state: GameState;
  mode: 'local' | 'online';
  isVoiceMuted: (seat: number) => boolean;
  onTitle: () => void;
  onRematch: () => void;
  /** True when win/lose lines were already played by the engine's say fx. */
  skipEndingVoice?: boolean;
}

export class ResultScreen {
  readonly el: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private timeouts: number[] = [];

  constructor(options: ResultScreenOptions) {
    const { state } = options;
    const ranking =
      state.phase.t === 'game_over'
        ? [...state.phase.ranking]
        : state.players
            .slice()
            .sort((a, b) => netWorth(GAME_DATA, state, b.id) - netWorth(GAME_DATA, state, a.id))
            .map((player) => player.id);
    const winner = state.players[ranking[0]];
    const loser = state.players[ranking[ranking.length - 1]];
    const winnerCharacter = winner ? charsById.get(winner.characterId) : undefined;
    const winnerNet = winner ? netWorth(GAME_DATA, state, winner.id) : 0;

    const podium = h('div', { class: 'result-podium' });
    ranking.forEach((playerId, index) => {
      const player = state.players[playerId];
      if (!player) return;
      const character = charsById.get(player.characterId);
      const net = netWorth(GAME_DATA, state, playerId);
      const income = annualIncome(GAME_DATA, state, playerId);
      podium.append(
        h(
          'div',
          { class: `result-row result-rank-${index + 1}` },
          h('span', { class: `result-rank-badge rank-${index + 1}` }, h('span', { text: `${index + 1}` })),
          avatar(characterSprite(character), character?.color ?? playerColor(player), index === 0 ? 62 : 48),
          h(
            'div',
            { class: 'result-row-main' },
            h(
              'div',
              { class: 'result-row-name' },
              h('strong', { text: player.name }),
              h('span', { class: 'muted', text: character?.nameJa ?? '' }),
              player.isCpu ? h('span', { class: 'badge', text: 'CPU' }) : null,
            ),
            h(
              'div',
              { class: 'result-row-stats' },
              h('span', { class: 'muted', text: '総資産 ' }),
              h('strong', { class: index === 0 ? 'gold' : '', text: formatOku(net) }),
              h('span', { class: 'muted', text: ' ・ 年間収益 ' }),
              h('strong', { text: formatOku(income) }),
            ),
          ),
          index === 0 ? h('span', { class: 'result-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }) : null,
        ),
      );
    });

    const canvas = h('canvas', { class: 'asset-chart result-chart', attrs: { 'aria-label': '最終資産推移' } });
    const chart = h(
      'div',
      { class: 'result-chart-card' },
      h('div', { class: 'result-chart-head' }, h('h3', { text: '資産推移' }), assetLegend(state)),
      canvas,
    );

    const titleButton = h('button', {
      class: 'btn btn-ghost result-btn',
      text: '🏠 タイトルへ',
      attrs: { type: 'button' },
      on: { click: options.onTitle },
    });
    const rematchButton = h('button', {
      class: 'btn btn-gold result-btn',
      text: options.mode === 'online' ? '🌐 別のルームへ' : '🔁 もう一度',
      attrs: { type: 'button' },
      on: { click: options.onRematch },
    });

    const confetti = h('div', { class: 'result-confetti', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < 18; i++) {
      confetti.append(
        h('span', {
          attrs: {
            style: `--x:${(i * 37) % 100}%;--delay:${(i % 9) * 0.35}s;--hue:${(i * 47) % 360};--dur:${2.4 + (i % 5) * 0.4}s`,
          },
        }),
      );
    }

    this.el = h(
      'div',
      { class: 'result-screen', attrs: { role: 'main', 'aria-label': 'ゲーム結果' } },
      confetti,
      h(
        'div',
        { class: 'result-scroll scroll-y' },
        h(
          'header',
          { class: 'result-hero' },
          h('p', { class: 'result-kicker', text: 'FINAL RESULT' }),
          h('h1', { class: 'result-title', text: '世界を買い占めたのは…' }),
          h(
            'div',
            { class: 'result-winner' },
            avatar(characterSprite(winnerCharacter), winnerCharacter?.color ?? '#ffd23f', 132, 'result-winner-avatar'),
            h(
              'div',
              { class: 'result-winner-text' },
              h('span', { class: 'result-crown-big', text: '👑', attrs: { 'aria-hidden': 'true' } }),
              h('h2', { class: 'result-winner-name', text: winner?.name ?? '—' }),
              h('p', { class: 'result-winner-char', text: winnerCharacter ? `${winnerCharacter.nameJa}（${winnerCharacter.origin}）` : '' }),
              h('p', { class: 'result-winner-net', text: `総資産 ${formatOku(winnerNet)}` }),
            ),
          ),
          h('p', {
            class: 'result-badge-line',
            text: `${state.config.years} 年 ・ ${state.players.length} 人 ・ 全 ${state.round + 1} ターン`,
          }),
        ),
        h('section', { class: 'result-panel panel' }, h('h2', { class: 'section-title', text: '最終順位' }), podium),
        h('section', { class: 'result-panel panel' }, chart),
        h(
          'div',
          { class: 'result-actions' },
          rematchButton,
          titleButton,
          h('p', {
            class: 'result-note',
            text:
              options.mode === 'online'
                ? 'おつかれさまでした。別のルームを作るか、招待URLで友だちを誘えます。'
                : '同じ設定でもう一度遊べます。キャラクターを変えるならタイトルへ。',
          }),
        ),
        h('p', {
          class: 'result-disclaimer',
          text: 'この物語はフィクションです。実在の人物・団体・国家を名指しで評価するものではありません。',
        }),
      ),
    );

    requestAnimationFrame(() => {
      drawAssetChart({
        canvas,
        state,
        finalAssets: state.players.map((player) => netWorth(GAME_DATA, state, player.id)),
      });
      this.resizeObserver = new ResizeObserver(() => {
        drawAssetChart({
          canvas,
          state,
          finalAssets: state.players.map((player) => netWorth(GAME_DATA, state, player.id)),
        });
      });
      this.resizeObserver.observe(canvas);
    });

    if (!options.skipEndingVoice) {
      this.timeouts.push(
        window.setTimeout(() => {
          void this.playEndingVoice(winner, loser, options.isVoiceMuted);
        }, 700),
      );
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    for (const timeout of this.timeouts) window.clearTimeout(timeout);
    Audio.stopVoice();
  }

  private async playEndingVoice(
    winner: GameState['players'][number] | undefined,
    loser: GameState['players'][number] | undefined,
    isVoiceMuted: (seat: number) => boolean,
  ): Promise<void> {
    const winnerCharacter = winner ? charsById.get(winner.characterId) : undefined;
    if (winner && winnerCharacter && !isVoiceMuted(winner.id)) {
      await Audio.playVoice(voiceKeyOf(`char:${winnerCharacter.id}`), winnerCharacter.lines.win);
    }
    const gap = Promise.withResolvers<void>();
    window.setTimeout(gap.resolve, 450);
    await gap.promise;
    const loserCharacter = loser ? charsById.get(loser.characterId) : undefined;
    if (loser && loserCharacter && !isVoiceMuted(loser.id)) {
      await Audio.playVoice(voiceKeyOf(`char:${loserCharacter.id}`), loserCharacter.lines.lose);
    }
  }
}