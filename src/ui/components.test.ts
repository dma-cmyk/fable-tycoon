import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicState } from '../core/engine';
import { createGame } from '../core/engine';
import type { GameEventDef } from '../core/types';
import { GAME_DATA } from '../data/index';
import type { ModalHandle, ModalHost } from './dom';
import { EventPanel } from './components/eventPanel';
import { MessageWindow } from './components/messageWindow';
import { openShopDialog } from './components/shopDialog';
import { ResultScreen } from './screens/result';

class FakeClassList {
  private readonly set = new Set<string>();
  constructor(private readonly owner: FakeElement) {}
  syncFrom(className: string): void {
    this.set.clear();
    for (const part of className.split(/\s+/).filter(Boolean)) this.set.add(part);
  }
  private flush(): void {
    this.owner._className = [...this.set].join(' ');
  }
  add(...tokens: string[]): void {
    for (const t of tokens) if (t) this.set.add(t);
    this.flush();
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
    this.flush();
  }
  toggle(token: string, force?: boolean): boolean {
    const next = force === undefined ? !this.set.has(token) : force;
    if (next) this.set.add(token);
    else this.set.delete(token);
    this.flush();
    return next;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
}

class FakeNode {
  parentElement: FakeElement | null = null;
  nodeValue = '';
  remove(): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super();
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = {
    setProperty(k: string, v: string) {
      (this as Record<string, unknown>)[k] = v;
    },
  };
  readonly classList: FakeClassList;
  _className = '';
  id = '';
  title = '';
  hidden = false;
  disabled = false;
  scrollTop = 0;
  scrollLeft = 0;
  clientWidth = 420;
  width = 300;
  height = 160;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList(this);
  }

  get className(): string {
    return this._className;
  }
  set className(value: string) {
    this._className = value;
    this.classList.syncFrom(value);
  }

  get textContent(): string {
    if (this.children.length === 0) return this.nodeValue;
    return this.children
      .map((c) => (c instanceof FakeElement ? c.textContent : c.nodeValue))
      .join('');
  }
  set textContent(value: string) {
    for (const c of this.children) c.parentElement = null;
    this.children.length = 0;
    this.nodeValue = value;
  }

  setAttribute(key: string, value: string): void {
    this.attrs.set(key, value);
    if (key === 'hidden') this.hidden = true;
    if (key === 'disabled') this.disabled = true;
  }
  getAttribute(key: string): string | null {
    return this.attrs.get(key) ?? null;
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const c of this.children) c.parentElement = null;
    this.children.length = 0;
    this.nodeValue = '';
    this.append(...nodes);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    if (this.disabled) return;
    const ev = {
      currentTarget: this,
      target: this,
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
    };
    for (const fn of this.listeners.get('click') ?? []) fn(ev);
  }

  closest(selector: string): FakeElement | null {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    let cur: FakeElement | null = this;
    while (cur) {
      if (cls && cur.classList.contains(cls)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (cls ? child.classList.contains(cls) : child.tagName.toLowerCase() === selector.toLowerCase()) {
          out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return { width: 560, height: 190, left: 0, top: 0, right: 560, bottom: 190 };
  }

  getContext() {
    return null;
  }
}

function installFakeDom() {
  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const body = new FakeElement('body');
  const fakeDoc = {
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
    querySelectorAll: () => [],
  };
  const fakeWin = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    innerWidth: 1280,
    devicePixelRatio: 1,
  };
  Object.assign(globalThis, {
    document: fakeDoc,
    window: fakeWin,
    Node: FakeNode,
    HTMLElement: FakeElement,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    },
  });
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Reflect.deleteProperty(globalThis, k);
      else Object.assign(globalThis, { [k]: v });
    }
  };
}

function fakeModalHost(): ModalHost {
  return {
    open(content: HTMLElement): ModalHandle {
      return {
        root: content,
        panel: content,
        body: content,
        close: () => undefined,
        setCloseEnabled: () => undefined,
      };
    },
  } as unknown as ModalHost;
}

describe('UI component regression tests', () => {
  let restoreDom: () => void;

  beforeEach(() => {
    restoreDom = installFakeDom();
  });

  afterEach(() => {
    restoreDom();
  });

  it('MessageWindow reports manual-advance waiting state and fires onStateChange (#1)', async () => {
    const changes = vi.fn();
    const win = new MessageWindow({ speed: () => 8, onStateChange: changes });
    const done = win.show({
      speaker: 'self',
      name: 'あなた',
      text: 'この街を買う。',
      speed: 8,
      autoAdvance: false,
    });
    expect(win.visible).toBe(true);
    expect(win.isManualWaiting).toBe(true);
    expect(win.el.classList.contains('is-manual-wait')).toBe(true);
    expect(changes).toHaveBeenCalled();

    win.advance();
    await done;
    expect(win.visible).toBe(false);
    expect(win.isManualWaiting).toBe(false);
    win.destroy();
  });

  it('ShopDialog preserves scroll position and updates remaining card count in heading and speech (#8, #9)', () => {
    const created = createGame(GAME_DATA, {
      years: 1,
      seed: 7,
      players: [
        { name: 'あなた', characterId: 'momotaro', isCpu: false },
        { name: 'CPU', characterId: 'red_hood', isCpu: true, cpuLevel: 1 },
      ],
    });
    const state = {
      ...created.state,
      phase: { t: 'shop', stock: ['express2', 'express3', 'pegasus', 'carpet', 'tariff'] },
    } as unknown as PublicState;
    let rootBody!: FakeElement;
    const modal = {
      open(content: HTMLElement): ModalHandle {
        rootBody = content as unknown as FakeElement;
        return {
          root: content,
          panel: content,
          body: content,
          close: () => undefined,
          setCloseEnabled: () => undefined,
        };
      },
    } as unknown as ModalHost;

    const handle = openShopDialog({
      modal,
      state,
      canAct: true,
      onBuy: () => undefined,
      onSell: () => undefined,
      onEnd: () => undefined,
    });

    const scrollEl = rootBody.querySelector('.shop-scroll')!;
    expect(rootBody.querySelector('.shop-section-title')?.textContent).toContain('残り 5枚');
    expect(rootBody.querySelector('.shop-speech')?.textContent).toContain('残り5枚');
    expect(rootBody.querySelector('.shop-leave')?.classList.contains('btn-ghost')).toBe(true);

    // Simulate user scrolling down and buying two cards.
    scrollEl.scrollTop = 306;
    const afterBuy = {
      ...state,
      phase: { t: 'shop', stock: ['pegasus', 'carpet', 'tariff'] },
    } as unknown as PublicState;
    handle.update(afterBuy, true);

    expect(rootBody.querySelector('.shop-scroll')).toBe(scrollEl);
    expect(scrollEl.scrollTop).toBe(306);
    expect(rootBody.querySelector('.shop-section-title')?.textContent).toContain('残り 3枚');
    expect(rootBody.querySelector('.shop-speech')?.textContent).toContain('残り3枚');

    // Empty shelf updates both heading and shopkeeper speech.
    const emptyState = { ...state, phase: { t: 'shop', stock: [] } } as unknown as PublicState;
    handle.update(emptyState, true);
    expect(rootBody.querySelector('.shop-section-title')?.textContent).toContain('残り 0枚');
    expect(rootBody.querySelector('.shop-speech')?.textContent).toContain('売り切れ');
    handle.close();
  });

  it('EventPanel disables choices with clear wait message during intro fx and unlocks immediately on skip', () => {
    const onChoose = vi.fn();
    const onSkipFx = vi.fn();
    const panel = new EventPanel({ onChoose, onSkipFx });
    const eventDef = GAME_DATA.events.find((e) => (e.choices?.length ?? 0) >= 2) as GameEventDef;
    const created = createGame(GAME_DATA, {
      years: 1,
      seed: 12,
      players: [
        { name: 'あなた', characterId: 'momotaro', isCpu: false },
        { name: 'CPU', characterId: 'aladdin', isCpu: true, cpuLevel: 1 },
      ],
    });
    const eventState = {
      ...created.state,
      phase: { t: 'event', eventId: eventDef.id },
      activeEventId: eventDef.id,
    } as unknown as PublicState;

    panel.show(eventDef, eventState, 'あなた');
    panel.setState(eventState, false, { fxPlaying: true, isMine: true });

    const root = panel.el as unknown as FakeElement;
    const choiceArea = root.querySelector('.event-choice-area')!;
    const choices = root.querySelectorAll('.event-choice');
    const note = root.querySelector('.event-choices-note')!;
    const skipBtn = root.querySelector('.event-skip-btn')!;

    expect(choiceArea.classList.contains('is-fx-waiting')).toBe(true);
    expect(choices.length).toBeGreaterThanOrEqual(2);
    expect(choices.every((btn) => btn.disabled)).toBe(true);
    expect(note.textContent).toContain('演出のあとで選べます');
    expect(skipBtn.hidden).toBe(false);

    skipBtn.click();
    expect(onSkipFx).toHaveBeenCalledTimes(1);

    // Once fx ends, choices unlock immediately and the waiting banner hides.
    panel.setState(eventState, true, { fxPlaying: false, isMine: true });
    const unlockedChoices = root.querySelectorAll('.event-choice');
    expect(choiceArea.classList.contains('is-fx-waiting')).toBe(false);
    expect(unlockedChoices.every((btn) => !btn.disabled)).toBe(true);
    expect(root.querySelector('.event-choices-banner')?.hidden).toBe(true);

    unlockedChoices[0].click();
    expect(onChoose).toHaveBeenCalledWith(0);
  });

  it('ResultScreen displays aligned turn count (#6) and invokes onTitle / onRematch callbacks', () => {
    const created = createGame(GAME_DATA, {
      years: 1,
      seed: 5,
      players: [
        { name: 'あなた', characterId: 'momotaro', isCpu: false },
        { name: 'CPU', characterId: 'red_hood', isCpu: true, cpuLevel: 1 },
      ],
    });
    const finalState = {
      ...created.state,
      round: 12,
      phase: { t: 'game_over', ranking: [0, 1] },
    } as unknown as PublicState;
    const onTitle = vi.fn();
    const onRematch = vi.fn();
    const screen = new ResultScreen({
      state: finalState,
      mode: 'local',
      isVoiceMuted: () => true,
      skipEndingVoice: true,
      onTitle,
      onRematch,
    });

    const root = screen.el as unknown as FakeElement;
    expect(root.querySelector('.result-badge-line')?.textContent).toContain('全 12 ターン');
    const buttons = root.querySelectorAll('.result-btn');
    const rematchBtn = buttons.find((b) => b.textContent.includes('もう一度'));
    const titleBtn = buttons.find((b) => b.textContent.includes('タイトルへ'));
    expect(rematchBtn).toBeDefined();
    expect(titleBtn).toBeDefined();

    rematchBtn?.click();
    titleBtn?.click();
    expect(onRematch).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledTimes(1);
    screen.destroy();
    void fakeModalHost;
  });
});
