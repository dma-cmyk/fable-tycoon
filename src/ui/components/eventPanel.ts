import type { PublicState } from '../../core/engine';
import type {EventChoice, GameEventDef} from '../../core/types';
import { h } from '../dom';
import { EVENT_IMAGE_IDS } from '../assetManifest';
import {
  assetUrl,
  KIND_ICON,
  KIND_JA,
  speakerName,
  speakerSprite,
} from '../format';

export interface EventPanelOptions {
  onChoose: (index: number) => void;
}

export class EventPanel {
  readonly el: HTMLElement;
  readonly commHost: HTMLElement;
  private readonly ribbonTitle: HTMLElement;
  private readonly kindBadge: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly hero: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly byline: HTMLElement;
  private readonly speakerAvatar: HTMLElement;
  private readonly speakerNameEl: HTMLElement;
  private readonly dialogueText: HTMLElement;
  private readonly choicesHost: HTMLElement;
  private readonly choicesNote: HTMLElement;
  private readonly metaBody: HTMLElement;
  private readonly metaToggle: HTMLButtonElement;
  private readonly seasonBadge: HTMLElement;
  private event: GameEventDef | null = null;
  get eventId(): string | null { return this.event?.id ?? null; }
  private state: PublicState | null = null;
  private canAct = false;
  private chosen = false;
  private open = false;

  constructor(private readonly options: EventPanelOptions) {
    this.ribbonTitle = h('span', { class: 'event-ribbon-title', text: '世界ニュースイベント！' });
    this.kindBadge = h('span', { class: 'event-kind-badge' });
    this.commHost = h('div', { class: 'event-comm' });
    this.seasonBadge = h('span', { class: 'event-season-badge', attrs: { hidden: 'hidden' } });
    this.image = h('img', {
      class: 'event-image',
      attrs: { alt: '', draggable: 'false', loading: 'lazy' },
      on: {
        error: () => {
          this.image.hidden = true;
          this.hero.classList.add('no-image');
        },
        load: () => {
          this.image.hidden = false;
          this.hero.classList.remove('no-image');
        },
      },
    });
    this.titleEl = h('h2', { class: 'event-title' });
    this.byline = h('p', { class: 'event-byline' });
    this.hero = h('div', { class: 'event-hero no-image' }, this.image, h('div', { class: 'event-hero-shade' }), this.titleEl);
    this.speakerAvatar = h('span', { class: 'event-speaker-avatar' });
    this.speakerNameEl = h('span', { class: 'event-speaker-name' });
    this.dialogueText = h('p', { class: 'event-dialogue-text' });
    this.choicesHost = h('div', { class: 'event-choices' });
    this.choicesNote = h('p', { class: 'event-choices-note' });
    this.metaBody = h('div', { class: 'event-meta-body', attrs: { hidden: 'hidden' } });
    this.metaToggle = h('button', {
      class: 'event-meta-toggle',
      text: '📚 元ネタ',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      on: {
        click: () => {
          const openMeta = this.metaBody.hidden;
          this.metaBody.hidden = !openMeta;
          this.metaToggle.setAttribute('aria-expanded', String(openMeta));
          this.metaToggle.textContent = openMeta ? '📚 元ネタをとじる' : '📚 元ネタ';
        },
      },
    });

    this.el = h(
      'aside',
      { class: 'event-panel', attrs: { 'aria-label': '世界ニュースイベント', hidden: 'hidden' } },
      h(
        'header',
        { class: 'event-ribbon' },
        h('span', { class: 'event-ribbon-icon', text: '🎙️', attrs: { 'aria-hidden': 'true' } }),
        this.ribbonTitle,
        this.seasonBadge,
        this.kindBadge,
        this.commHost,
      ),
      h(
        'div',
        { class: 'event-panel-scroll scroll-y' },
        this.hero,
        this.byline,
        h(
          'div',
          { class: 'event-speaker' },
          this.speakerAvatar,
          h(
            'div',
            { class: 'event-speaker-main' },
            this.speakerNameEl,
            this.dialogueText,
          ),
        ),
        h('div', { class: 'event-meta' }, this.metaToggle, this.metaBody),
        h('div', { class: 'event-choice-area' }, this.choicesHost, this.choicesNote),
      ),
      h('p', {
        class: 'event-footnote',
        text: '1〜3 キーまたはボタンで選択 ・ 画面の空きをタップで演出スキップ',
      }),
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(event: GameEventDef, state: PublicState, playerName: string): void {
    this.event = event;
    this.chosen = false;
    this.open = true;
    this.el.hidden = false;
    this.el.classList.add('is-open');
    this.el.closest('.game-screen')?.classList.add('event-open');
    this.titleEl.textContent = event.title;
    const monthly = event.monthly === true;
    const season = seasonOf(state.month);
    this.kindBadge.textContent = monthly ? `${season.emoji} ${state.month}月の季節イベント` : `${KIND_ICON[event.kind]} ${KIND_JA[event.kind]}`;
    this.kindBadge.dataset.kind = event.kind;
    this.seasonBadge.hidden = !monthly;
    this.seasonBadge.textContent = monthly ? `${season.emoji} ${season.label}` : '';
    this.ribbonTitle.textContent = monthly ? '月替わりイベント！' : '世界ニュースイベント！';
    this.el.dataset.season = season.key;
    this.byline.textContent = monthly ? `${state.month}月の季節イベント ・ 全員に影響` : `${playerName} が引いた ${KIND_JA[event.kind]}`;
    this.metaToggle.textContent = '📚 元ネタ';
    this.metaToggle.setAttribute('aria-expanded', 'false');
    this.metaBody.hidden = true;
    this.renderImage(event);
    this.renderMeta(event);
    this.setSpeaker('narrator', '……世界のどこかで、ニュースが動き出す。');
    this.setState(state, false);
  }

  hide(): void {
    this.open = false;
    this.chosen = false;
    this.el.classList.remove('is-open');
    this.el.hidden = true;
    this.el.closest('.game-screen')?.classList.remove('event-open');
  }

  setSpeaker(speaker: string, text: string): void {
    if (!this.open) return;
    const sprite = speakerSprite(speaker);
    this.speakerAvatar.replaceChildren(
      sprite
        ? h('img', { attrs: { src: sprite, alt: '', draggable: 'false' } })
        : h('span', { class: 'event-speaker-emoji', text: speaker === 'narrator' ? '🎙️' : '💬' }),
    );
    this.speakerNameEl.textContent = speakerName(speaker);
    this.dialogueText.textContent = text;
  }

  setState(state: PublicState, canAct: boolean): void {
    this.state = state;
    this.canAct = canAct;
    this.refreshChoices();
  }

  /** Toggle disabled state without rebuilding while a choice is being sent. */
  markChosen(): void {
    this.chosen = true;
    this.refreshChoices();
  }

  resetChosen(): void {
    this.chosen = false;
    this.refreshChoices();
  }

  private refreshChoices(): void {
    const event = this.event;
    const state = this.state;
    if (!event || !state) return;
    const choices = event.choices ?? [];
    this.choicesHost.replaceChildren();
    if (choices.length === 0) {
      this.choicesNote.textContent = 'このニュースに選択肢はありません。効果が自動で適用されます。';
      return;
    }
    const phaseActive = state.phase.t === 'event';
    const enabled = phaseActive && this.canAct && !this.chosen;
    const actor = state.players[state.current];
    for (let index = 0; index < choices.length; index++) {
      const choice = choices[index];
      this.choicesHost.append(this.choiceButton(choice, index, enabled));
    }
    if (!phaseActive) {
      this.choicesNote.textContent = '導入の掛け合いを再生中…';
    } else if (this.chosen) {
      this.choicesNote.textContent = '選択を送信しました…';
    } else if (!this.canAct) {
      this.choicesNote.textContent = `${actor?.name ?? '手番のプレイヤー'} が選択しています…`;
    } else {
      this.choicesNote.textContent = '1〜3 キーでも選べます。';
    }
  }

  private choiceButton(choice: EventChoice, index: number, enabled: boolean): HTMLButtonElement {
    return h(
      'button',
      {
        class: 'event-choice',
        attrs: {
          type: 'button',
          disabled: !enabled,
          'aria-label': `${index + 1}: ${choice.label}`,
          style: `--i:${index}`,
        },
        on: {
          click: () => {
            if (!enabled || this.chosen) return;
            this.chosen = true;
            this.refreshChoices();
            this.options.onChoose(index);
          },
        },
      },
      h('span', { class: 'event-choice-num', text: String(index + 1) }),
      h(
        'span',
        { class: 'event-choice-main' },
        h('span', { class: 'event-choice-label', text: choice.label }),
        h('span', { class: 'event-choice-detail' }, ...choiceDetailParts(choice.detail)),
      ),
    );
  }

  private renderImage(event: GameEventDef): void {
    const path = event.image;
    const stem = path ? path.split('/').pop()?.replace(/\.[a-z]+$/i, '') : event.id;
    if (!path || !stem || !EVENT_IMAGE_IDS.has(stem)) {
      this.image.hidden = true;
      this.hero.classList.add('no-image');
      return;
    }
    this.image.hidden = false;
    this.hero.classList.remove('no-image');
    this.image.src = assetUrl(path);
    this.kindBadge.dataset.kind = event.kind;
  }

  private renderMeta(event: GameEventDef): void {
    const parts: HTMLElement[] = [];
    if (event.fact) {
      parts.push(
        h('div', { class: 'event-meta-block' },
          h('h4', { text: '事実（風刺を含まない要約）' }),
          h('p', { text: event.fact }),
        ),
      );
    }
    if (event.sources && event.sources.length > 0) {
      const list = h('ul', { class: 'event-sources' });
      for (const source of event.sources) {
        list.append(
          h(
            'li',
            {},
            h('a', {
              text: source.title,
              attrs: { href: source.url, target: '_blank', rel: 'noopener noreferrer' },
            }),
            source.date ? h('span', { class: 'muted', text: `（${source.date}）` }) : null,
          ),
        );
      }
      parts.push(h('div', { class: 'event-meta-block' }, h('h4', { text: '出典' }), list));
    }
    parts.push(
      h(
        'div',
        { class: 'event-meta-block' },
        h('h4', { text: 'どこが創作・誇張か' }),
        h('p', { class: 'event-satire', text: event.satireNote }),
      ),
    );
    parts.push(
      h('p', {
        class: 'event-disclaimer',
        text: '実在の存命人物を名指しする意図はありません。風刺の対象は制度・政策・金銭欲です。',
      }),
    );
    this.metaBody.replaceChildren(...parts);
  }
}

function choiceDetailParts(detail: string): HTMLElement[] {
  const lines: HTMLElement[] = [];
  const sentences = detail
    .split('。')
    .map((part) => part.trim())
    .filter(Boolean);
  sentences.forEach((sentence, index) => {
    const collapse = sentence.match(/^(\d+)%でバブル崩壊(?:し|する)?[、,]?(.*)$/);
    if (collapse) {
      lines.push(h('span', { class: 'event-choice-risk event-choice-risk-title', text: `崩壊確率 ${collapse[1]}%` }));
      const loss = collapse[2]?.replace(/^[、,]+/, '').trim();
      if (loss) lines.push(h('span', { class: 'event-choice-risk', text: `崩壊時の損失 ${loss}` }));
      return;
    }
    const parts = sentence.split(/、/).map((part) => part.trim()).filter(Boolean);
    const riskSentence = /崩壊|失敗|不足|損失|損|リスク|売却/.test(sentence) && index > 0;
    for (const part of parts) {
      lines.push(h('span', {
        class: riskSentence ? 'event-choice-risk' : 'event-choice-effect',
        text: `${part}${part === parts[parts.length - 1] ? '。' : ''}`,
      }));
    }
  });
  return lines;
}

function seasonOf(month: number): { key: string; label: string; emoji: string } {
  if (month >= 4 && month <= 5) return { key: 'spring', label: '春', emoji: '🌸' };
  if (month >= 6 && month <= 8) return { key: 'summer', label: '夏', emoji: '🌻' };
  if (month >= 9 && month <= 11) return { key: 'autumn', label: '秋', emoji: '🍁' };
  return { key: 'winter', label: '冬', emoji: '⛄' };
}
