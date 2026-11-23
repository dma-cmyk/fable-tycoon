/** Tiny DOM builder + modal/toast hosts. No framework, no virtual DOM. */

type EventHandlers = {
  [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
};

export interface DomProps {
  class?: string;
  text?: string;
  id?: string;
  title?: string;
  role?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  on?: EventHandlers;
}

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: DomProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.id) el.id = props.id;
  if (props.title) el.title = props.title;
  if (props.role) el.setAttribute('role', props.role);
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) el.dataset[key] = value;
  }
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) {
      if (handler) el.addEventListener(name, handler as EventListener);
    }
  }
  if (children.some((child) => child !== null && child !== undefined && child !== false)) {
    setChildren(el, ...children);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(
  tag: string,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  setChildren(el, ...children);
  return el;
}

export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  appendChildren(parent, ...children);
}

export function appendChildren(parent: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(element: Element): void {
  element.replaceChildren();
}

export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  className = 'btn',
): HTMLButtonElement {
  return h('button', { class: className, text: label, attrs: { type: 'button' }, on: { click: onClick } });
}

import { UI_ICON_FILES } from './assetManifest';

/** Renders a generated glossy UI icon when available, otherwise the emoji fallback. */
export function uiIcon(name: string, emoji: string, className = 'ui-icon'): HTMLElement {
  if (UI_ICON_FILES.has(name)) {
    return h('span', { class: className }, h('img', {
      attrs: {
        src: `${import.meta.env.BASE_URL}assets/ui/${name}.webp`,
        alt: '',
        draggable: 'false',
      },
    }));
  }
  return h('span', { class: className, text: emoji, attrs: { 'aria-hidden': 'true' } });
}

export interface IconButtonOptions {
  class?: string;
  badge?: string | number;
  title?: string;
  sound?: boolean;
}

export function iconButton(
  icon: string,
  label: string,
  onClick: (event: MouseEvent) => void,
  options: IconButtonOptions = {},
): HTMLButtonElement {
  const badge = options.badge ? h('span', { class: 'icon-btn-badge', text: String(options.badge) }) : null;
  return h(
    'button',
    {
      class: `icon-btn ${options.class ?? ''}`.trim(),
      attrs: {
        type: 'button',
        'aria-label': options.title ?? label,
        title: options.title ?? label,
        ...(options.sound === false ? { 'data-nosound': '' } : {}),
      },
      on: { click: onClick },
    },
    uiIcon(icon, icon, 'icon-btn-icon'),
    h('span', { class: 'icon-btn-label', text: label }),
    badge,
  );
}

export function avatar(
  src: string,
  color: string,
  size: number,
  extraClass = '',
  alt = '',
): HTMLElement {
  return h(
    'span',
    {
      class: `avatar ${extraClass}`.trim(),
      attrs: {
        style: `--player-color:${color};--avatar-size:${size}px`,
      },
    },
    src
      ? h('img', { attrs: { src, alt, draggable: 'false', loading: 'lazy' } })
      : h('span', { class: 'avatar-fallback', text: '？' }),
  );
}

// ---------------------------------------------------------------- modal host

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  ribbon?: boolean;
  className?: string;
  dismissible?: boolean;
  onClose?: () => void;
  initialFocus?: HTMLElement | null;
}

export interface ModalHandle {
  readonly root: HTMLElement;
  readonly panel: HTMLElement;
  readonly body: HTMLElement;
  close(): void;
  setCloseEnabled(enabled: boolean): void;
}

interface ModalEntry {
  backdrop: HTMLElement;
  panel: HTMLElement;
  options: ModalOptions;
  dismissible: boolean;
  closed: boolean;
  close: () => void;
}

export class ModalHost {
  readonly el: HTMLElement;
  private readonly stack: ModalEntry[] = [];

  constructor() {
    this.el = h('div', { class: 'modal-host', attrs: { 'aria-live': 'polite' } });
  }

  isOpen(): boolean {
    return this.stack.length > 0;
  }

  open(content: HTMLElement, options: ModalOptions = {}): ModalHandle {
    const dismissible = options.dismissible ?? true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = h('div', {
      class: `modal-panel ${options.className ?? ''}`.trim(),
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        tabindex: '-1',
        ...(options.title ? { 'aria-label': options.title } : {}),
      },
    });
    if (options.title) {
      const head = h(
        'header',
        { class: `modal-head ${options.ribbon ? 'ribbon-head' : ''}`.trim() },
        h(
          'div',
          { class: 'modal-head-titles' },
          h('h2', { class: 'modal-title', text: options.title }),
          options.subtitle ? h('p', { class: 'modal-subtitle', text: options.subtitle }) : null,
        ),
        dismissible
          ? h('button', {
              class: 'modal-close',
              text: '✕',
              attrs: { type: 'button', 'aria-label': '閉じる' },
              on: { click: () => close() },
            })
          : null,
      );
      panel.append(head);
    }
    const body = h('div', { class: 'modal-body' });
    body.append(content);
    panel.append(body);

    const backdrop = h('div', { class: 'modal-backdrop', attrs: { 'aria-hidden': 'false' } }, panel);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const index = this.stack.findIndex((entry) => entry.backdrop === backdrop);
      if (index >= 0) this.stack.splice(index, 1);
      backdrop.classList.add('closing');
      window.setTimeout(() => backdrop.remove(), 120);
      entry.closed = true;
      options.onClose?.();
      this.syncBackgroundInert();
      if (this.stack.length === 0 && previousFocus?.isConnected) {
        window.setTimeout(() => previousFocus.focus({ preventScroll: true }), 0);
      } else if (this.stack.length > 0) {
        const top = this.stack[this.stack.length - 1];
        window.setTimeout(() => {
          const focusable = top.panel.querySelector<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          );
          focusable?.focus({ preventScroll: true });
        }, 0);
      }
    };
    const entry: ModalEntry = { backdrop, panel, options, dismissible, closed: false, close };
    if (dismissible) {
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close();
      });
    }
    this.el.append(backdrop);
    this.stack.push(entry);
    const focusTarget =
      options.initialFocus ??
      (panel.querySelector('.modal-close') as HTMLElement | null) ??
      (panel.querySelector('button') as HTMLElement | null) ??
      panel;
    this.syncBackgroundInert();
    requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    return {
      root: backdrop,
      panel,
      body,
      close,
      setCloseEnabled(enabled: boolean) {
        panel.querySelectorAll<HTMLButtonElement>('.modal-close').forEach((b) => {
          b.disabled = !enabled;
        });
      },
    };
  }

  private syncBackgroundInert(): void {
    const inert = this.stack.length > 0;
    document.querySelectorAll<HTMLElement>('.screen-host, .result-screen').forEach((el) => {
      if (inert) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }

  closeTop(): boolean {
    const entry = this.stack[this.stack.length - 1];
    if (!entry || !entry.dismissible) return false;
    entry.close();
    return true;
  }

  closeAll(): void {
    for (let i = this.stack.length - 1; i >= 0; i--) this.stack[i].close();
  }

  /** Close every modal except the given panel, then move it to the top of the stack. */
  closeOthers(root: HTMLElement): void {
    const keep = this.stack.find((entry) => entry.backdrop === root);
    if (!keep) return;
    for (const entry of [...this.stack]) {
      if (entry !== keep) entry.close();
    }
    const index = this.stack.indexOf(keep);
    if (index >= 0) {
      this.stack.splice(index, 1);
      this.stack.push(keep);
      this.el.append(keep.backdrop);
    }
  }
}

// ---------------------------------------------------------------- toasts

export type ToastTone = 'info' | 'good' | 'bad' | 'warn';

export class ToastHost {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'toast-host', attrs: { 'aria-live': 'polite' } });
  }

  show(text: string, tone: ToastTone = 'info', ms = 2600): void {
    const node = h('div', {
      class: `toast toast-${tone}`,
      role: 'status',
      text,
    });
    this.el.append(node);
    while (this.el.childElementCount > 4) this.el.firstElementChild?.remove();
    requestAnimationFrame(() => node.classList.add('toast-in'));
    window.setTimeout(() => {
      node.classList.remove('toast-in');
      node.classList.add('toast-out');
      window.setTimeout(() => node.remove(), 220);
    }, ms);
  }
}