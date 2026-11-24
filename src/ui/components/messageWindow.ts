import {
  charsPerPage,
  paginateText,
  postVoicePauseMs,
  revealMs,
  scaledPageReadMs,
  type WindowMetrics,
} from '../messagePages';
import { MessageCursor } from '../messageCursor';
import { h } from '../dom';
import { motionReduced } from '../motion';

export interface MessageLine {
  speaker: string;
  name: string;
  text: string;
  /** Speaker portrait URL (character sprite / NPC art). Narrator shows a mic icon. */
  sprite?: string;
  /** Accent color for the name plate. */
  color?: string;
  /** Effective speed multiplier for this line (includes queue catch-up 2x). */
  speed?: number;
  /** Override auto-advance for this line (defaults to true). */
  autoAdvance?: boolean;
  /** Bounded voice promise: final page stays visible until it settles, then closes after a brief pause. */
  voiceDone?: Promise<void>;
  /** True once voice playback actually started; when false, fall back to reading-time dwell. */
  voiceStarted?: () => boolean;
}

export interface MessageWindowOptions {
  /** Current fx speed (1, 2, 4, 8); affects reveal + read time. */
  speed: () => number;
  /** Extra class for layout variants (e.g. above an open event panel). */
  className?: string;
  /** Notified whenever visibility or manual-advance waiting state changes. */
  onStateChange?: () => void;
}

/**
 * One Momotetsu-style message window for every spoken / narrative line. Lines queue and show one
 * at a time; long text is paged. When voice plays, the final page stays visible until the voice
 * finishes and then advances after a brief pause; when silent, a speed-scaled read timer advances.
 */
export class MessageWindow {
  readonly el: HTMLElement;
  private readonly cursor = new MessageCursor<MessageLine>();
  private readonly portrait: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly pagerEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private pages: string[] = [];
  private pageIndex = 0;
  private timer = 0;
  private revealing = false;
  private lineToken = 0;

  constructor(private readonly options: MessageWindowOptions) {
    this.portrait = h('span', { class: 'msgwin-portrait' });
    this.nameEl = h('span', { class: 'msgwin-name', text: '' });
    this.textEl = h('span', { class: 'msgwin-text', text: '' });
    this.pagerEl = h('span', { class: 'msgwin-pager', text: '' });
    this.nextEl = h('span', { class: 'msgwin-next', text: '▼', attrs: { 'aria-hidden': 'true' } });
    this.el = h(
      'section',
      {
        class: `msgwin ${options.className ?? ''}`.trim(),
        attrs: {
          hidden: 'hidden',
          role: 'log',
          'aria-live': 'polite',
          'aria-label': 'メッセージウィンドウ',
          tabindex: '0',
        },
        on: {
          click: () => this.advance(),
          pointerdown: (event) => {
            // A tap on the window advances text; it must not also skip the whole cutscene,
            // but it must not block game input either (the command bar sits below).
            event.stopPropagation();
          },
        },
      },
      h(
        'div',
        { class: 'msgwin-body' },
        h('div', { class: 'msgwin-face' }, this.portrait, this.nameEl),
        h(
          'div',
          { class: 'msgwin-copy' },
          h('span', { class: 'msgwin-line' }, this.textEl),
          h('span', { class: 'msgwin-foot' }, this.pagerEl, this.nextEl),
        ),
      ),
    );
  }

  get busy(): boolean {
    return this.cursor.busy;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  get isManualWaiting(): boolean {
    return this.visible && this.cursor.current?.autoAdvance === false;
  }

  get currentText(): string {
    return this.textEl.textContent ?? '';
  }

  /** Enqueue a line. The promise resolves when it has been advanced past. */
  show(line: MessageLine): Promise<void> {
    const promise = this.cursor.push(line);
    if (!this.visible) this.render();
    return promise;
  }

  /** Clears the queue and hides the window (resync / generation change / result screen). */
  clear(): void {
    this.lineToken += 1;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.cursor.clear();
    this.pages = [];
    this.pageIndex = 0;
    this.revealing = false;
    this.el.hidden = true;
    this.el.classList.remove('is-visible', 'is-manual-wait');
    this.nextEl.textContent = '▼';
    this.options.onStateChange?.();
  }

  /** Immediately finish the current line (all pages) and move on. Used by fx skip. */
  skipLine(): void {
    if (!this.cursor.current) return;
    this.lineToken += 1;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.revealing = false;
    this.cursor.advance();
    this.render();
  }

  /** Finish the reveal, then page, then move to the next line. Bound to tap / Enter / Space. */
  advance(): void {
    if (!this.cursor.current) return;
    if (this.revealing) {
      this.finishReveal();
      return;
    }
    if (this.pageIndex + 1 < this.pages.length) {
      this.pageIndex += 1;
      this.renderPage();
      return;
    }
    this.lineToken += 1;
    this.cursor.advance();
    this.render();
  }

  /** True when the key event was consumed by the window. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.cursor.current) return false;
    if (event.key !== ' ' && event.key !== 'Enter') return false;
    event.preventDefault();
    this.advance();
    return true;
  }

  destroy(): void {
    this.clear();
    this.el.remove();
  }

  private render(): void {
    const line = this.cursor.current;
    window.clearTimeout(this.timer);
    if (!line) {
      this.pages = [];
      this.pageIndex = 0;
      this.el.hidden = true;
      this.el.classList.remove('is-visible', 'is-manual-wait');
      this.nextEl.textContent = '▼';
      this.pagerEl.textContent = '';
      this.options.onStateChange?.();
      return;
    }
    // Show first so the box has a layout, then paginate against its real text width
    // (the CSS width differs a lot between PC, phone portrait and landscape).
    this.el.hidden = false;
    this.el.classList.add('is-visible');
    const manual = line.autoAdvance === false;
    this.el.classList.toggle('is-manual-wait', manual);
    this.nextEl.textContent = manual ? 'タップで次へ ▼' : '▼';
    this.options.onStateChange?.();
    this.pages = paginateText(line.text, charsPerPage(this.metrics()));
    this.pageIndex = 0;
    this.portrait.replaceChildren(
      line.sprite
        ? h('img', { attrs: { src: line.sprite, alt: '', draggable: 'false' } })
        : h('span', { class: 'msgwin-mic', text: '🎙️', attrs: { 'aria-hidden': 'true' } }),
    );
    this.nameEl.textContent = line.name;
    this.nameEl.style.setProperty('--msgwin-accent', line.color ?? '#ffd23f');
    this.el.dataset.speaker = line.speaker;
    this.renderPage();
  }

  private metrics(): WindowMetrics {
    const phone = window.matchMedia('(max-width: 899px)').matches;
    const landscape = window.matchMedia('(max-height: 520px)').matches;
    // Prefer the live text box: the CSS width depends on the event panel, safe areas and
    // the landscape split, so a viewport-derived guess clips long lines.
    const measured = this.textEl.clientWidth;
    const fallback = phone ? Math.max(180, window.innerWidth - 172) : Math.min(520, Math.round(window.innerWidth * 0.4));
    return {
      width: measured > 40 ? measured : fallback,
      lines: landscape ? 2 : 3,
      fontSize: phone ? 15 : 17,
    };
  }

  private currentSpeed(): number {
    const lineSpeed = this.cursor.current?.speed;
    return Math.max(1, lineSpeed ?? this.options.speed());
  }

  private renderPage(): void {
    const page = this.pages[this.pageIndex] ?? '';
    const token = ++this.lineToken;
    window.clearTimeout(this.timer);
    this.textEl.textContent = '';
    this.pagerEl.textContent = this.pages.length > 1 ? `${this.pageIndex + 1}/${this.pages.length}` : '';
    this.nextEl.classList.remove('is-ready');
    const speed = this.currentSpeed();
    const reveal = revealMs(page, speed, motionReduced());
    if (reveal <= 0) {
      this.revealing = false;
      this.textEl.textContent = page;
      this.scheduleAdvance(token);
      return;
    }
    this.revealing = true;
    const start = performance.now();
    const total = Math.max(1, page.length);
    const tick = (): void => {
      if (token !== this.lineToken) return;
      const p = Math.min(1, (performance.now() - start) / reveal);
      this.textEl.textContent = page.slice(0, Math.max(1, Math.ceil(total * p)));
      if (p < 1) {
        this.timer = window.setTimeout(tick, 16);
      } else {
        // Keep the page on screen until voice ends (or read time elapses); only then auto-advance.
        this.revealing = false;
        this.nextEl.classList.add('is-ready');
        this.holdThenAdvance(page, token);
      }
    };
    this.timer = window.setTimeout(tick, 16);
  }

  private finishReveal(): void {
    const token = ++this.lineToken;
    window.clearTimeout(this.timer);
    this.textEl.textContent = this.pages[this.pageIndex] ?? '';
    this.revealing = false;
    this.scheduleAdvance(token);
  }

  /** ▼ blink and advance once voice / read time finishes (or wait for tap when autoAdvance is off). */
  private scheduleAdvance(token: number): void {
    this.nextEl.classList.add('is-ready');
    this.holdThenAdvance(this.pages[this.pageIndex] ?? '', token);
  }

  /**
   * Hold each page while speaking or reading:
   * - If `autoAdvance === false`: keep the window visible with ▼ until the user taps / presses Space/Enter.
   * - On the final page with an active voice: wait for the bounded voice promise, then advance after a brief pause.
   * - Otherwise (silent / muted / intermediate page): advance after speed-scaled page reading time.
   */
  private holdThenAdvance(page: string, token: number): void {
    const line = this.cursor.current;
    if (!line || token !== this.lineToken) return;
    if (line.autoAdvance === false) {
      // Manual advance mode: stay visible until the player taps or skips.
      return;
    }
    const speed = this.currentSpeed();
    const isLastPage = this.pageIndex + 1 >= this.pages.length;
    if (isLastPage && line.voiceDone) {
      const readMs = scaledPageReadMs(page, speed);
      const revealedAt = performance.now();
      void line.voiceDone.then(() => {
        if (token !== this.lineToken) return;
        const spoke = line.voiceStarted ? line.voiceStarted() : true;
        const remaining = spoke
          ? postVoicePauseMs(speed)
          : Math.max(40, readMs - Math.round(performance.now() - revealedAt));
        this.timer = window.setTimeout(() => {
          if (token !== this.lineToken) return;
          this.timer = 0;
          this.advance();
        }, remaining);
      });
      return;
    }
    const readMs = scaledPageReadMs(page, speed);
    this.timer = window.setTimeout(() => {
      if (token !== this.lineToken) return;
      this.timer = 0;
      this.advance();
    }, readMs);
  }
}
