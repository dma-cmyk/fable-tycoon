import { Audio } from '../../audio/audio';
import { GAME_DATA } from '../../data/index';
import type { EmoteCategory, EmoteDef } from '../../core/types';
import { COMM } from '../../net/protocol';
import { avatar, h, uiIcon } from '../dom';
import { characterSprite, charsById } from '../format';

export interface EmoteSeatInfo {
  name: string;
  characterId: string | null;
  color: string;
}

export interface EmotePaletteOptions {
  canSend: () => boolean;
  ownSeats: () => number[];
  ownCharacterId: () => string | null;
  seatInfo: (seat: number) => EmoteSeatInfo;
  isMuted: (seat: number) => boolean;
  onSend: (emoteId: string, target: number | null) => void;
  playerCount: () => number;
  onOpenChange?: (open: boolean) => void;
}

const TABS: { category: EmoteCategory; label: string; icon: string }[] = [
  { category: 'emotion', label: '喜怒哀楽', icon: '😊' },
  { category: 'action', label: 'アクション', icon: '💃' },
  { category: 'taunt', label: '煽り', icon: '😏' },
  { category: 'poke', label: 'ちょっかい', icon: '🍅' },
  { category: 'unique', label: '固有技', icon: '✨' },
];

export class EmotePalette {
  readonly fab: HTMLButtonElement;
  readonly panel: HTMLElement;
  private tab: EmoteCategory = 'emotion';
  private open = false;
  private readonly tabsHost: HTMLElement;
  private readonly gridHost: HTMLElement;
  private readonly targetHost: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly cooldownUntil = new Map<string, number>();
  private globalCooldownUntil = 0;
  private raf = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly options: EmotePaletteOptions) {
    this.tabsHost = h('div', { class: 'emote-tabs', attrs: { role: 'tablist', 'aria-label': 'エモートの種類' } });
    this.gridHost = h('div', { class: 'emote-grid' });
    this.targetHost = h('div', { class: 'emote-targets', attrs: { hidden: 'hidden' } });
    this.hint = h('p', { class: 'emote-hint' });

    this.panel = h(
      'div',
      { class: 'emote-palette', attrs: { 'aria-label': 'エモート' } },
      h(
        'header',
        { class: 'emote-head' },
        h('h3', { text: '😆 エモート' }),
        h('button', {
          class: 'emote-close',
          text: '✕',
          attrs: { type: 'button', 'aria-label': 'エモートを閉じる' },
          on: { click: () => this.close() },
        }),
      ),
      this.tabsHost,
      this.gridHost,
      this.targetHost,
      this.hint,
    );

    this.fab = h(
      'button',
      {
        class: 'comm-fab emote-fab',
        attrs: { type: 'button', 'aria-label': 'エモートをひらく', title: 'エモート' },
        on: { click: () => this.toggle() },
      },
      uiIcon('emote', '😆', 'comm-fab-icon'),
      h('span', { class: 'comm-fab-label', text: 'エモート' }),
      h('span', { class: 'comm-fab-ring', attrs: { 'aria-hidden': 'true' } }),
    );

    this.renderTabs();
    this.renderGrid();

    const onUnlocked = () => {
      this.updateCooldowns();
    };
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.cleanup.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked), () => cancelAnimationFrame(this.raf));
  }

  get isOpen(): boolean {
    return this.open;
  }

  openPalette(): void {
    this.open = true;
    this.panel.classList.add('is-open');
    this.options.onOpenChange?.(true);
    this.renderGrid();
    this.fab.setAttribute('aria-label', 'エモートをとじる');
    this.tick();
  }

  close(): void {
    this.open = false;
    this.panel.classList.remove('is-open');
    this.options.onOpenChange?.(false);
    this.fab.setAttribute('aria-label', 'エモートをひらく');
    this.targetHost.hidden = true;
    this.gridHost.hidden = false;
    this.tabsHost.hidden = false;
    cancelAnimationFrame(this.raf);
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPalette();
  }

  /** Server-acknowledged own emote: keep the ring in sync even after reopening. */
  noteUsed(emoteId: string): void {
    const def = GAME_DATA.emotes.find((emote) => emote.id === emoteId);
    const now = performance.now();
    this.globalCooldownUntil = Math.max(this.globalCooldownUntil, now + COMM.emoteMinIntervalMs);
    this.cooldownUntil.set(emoteId, now + (def?.cooldownMs ?? 2500));
    if (this.open) this.updateCooldowns();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const fn of this.cleanup) fn();
  }

  private renderTabs(): void {
    this.tabsHost.replaceChildren();
    for (const tab of TABS) {
      this.tabsHost.append(
        h(
          'button',
          {
            class: 'emote-tab',
            attrs: { type: 'button', role: 'tab', 'aria-selected': String(this.tab === tab.category) },
            on: {
              click: () => {
                this.tab = tab.category;
                            this.targetHost.hidden = true;
                this.gridHost.hidden = false;
                this.tabsHost.hidden = false;
                this.renderTabs();
                this.renderGrid();
                this.updateCooldowns();
              },
            },
          },
          h('span', { text: tab.icon, attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: tab.label }),
        ),
      );
    }
  }

  private availableEmotes(): EmoteDef[] {
    if (this.tab !== 'unique') return GAME_DATA.emotes.filter((emote) => emote.category === this.tab);
    const own = this.options.ownCharacterId();
    return GAME_DATA.emotes.filter((emote) => emote.category === 'unique' && emote.characterId === own);
  }

  private renderGrid(): void {
    this.buttons.clear();
    this.gridHost.replaceChildren();
    const emotes = this.availableEmotes();
    if (emotes.length === 0) {
      this.gridHost.append(
        h('p', {
          class: 'emote-empty',
          text:
            this.tab === 'unique'
              ? 'キャラクターを選ぶと、その子だけの固有技が使えるようになります。'
              : 'まだ使えるエモートがありません。',
        }),
      );
      this.hint.textContent = '';
      return;
    }
    for (const emote of emotes) {
      const btn = h(
        'button',
        {
          class: 'emote-btn',
          attrs: {
            type: 'button',
            'aria-label': `${emote.label}${emote.targeted ? '（相手を選ぶ）' : ''}`,
            title: emote.label,
          },
          on: {
            click: () => this.useEmote(emote),
          },
        },
        h('span', { class: 'emote-icon', text: emote.icon, attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'emote-label', text: emote.label }),
        h('span', { class: 'emote-cd', attrs: { 'aria-hidden': 'true' } }),
      );
      this.buttons.set(emote.id, btn);
      this.gridHost.append(btn);
    }
    const own = this.options.ownCharacterId();
    this.hint.textContent =
      this.tab === 'unique' && own
        ? `${charsById.get(own)?.nameJa ?? 'このキャラ'} だけの決め技。${emoteCooldownText(emotes)}`
        : emoteCooldownText(emotes);
  }

  private useEmote(emote: EmoteDef): void {
    if (!this.options.canSend()) {
      this.hint.textContent = 'いまはエモートを送れません（観戦中 / 手番待ちではありません）。';
      return;
    }
    if (emote.targeted) {
      this.showTargets(emote);
      return;
    }
    this.send(emote.id, null);
  }

  private showTargets(emote: EmoteDef): void {
    this.gridHost.hidden = true;
    this.tabsHost.hidden = true;
    this.targetHost.hidden = false;
    this.targetHost.replaceChildren();
    this.targetHost.append(
      h(
        'div',
        { class: 'emote-target-head' },
        h('span', { text: `${emote.icon} ${emote.label} を誰に？` }),
        h('button', {
          class: 'btn btn-ghost btn-small',
          text: 'やめる',
          attrs: { type: 'button' },
          on: {
            click: () => {
                        this.targetHost.hidden = true;
              this.gridHost.hidden = false;
              this.tabsHost.hidden = false;
            },
          },
        }),
      ),
    );
    const own = new Set(this.options.ownSeats());
    for (let seat = 0; seat < this.options.playerCount(); seat++) {
      if (own.has(seat)) continue;
      const info = this.options.seatInfo(seat);
      if (this.options.isMuted(seat)) continue;
      this.targetHost.append(
        h(
          'button',
          {
            class: 'emote-target',
            attrs: { type: 'button', 'aria-label': `${info.name} に ${emote.label}` },
            on: { click: () => this.send(emote.id, seat) },
          },
          avatar(characterSprite(info.characterId ? charsById.get(info.characterId) : undefined), info.color, 40),
          h('span', { text: info.name }),
          h('span', { class: 'emote-target-go', text: emote.projectile ?? '▶' }),
        ),
      );
    }
    if (this.targetHost.childElementCount === 1) {
      this.targetHost.append(h('p', { class: 'emote-empty', text: '対象にできるプレイヤーがいません。' }));
    }
  }

  private send(emoteId: string, target: number | null): void {
    this.options.onSend(emoteId, target);
    this.noteUsed(emoteId);
    Audio.sfx('emote_pop');
    this.close();
  }

  private tick(): void {
    if (!this.open) return;
    this.updateCooldowns();
    this.raf = requestAnimationFrame(() => this.tick());
  }

  private updateCooldowns(): void {
    const now = performance.now();
    const globalLeft = Math.max(0, this.globalCooldownUntil - now);
    this.fab.classList.toggle('is-cooling', globalLeft > 0);
    this.fab.style.setProperty('--cool', `${Math.min(1, globalLeft / COMM.emoteMinIntervalMs)}`);
    for (const [id, btn] of this.buttons) {
      const until = this.cooldownUntil.get(id) ?? 0;
      const def = GAME_DATA.emotes.find((emote) => emote.id === id);
      const total = def?.cooldownMs ?? 1;
      const emoteLeft = Math.max(0, until - now);
      const blocked = globalLeft > 0 || emoteLeft > 0;
      btn.disabled = blocked || !this.options.canSend();
      btn.classList.toggle('is-cooling', blocked);
      btn.style.setProperty('--cool', `${Math.min(1, Math.max(globalLeft / COMM.emoteMinIntervalMs, emoteLeft / total))}`);
      const cd = btn.querySelector('.emote-cd');
      if (cd) cd.textContent = emoteLeft > 0 ? `${(emoteLeft / 1000).toFixed(1)}` : '';
    }
    if (!this.options.canSend()) this.hint.textContent = 'いまはエモートを送れません。';
  }
}

function emoteCooldownText(emotes: EmoteDef[]): string {
  const min = Math.min(...emotes.map((emote) => emote.cooldownMs)) / 1000;
  return `連打はできません（全体 ${COMM.emoteMinIntervalMs / 1000} 秒 / 固有 ${min}〜${Math.max(...emotes.map((emote) => emote.cooldownMs)) / 1000} 秒）。`;
}