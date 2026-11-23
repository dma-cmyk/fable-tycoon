import type { ChatLine } from '../../net/protocol';
import { COMM } from '../../net/protocol';
import type { Session } from '../../net/session-types';
import { avatar, h } from '../dom';
import { characterSprite, charsById, formatClock } from '../format';

export interface ChatSeatInfo {
  name: string;
  characterId: string | null;
  color: string;
}

export interface ChatPanelOptions {
  session: Session;
  canChat: () => boolean;
  seatInfo: (seat: number) => ChatSeatInfo;
  isMuted: (seat: number) => boolean;
  showChat: () => boolean;
  onIncoming?: (line: ChatLine) => void;
  class?: string;
}

const QUICK_PHRASES = ['よろしく！', 'ナイス！', 'やられた〜', 'それはズルい！', 'GG！', '待って！'];
const MAX_RENDERED = 60;

export class ChatPanel {
  readonly fab: HTMLButtonElement;
  readonly panel: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly counter: HTMLElement;
  private readonly unreadBadge: HTMLElement;
  private readonly cooldownHint: HTMLElement;
  private open = false;
  private unread = 0;
  private cooldown = false;
  private readonly cleanup: (() => void)[] = [];
  private rendered: ChatLine[] = [];

  constructor(private readonly options: ChatPanelOptions) {
    this.logEl = h('div', { class: 'chat-log scroll-y', attrs: { role: 'log', 'aria-live': 'polite' } });

    this.input = h('input', {
      class: 'input chat-input',
      attrs: {
        type: 'text',
        maxlength: String(COMM.chatMaxChars),
        placeholder: 'メッセージ（80文字まで）',
        'aria-label': 'チャット入力',
        autocomplete: 'off',
      },
      on: {
        input: () => this.updateInputState(),
        keydown: (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            this.send();
          }
        },
      },
    });
    this.counter = h('span', { class: 'chat-counter', text: `0/${COMM.chatMaxChars}` });
    this.sendBtn = h('button', {
      class: 'btn btn-gold chat-send',
      text: '送信',
      attrs: { type: 'button' },
      on: { click: () => this.send() },
    });
    this.cooldownHint = h('p', { class: 'chat-cooldown', attrs: { 'aria-live': 'polite' } });

    const quick = h('div', { class: 'chat-quick' });
    for (const phrase of QUICK_PHRASES) {
      quick.append(
        h('button', {
          class: 'chat-chip',
          text: phrase,
          attrs: { type: 'button' },
          on: { click: () => this.sendText(phrase) },
        }),
      );
    }

    this.panel = h(
      'div',
      { class: `chat-panel ${options.class ?? ''}`.trim(), attrs: { 'aria-label': 'チャット' } },
      h(
        'header',
        { class: 'chat-head' },
        h('h3', { text: '💬 チャット' }),
        h('button', {
          class: 'chat-close',
          text: '✕',
          attrs: { type: 'button', 'aria-label': 'チャットを閉じる' },
          on: { click: () => this.close() },
        }),
      ),
      this.logEl,
      quick,
      h('div', { class: 'chat-compose' }, this.input, this.counter, this.sendBtn),
      this.cooldownHint,
    );

    this.unreadBadge = h('span', { class: 'icon-btn-badge chat-unread', text: '0', attrs: { hidden: 'hidden' } });
    this.fab = h(
      'button',
      {
        class: 'comm-fab chat-fab',
        attrs: { type: 'button', 'aria-label': 'チャットをひらく', title: 'チャット' },
        on: { click: () => this.toggle() },
      },
      h('span', { class: 'comm-fab-icon', text: '💬', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'comm-fab-label', text: 'チャット' }),
      this.unreadBadge,
    );

    this.updateInputState();
    this.addSystem('チャットとエモートは、手番に関係なくいつでも使えます。');

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !this.open) return;
      if (document.querySelector('.modal-backdrop')) return;
      event.stopPropagation();
      this.close();
    };
    document.addEventListener('keydown', onKey);
    this.cleanup.push(() => document.removeEventListener('keydown', onKey));
  }

  /** True when incoming chat should produce bubbles and log lines. */
  incomingVisible(seat: number): boolean {
    if (!this.options.showChat()) return false;
    if (seat >= 0 && this.options.isMuted(seat)) return false;
    return true;
  }

  addLine(line: ChatLine): void {
    if (line.seat < 0) {
      this.addSystem(line.text);
      return;
    }
    if (!this.incomingVisible(line.seat)) {
      if (this.open) this.appendMutedNotice();
      return;
    }
    this.rendered.push(line);
    while (this.rendered.length > MAX_RENDERED) this.rendered.shift();
    this.renderLog();
    if (!this.open) {
      this.unread++;
      this.updateUnread();
    }
    if (this.open) this.scrollToBottom();
    this.options.onIncoming?.(line);
  }

  addSystem(text: string): void {
    this.rendered.push({ id: -Date.now() - Math.random(), seat: -1, text, at: Date.now() });
    while (this.rendered.length > MAX_RENDERED) this.rendered.shift();
    this.renderLog();
    if (this.open) this.scrollToBottom();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Call when the local seat / permission changes outside of a new message. */
  refresh(): void {
    this.updateInputState();
  }

  notifyRateLimited(message: string): void {
    this.cooldownHint.textContent = message;
    window.setTimeout(() => {
      if (this.cooldownHint.textContent === message) this.cooldownHint.textContent = '';
    }, 2600);
  }

  openPanel(): void {
    this.open = true;
    this.panel.classList.add('is-open');
    this.fab.setAttribute('aria-label', 'チャットをとじる');
    this.unread = 0;
    this.updateUnread();
    this.renderLog();
    this.scrollToBottom();
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  close(): void {
    this.open = false;
    this.panel.classList.remove('is-open');
    this.fab.setAttribute('aria-label', 'チャットをひらく');
    this.input.blur();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPanel();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
  }

  private appendMutedNotice(): void {
    const notice = h('p', { class: 'chat-muted-note', text: 'ミュート中のプレイヤーの発言は表示しません。' });
    this.logEl.append(notice);
    window.setTimeout(() => notice.remove(), 1600);
  }

  private renderLog(): void {
    this.logEl.replaceChildren();
    if (!this.options.showChat()) {
      this.logEl.append(
        h('p', {
          class: 'chat-empty',
          text: '設定でチャット表示がオフになっています。設定 → チャットを表示 でオンにできます。',
        }),
      );
      return;
    }
    if (this.rendered.length === 0) {
      this.logEl.append(h('p', { class: 'chat-empty', text: 'まだ発言はありません。' }));
      return;
    }
    for (const line of this.rendered) {
      if (line.seat < 0) {
        this.logEl.append(h('p', { class: 'chat-system', text: line.text }));
        continue;
      }
      const info = this.options.seatInfo(line.seat);
      const muted = this.options.isMuted(line.seat);
      const mine = this.options.session.mySeats().includes(line.seat);
      const sprite = characterSprite(info.characterId ? charsById.get(info.characterId) : undefined);
      const bubble = h(
        'div',
        { class: `chat-line ${mine ? 'is-mine' : ''} ${muted ? 'is-muted' : ''}`.trim() },
        avatar(sprite, info.color, 30, 'chat-avatar'),
        h(
          'div',
          { class: 'chat-bubble' },
          h(
            'div',
            { class: 'chat-meta' },
            h('span', { class: 'chat-name', text: info.name }),
            h('span', { class: 'chat-time', text: formatClock(line.at) }),
          ),
          h('p', { class: 'chat-text', text: muted ? '（ミュート中）' : line.text }),
        ),
      );
      this.logEl.append(bubble);
    }
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  }

  private updateUnread(): void {
    this.unreadBadge.textContent = String(this.unread);
    this.unreadBadge.hidden = this.unread === 0;
  }

  private updateInputState(): void {
    const length = this.input.value.length;
    this.counter.textContent = `${length}/${COMM.chatMaxChars}`;
    const canChat = this.options.canChat();
    this.input.disabled = !canChat;
    this.sendBtn.disabled = !canChat || this.cooldown || this.input.value.trim().length === 0;
    this.input.placeholder = canChat ? 'メッセージ（80文字まで）' : '観戦中は発言できません';
  }

  private send(): void {
    this.sendText(this.input.value.trim());
  }

  private sendText(text: string): void {
    if (!text || this.cooldown) return;
    if (!this.options.canChat()) {
      this.notifyRateLimited('この席からは発言できません。');
      return;
    }
    this.options.session.send({ t: 'chat', text: text.slice(0, COMM.chatMaxChars) });
    this.input.value = '';
    this.updateInputState();
    this.cooldown = true;
    this.updateInputState();
    this.cooldownHint.textContent = '送信しました';
    window.setTimeout(() => {
      this.cooldown = false;
      this.cooldownHint.textContent = '';
      this.updateInputState();
    }, COMM.chatMinIntervalMs);
  }
}

