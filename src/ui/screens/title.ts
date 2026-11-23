import { Audio } from '../../audio/audio';
import { h, uiIcon } from '../dom';
import { GAME_DATA } from '../../data/index';
import { assetUrl, characterSprite } from '../format';
import type { ScreenHandle } from './types';

export interface TitleCallbacks {
  onSolo: () => void;
  onHotseat: () => void;
  onOnline: () => void;
  onResume: () => void;
  onHelp: () => void;
  onSettings: () => void;
  onCredits: () => void;
  hasResume: boolean;
}

export class TitleScreen implements ScreenHandle {
  readonly el: HTMLElement;
  private readonly cleanup: (() => void)[] = [];

  constructor(callbacks: TitleCallbacks) {
    this.el = h('div', { class: 'screen title-screen' });

    const keyart = h('img', {
      class: 'title-keyart',
      attrs: {
        src: assetUrl('assets/ui/keyart.webp'),
        alt: '',
        'aria-hidden': 'true',
        draggable: 'false',
      },
      on: {
        load: () => { logo.hidden = true; },
        error: () => { logo.hidden = false; },
      },
    });
    const shade = h('div', { class: 'title-shade', attrs: { 'aria-hidden': 'true' } });
    const clouds = h('div', { class: 'title-clouds', attrs: { 'aria-hidden': 'true' } });
    const parade = h('div', { class: 'title-parade', attrs: { 'aria-hidden': 'true' } });
    const paradeChars = [...GAME_DATA.characters].sort(() => Math.random() - 0.5).slice(0, 8);
    paradeChars.forEach((character, index) => {
      parade.append(
        h(
          'span',
          {
            class: 'parade-char',
            attrs: {
              style: `--dur:${18 + (index % 5) * 3.2}s;--delay:${-index * 2.4}s;--bottom:${2 + (index % 3) * 2}%;--size:${54 + (index % 3) * 14}px`,
            },
          },
          h('img', { attrs: { src: characterSprite(character), alt: '', draggable: 'false' } }),
        ),
      );
    });

    const mobileSky = h('div', { class: 'title-mobile-sky', attrs: { 'aria-hidden': 'true' } });
    const mobileLogo = h('img', {
      class: 'title-logo-mobile',
      attrs: { src: assetUrl('assets/ui/logo.webp'), alt: '', draggable: 'false' },
    });
    const logo = h(
      'div',
      { class: 'title-logo' },
      h(
        'div',
        { class: 'logo-top' },
        h('span', { class: 'logo-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }),
        h('span', { text: 'グローバル' }),
      ),
      h('h1', { class: 'logo-main', text: '寓話大富豪' }),
      h('div', { class: 'logo-sub' }, h('span', { text: '世界童話経済すごろく' })),
    );

    const primary = h(
      'div',
      { class: 'title-primary' },
      this.menuButton('coins', 'ひとりで', 'CPU 対戦で世界を買い占める', callbacks.onSolo, 'btn-gold title-btn-primary'),
      this.menuButton('chat', 'みんなで', '同じ端末で 2〜4 人のホットシート', callbacks.onHotseat),
      this.menuButton('globe', 'オンライン', 'ルームをつくる / あいことばで参加', callbacks.onOnline),
    );

    const secondary = h(
      'div',
      { class: 'title-secondary' },
      callbacks.hasResume
        ? this.smallButton('hourglass', 'つづきから', callbacks.onResume, 'title-btn-resume')
        : null,
      this.smallButton('help', '遊び方', callbacks.onHelp),
      this.smallButton('gear', '設定', callbacks.onSettings),
      this.smallButton('trophy', 'クレジット', callbacks.onCredits),
    );

    const footnote = h('p', {
      class: 'title-footnote',
      text: 'はじめてのタップで音声が有効になります ・ 世界は横につながっています',
    });

    const desktopLogo = h('img', {
      class: 'title-logo-desktop',
      attrs: { src: assetUrl('assets/ui/logo.webp'), alt: '', draggable: 'false' },
    });
    this.el.append(keyart, shade, clouds, parade, mobileSky, mobileLogo, desktopLogo, logo, primary, secondary, footnote);

    const startBgm = () => {
      Audio.bgm('title');
    };
    const onUnlocked = () => startBgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.cleanup.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked));
    startBgm();

    // Any tap on the artwork unlocks audio; the shared App unlock listener also fires.
    this.el.addEventListener(
      'pointerdown',
      () => {
        Audio.unlock();
        startBgm();
      },
      { once: true },
    );
  }

  private menuButton(
    icon: string,
    title: string,
    subtitle: string,
    onClick: () => void,
    className = '',
  ): HTMLButtonElement {
    return h(
      'button',
      {
        class: `title-menu-btn ${className}`.trim(),
        attrs: { type: 'button' },
        on: { click: onClick },
      },
      h('span', { class: 'title-menu-icon' }, uiIcon(icon, '▶')),
      h(
        'span',
        { class: 'title-menu-text' },
        h('span', { class: 'title-menu-title', text: title }),
        h('span', { class: 'title-menu-sub', text: subtitle }),
      ),
      h('span', { class: 'title-menu-arrow', text: '▶', attrs: { 'aria-hidden': 'true' } }),
    );
  }

  private smallButton(
    icon: string,
    label: string,
    onClick: () => void,
    className = '',
  ): HTMLButtonElement {
    return h(
      'button',
      {
        class: `title-small-btn ${className}`.trim(),
        attrs: { type: 'button' },
        on: { click: onClick },
      },
      uiIcon(icon, icon, 'title-small-icon'),
      h('span', { text: label }),
    );
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    Audio.bgm(null);
  }
}