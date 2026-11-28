import type { PublicState } from '../../core/engine';
import type { Effect, EventChoice, GameEventDef } from '../../core/types';
import { peekCityTarget } from '../../core/cityMods';
import { GAME_DATA } from '../../data/index';
import { h } from '../dom';
import { describeEffect } from '../eventEffects';
import { eventFootnoteText, splitChoiceDetail } from '../eventPanelNote';
import { EVENT_IMAGE_IDS } from '../assetManifest';
import { assetUrl, citiesById, KIND_ICON, KIND_JA } from '../format';
import { eventVideoBlock } from './eventVideo';
import { rubyName } from '../ruby';
import { effectiveUiSettings } from '../settings';

export interface EventPanelOptions {
  onChoose: (index: number) => void;
  onSkipFx?: () => void;
  /** ステージが閉じたとき（イベント終了）。演出の出し遅れを拾うための通知。 */
  onHide?: () => void;
}

export interface EventPanelStateMeta {
  /** True while introductory narration/voice fx are still playing before choices unlock. */
  fxPlaying?: boolean;
  /** True when the current event belongs to a human seat controlled by this client. */
  isMine?: boolean;
  /**
   * Local/solo: choices stay clickable while the intro lines play; clicking skips the rest and
   * sends the choice. Online keeps the host-timed intro lock.
   */
  earlyChoice?: boolean;
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
  private readonly choicesHost: HTMLElement;
  private readonly choicesNote: HTMLElement;
  private readonly metaBody: HTMLElement;
  private readonly effectSummary: HTMLElement;
  private readonly footnote: HTMLElement;
  private readonly choiceArea: HTMLElement;
  private readonly metaToggle: HTMLButtonElement;
  private readonly seasonBadge: HTMLElement;
  private event: GameEventDef | null = null;
  get eventId(): string | null { return this.event?.id ?? null; }
  private state: PublicState | null = null;
  private canAct = false;
  private fxPlaying = false;
  private isMine = false;
  private earlyChoice = false;
  private chosen = false;
  private open = false;
  private readonly choicesSkipBtn: HTMLButtonElement;
  private readonly choicesBanner: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly heroKind: HTMLElement;
  private readonly card: HTMLElement;
  /** 選択肢リストを作り直すかどうかの判定用（詳細の開閉状態を保つ）。 */
  private choiceKey = '';

  constructor(private readonly options: EventPanelOptions) {
    this.ribbonTitle = h('span', { class: 'event-ribbon-title', text: '世界ニュースイベント！' });
    this.kindBadge = h('span', { class: 'event-kind-badge' });
    this.commHost = h('div', { class: 'event-comm' });
    this.seasonBadge = h('span', { class: 'event-season-badge', attrs: { hidden: 'hidden' } });
    this.image = h('img', {
      class: 'event-image',
      attrs: { alt: '', draggable: 'false', loading: 'eager', decoding: 'async', fetchpriority: 'high' },
      on: {
        // 失敗してもカードは畳まない: imageFallback が 2 回やり直し、最後は共通の
        // プレースホルダに差し替える。ここで高さを変えると読み込みのたびに画面が跳ねる。
        error: () => {
          this.image.classList.add('is-error');
        },
        load: () => {
          this.image.classList.remove('is-error');
          this.image.hidden = false;
          this.hero.classList.remove('no-image');
        },
      },
    });
    this.titleEl = h('h2', { class: 'event-title' });
    this.byline = h('p', { class: 'event-byline' });
    // ステージでは絵の下にタイトルを置く（絵に重ねない）。絵が無いイベントは
    // 代わりに種別アイコンを大きく出す。
    this.heroKind = h('div', { class: 'event-hero-kind', attrs: { 'aria-hidden': 'true' } });
    this.hero = h('div', { class: 'event-hero no-image' }, this.image, this.heroKind, h('div', { class: 'event-hero-shade' }));
    this.choicesHost = h('div', { class: 'event-choices' });
    this.choicesNote = h('p', { class: 'event-choices-note' });
    this.choicesSkipBtn = h('button', {
      class: 'btn btn-ghost btn-small event-skip-btn',
      text: '演出をスキップして選ぶ ▶▶',
      attrs: { type: 'button', hidden: 'hidden' },
      on: {
        click: (event) => {
          event.stopPropagation();
          this.options.onSkipFx?.();
        },
      },
    });
    this.choicesBanner = h(
      'div',
      { class: 'event-choices-banner', attrs: { hidden: 'hidden', role: 'status', 'aria-live': 'polite' } },
      this.choicesNote,
      this.choicesSkipBtn,
    );
    this.metaBody = h('div', { class: 'event-meta-body', attrs: { hidden: 'hidden' } });
    this.effectSummary = h('section', { class: 'event-effect-summary', attrs: { hidden: 'hidden' } });
    this.footnote = h('p', { class: 'event-footnote' });
    this.prompt = h('p', { class: 'event-choose-prompt', text: 'どうする？' });
    this.choiceArea = h('div', { class: 'event-choice-area' }, this.prompt, this.choicesBanner, this.choicesHost);
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

    // スマホでは「絵カード（上）」「選択肢シート（下）」の 2 枚に分ける。PC では
    // カードを display: contents にして従来どおり 1 枚のパネルとして並べる。
    this.card = h(
      'div',
      { class: 'event-card' },
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
        this.titleEl,
        this.byline,
        h('div', { class: 'event-meta' }, this.metaToggle, this.metaBody),
        this.effectSummary,
      ),
    );
    this.el = h(
      'aside',
      { class: 'event-panel', attrs: { 'aria-label': '世界ニュースイベント', hidden: 'hidden' } },
      this.card,
      // 選択肢はスクロール領域の外。絵や長い説明と競合せず、常に押せる位置に残る。
      this.choiceArea,
      this.footnote,
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(event: GameEventDef, state: PublicState, playerName: string): void {
    this.event = event;
    this.state = state;
    this.chosen = false;
    this.open = true;
    this.el.hidden = false;
    this.el.classList.add('is-open');
    this.el.closest('.game-screen')?.classList.add('event-open');
    this.titleEl.textContent = event.title;
    this.heroKind.textContent = KIND_ICON[event.kind];
    // さくさく（fxSpeed >= 2）ではステージの開閉を短くする。設定が読めない環境
    // （単体テストの偽 DOM など）では既定の 250ms にしておく。
    let stageMs = '250ms';
    try {
      if (effectiveUiSettings().fxSpeed >= 2) stageMs = '120ms';
    } catch {
      stageMs = '250ms';
    }
    this.el.style.setProperty('--stage-ms', stageMs);
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
    this.renderEffectSummary(event);
    this.renderFootnote(event);
    this.setState(state, false);
  }

  hide(): void {
    const wasOpen = this.open;
    this.open = false;
    this.chosen = false;
    this.el.classList.remove('is-open');
    this.el.hidden = true;
    this.el.closest('.game-screen')?.classList.remove('event-open');
    // ステージ中に遅らせたカットイン（寄り道の依頼など）をここで流す。
    if (wasOpen) this.options.onHide?.();
  }

  setState(state: PublicState, canAct: boolean, meta?: EventPanelStateMeta): void {
    this.state = state;
    this.canAct = canAct;
    if (meta) {
      if (meta.fxPlaying !== undefined) this.fxPlaying = meta.fxPlaying;
      if (meta.isMine !== undefined) this.isMine = meta.isMine;
      if (meta.earlyChoice !== undefined) this.earlyChoice = meta.earlyChoice;
    }
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
    if (choices.length === 0) {
      // The effect summary card + footnote already explain auto-application; a third
      // line here only padded the panel.
      this.choiceArea.classList.remove('is-fx-waiting');
      this.el.classList.remove('is-choosing');
      this.choicesHost.replaceChildren();
      this.choiceKey = '';
      this.choicesBanner.hidden = true;
      this.choicesNote.hidden = true;
      this.choicesNote.textContent = '';
      this.choicesSkipBtn.hidden = true;
      return;
    }
    const phaseActive = state.phase.t === 'event';
    const waitingFx = this.fxPlaying && !this.chosen;
    const enabled = phaseActive && this.canAct && !this.chosen && (!waitingFx || this.earlyChoice);
    const actor = state.players[state.current];
    // Solo/local early pick keeps the choices bright while the intro plays.
    this.choiceArea.classList.toggle('is-fx-waiting', (waitingFx && !this.earlyChoice) || !phaseActive);
    // スマホの 2 段階表示: 導入（台詞）中は Phase A（絵カード＋台詞のみ）、
    // 人間が選べるようになったら Phase B（メッセージウィンドウの位置に選択肢）。
    const choosing = phaseActive && this.isMine && this.canAct && !this.chosen && !waitingFx;
    this.el.classList.toggle('is-choosing', choosing);
    const choiceKey = `${enabled ? 1 : 0}|${choices.length}|${event.id}|${this.chosen ? 1 : 0}`;
    if (choiceKey !== this.choiceKey) {
      this.choiceKey = choiceKey;
      this.choicesHost.replaceChildren();
      for (let index = 0; index < choices.length; index++) {
        this.choicesHost.append(this.choiceButton(choices[index], index, enabled));
      }
    }
    if (waitingFx && this.earlyChoice && this.canAct) {
      this.choicesBanner.hidden = false;
      this.choicesNote.hidden = false;
      this.choicesNote.textContent = '台詞の途中でも選べます（選ぶと残りを飛ばす）';
      // ローカル/ソロの「台詞を早送り」: 残りの導入を読み飛ばして選択肢の前へ。
      this.choicesSkipBtn.hidden = !this.options.onSkipFx;
      this.choicesSkipBtn.textContent = '⏩ 台詞を早送り';
    } else if (waitingFx && (this.isMine || !phaseActive)) {
      this.choicesBanner.hidden = false;
      this.choicesNote.hidden = false;
      this.choicesNote.textContent = '演出のあとで選べます';
      this.choicesSkipBtn.hidden = !this.options.onSkipFx;
      this.choicesSkipBtn.textContent = '演出をスキップして選ぶ ▶▶';
    } else if (!phaseActive) {
      this.choicesBanner.hidden = false;
      this.choicesNote.hidden = false;
      this.choicesNote.textContent = '演出のあとで選べます';
      this.choicesSkipBtn.hidden = true;
    } else if (this.chosen) {
      this.choicesBanner.hidden = false;
      this.choicesNote.hidden = false;
      this.choicesNote.textContent = '選択を送信しました…';
      this.choicesSkipBtn.hidden = true;
    } else if (!this.canAct) {
      this.choicesBanner.hidden = false;
      this.choicesNote.hidden = false;
      this.choicesNote.textContent = `${actor?.name ?? '手番のプレイヤー'} が選択しています…`;
      this.choicesSkipBtn.hidden = true;
    } else {
      // Ready to pick: hide the waiting banner so choices stand out cleanly.
      this.choicesBanner.hidden = true;
      this.choicesNote.hidden = true;
      this.choicesNote.textContent = '';
      this.choicesSkipBtn.hidden = true;
    }
  }

  /**
   * 1 択ぶんの行。スマホでは「番号＋見出し＋1 行要約」のコンパクト表示にし、
   * 「詳細」で効果テキスト全文を開閉する。PC は従来どおり全文を出したまま。
   */
  private choiceButton(choice: EventChoice, index: number, enabled: boolean): HTMLElement {
    const parts = splitChoiceDetail(choice.detail);
    const summary = parts[0]?.text ?? choice.detail;
    const full = h(
      'span',
      { class: 'event-choice-full' },
      h('span', { class: 'event-choice-detail' }, ...choiceDetailParts(choice.detail)),
      ...this.cityTargetChips(choice.effects),
    );
    const button = h(
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
        h('span', { class: 'event-choice-summary', text: summary }),
        full,
      ),
    );
    const more = h('button', {
      class: 'event-choice-more',
      text: '詳細',
      attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': `${index + 1} の効果を詳しく見る` },
      on: {
        click: (event) => {
          event.stopPropagation();
          const open = !full.classList.contains('is-open');
          full.classList.toggle('is-open', open);
          more.setAttribute('aria-expanded', String(open));
          more.textContent = open ? '閉じる' : '詳細';
        },
      },
    });
    return h('div', { class: 'event-choice-item' }, h('div', { class: 'event-choice-head' }, button, more));
  }

  /**
   * 「どの街の話か」をルビ付きで示すチップ。対象がランダムなときは出さない
   * （イベント詳細文には「ランダムな都市」と書いてある）。
   */
  private cityTargetChips(effects: Effect[] | undefined): HTMLElement[] {
    const state = this.state;
    if (!state) return [];
    const ids: string[] = [];
    const collect = (list: Effect[]): void => {
      for (const effect of list) {
        if (effect.op === 'city_mod') {
          const cityId = peekCityTarget(GAME_DATA, state, effect.city, state.current);
          if (cityId && !ids.includes(cityId)) ids.push(cityId);
        } else if (effect.op === 'gamble') {
          collect(effect.win);
          collect(effect.lose);
        }
      }
    };
    collect(effects ?? []);
    const chips: HTMLElement[] = [];
    for (const cityId of ids) {
      const city = citiesById.get(cityId);
      if (!city) continue;
      chips.push(
        h(
          'span',
          { class: 'event-city-chip' },
          h('span', { class: 'event-city-chip-icon', text: '📍', attrs: { 'aria-hidden': 'true' } }),
          rubyName(city.nameJa, city.nameKana),
        ),
      );
    }
    return chips;
  }

  private renderImage(event: GameEventDef): void {
    const path = event.image;
    const stem = path ? path.split('/').pop()?.replace(/\.[a-z]+$/i, '') : event.id;
    if (!path || !stem || !EVENT_IMAGE_IDS.has(stem)) {
      this.image.hidden = true;
      this.image.removeAttribute('src');
      this.hero.classList.add('no-image');
      return;
    }
    // 前のイベントで失敗した印が残っていると imageFallback の再試行が効かなくなる。
    delete this.image.dataset.imgRetry;
    delete this.image.dataset.imgFallback;
    this.image.classList.remove('is-error');
    this.image.hidden = false;
    this.hero.classList.remove('no-image');
    this.image.src = assetUrl(path);
    this.kindBadge.dataset.kind = event.kind;
  }

  /**
   * Choice events advertise the 1–3 keys; auto-applied events only advance when the player
   * taps to skip, so the selection hint must not appear there.
   */
  private renderFootnote(event: GameEventDef): void {
    this.footnote.textContent = eventFootnoteText(event);
  }

  /** Effect summary card for auto-applied (choice-less) events. */
  private renderEffectSummary(event: GameEventDef): void {
    const hasChoices = (event.choices?.length ?? 0) > 0;
    const effects = event.effects ?? [];
    this.el.classList.toggle('is-compact', !hasChoices);
    // An empty choice strip (border + padding, no buttons) read as a dead band at the
    // bottom of auto-applied events.
    this.choiceArea.hidden = !hasChoices;
    if (hasChoices || effects.length === 0) {
      this.effectSummary.hidden = true;
      this.effectSummary.replaceChildren();
      return;
    }
    this.effectSummary.hidden = false;
    const chips = this.cityTargetChips(effects);
    this.effectSummary.replaceChildren(
      h('h4', { class: 'event-effect-title', text: '自動で適用される効果' }),
      h('ul', { class: 'event-effect-list' }, ...effects.map((effect) => h('li', { text: describeEffect(effect) }))),
      ...chips,
    );
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
    if (event.video) parts.push(eventVideoBlock(event.video));
    this.metaBody.replaceChildren(...parts);
  }
}

function choiceDetailParts(detail: string): HTMLElement[] {
  return splitChoiceDetail(detail).map((part) => {
    const cls =
      part.kind === 'risk-title'
        ? 'event-choice-risk event-choice-risk-title'
        : part.kind === 'risk-loss'
          ? 'event-choice-risk event-choice-risk-loss'
          : part.kind === 'risk'
            ? 'event-choice-risk'
            : 'event-choice-effect';
    return h('span', { class: cls, text: part.text });
  });
}

function seasonOf(month: number): { key: string; label: string; emoji: string } {
  if (month >= 4 && month <= 5) return { key: 'spring', label: '春', emoji: '🌸' };
  if (month >= 6 && month <= 8) return { key: 'summer', label: '夏', emoji: '🌻' };
  if (month >= 9 && month <= 11) return { key: 'autumn', label: '秋', emoji: '🍁' };
  return { key: 'winter', label: '冬', emoji: '⛄' };
}
