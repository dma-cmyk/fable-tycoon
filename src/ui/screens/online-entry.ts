import { Audio } from '../../audio/audio';
import { h, iconButton } from '../dom';
import { readSavedName } from '../settings';
import type { ScreenHandle } from './types';

export interface OnlineEntryOptions {
  initialRoom?: string;
  onBack: () => void;
  onCreate: (name: string) => Promise<boolean>;
  onJoin: (roomId: string, name: string) => Promise<boolean>;
}

type Tab = 'create' | 'join';

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}(?:-[A-HJ-NP-Z2-9]{4})?$/;

function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 11);
}

export class OnlineEntryScreen implements ScreenHandle {
  readonly el: HTMLElement;
  private tab: Tab;
  private busy = false;
  private readonly nameInput: HTMLInputElement;
  private readonly roomInput: HTMLInputElement;
  private readonly feedback: HTMLElement;
  private readonly createPanel: HTMLElement;
  private readonly joinPanel: HTMLElement;
  private readonly tabs: HTMLButtonElement[] = [];

  constructor(private readonly options: OnlineEntryOptions) {
    this.tab = options.initialRoom ? 'join' : 'create';
    const savedName = readSavedName();

    this.nameInput = h('input', {
      class: 'input',
      attrs: {
        type: 'text',
        maxlength: '12',
        value: savedName,
        placeholder: 'プレイヤー名（12文字まで）',
        'aria-label': 'プレイヤー名',
        autocomplete: 'nickname',
      },
    });
    this.roomInput = h('input', {
      class: 'input input-code',
      attrs: {
        type: 'text',
        maxlength: '11',
        inputmode: 'text',
        autocapitalize: 'characters',
        spellcheck: 'false',
        placeholder: 'ABC123-K7Q9',
        'aria-label': 'あいことば（6文字）',
        autocomplete: 'off',
        value: options.initialRoom ?? '',
      },
      on: {
        input: () => {
          this.roomInput.value = normalizeCode(this.roomInput.value);
          this.updateJoinState();
        },
      },
    });

    this.feedback = h('p', { class: 'online-feedback', attrs: { role: 'status' } });

    const createButton = h(
      'button',
      {
        class: 'btn btn-gold online-main-btn',
        attrs: { type: 'button' },
        on: { click: () => void this.submitCreate() },
      },
      h('span', { text: '▶ ルームをつくる', attrs: { 'aria-hidden': 'true' } }),
    );
    const joinButton = h(
      'button',
      {
        class: 'btn btn-gold online-main-btn',
        attrs: { type: 'button' },
        on: { click: () => void this.submitJoin() },
      },
      h('span', { text: '▶ 参加する', attrs: { 'aria-hidden': 'true' } }),
    );
    this.joinButton = joinButton;

    this.createPanel = h(
      'section',
      { class: 'online-panel panel' },
      h('h2', { class: 'section-title', text: 'ルームをつくる' }),
      h('p', {
        class: 'online-copy',
        text: 'あいことば（6文字）が発行されます。招待URLを友だちに送って、同じ世界で遊ぼう。ホストが年数と制限時間を決めます。',
      }),
      createButton,
    );

    this.joinPanel = h(
      'section',
      { class: 'online-panel panel' },
      h('h2', { class: 'section-title', text: 'あいことばで参加' }),
      h('p', { class: 'online-copy', text: 'ルーム ID を入力してください。招待URLから来た場合は自動で入っています。' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'あいことば' }), this.roomInput),
      joinButton,
    );

    const tabBar = h('div', { class: 'online-tabs', attrs: { role: 'tablist', 'aria-label': 'オンラインの方法' } });
    for (const tab of ['create', 'join'] as const) {
      const btn = h('button', {
        class: 'online-tab',
        text: tab === 'create' ? '🏠 ルームをつくる' : '🔑 参加する',
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(this.tab === tab) },
        on: {
          click: () => {
            this.setTab(tab);
          },
        },
      });
      this.tabs.push(btn);
      tabBar.append(btn);
    }

    const nameField = h(
      'label',
      { class: 'field online-name-field' },
      h('span', { class: 'field-label', text: 'プレイヤー名' }),
      this.nameInput,
    );

    this.el = h(
      'div',
      { class: 'screen online-screen' },
      h(
        'header',
        { class: 'setup-header' },
        iconButton('‹', 'もどる', options.onBack),
        h(
          'div',
          { class: 'setup-title-wrap' },
          h('h1', { class: 'setup-title', text: 'オンライン対戦' }),
          h('p', { class: 'setup-subtitle', text: '最大 4 人。別々の端末で、同じニュースに振り回される。' }),
        ),
        h('span', { class: 'setup-header-mark', text: '🌐', attrs: { 'aria-hidden': 'true' } }),
      ),
      h(
        'div',
        { class: 'online-scroll scroll-y' },
        h(
          'div',
          { class: 'online-card panel' },
          h(
            'div',
            { class: 'online-card-head' },
            h('h2', { class: 'online-title', text: '世界はひとつ。ルームは6文字。' }),
            h('p', {
              class: 'online-subtitle',
              text: 'URL をひらくと参加画面に直行します。ルームが満員なら観戦モードになります。',
            }),
          ),
          nameField,
          tabBar,
          this.createPanel,
          this.joinPanel,
          this.feedback,
          h(
            'div',
            { class: 'online-help' },
            h('p', { text: '👑 ホストが開始するとゲームスタート。空き席には CPU を置けます。' }),
            h('p', { text: '🔄 切断しても、同じ端末なら自動で席に戻ります。' }),
            h('p', { text: '⏱️ 手番の制限時間を超えると CPU が代行します。' }),
          ),
        ),
      ),
    );

    this.setTab(this.tab);
    this.updateJoinState();
    const bgm = () => Audio.bgm('title');
    const onUnlocked = () => bgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.cleanup = () => {
      document.removeEventListener('fable:audio-unlocked', onUnlocked);
      Audio.bgm(null);
    };
    bgm();
  }

  private readonly cleanup: () => void;
  private joinButton!: HTMLButtonElement;

  destroy(): void {
    this.cleanup();
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    this.createPanel.hidden = tab !== 'create';
    this.joinPanel.hidden = tab !== 'join';
    this.tabs.forEach((btn, index) => {
      btn.setAttribute('aria-selected', String((index === 0 ? 'create' : 'join') === tab));
    });
    this.feedback.textContent = '';
    if (tab === 'join') requestAnimationFrame(() => this.roomInput.focus());
  }

  private updateJoinState(): void {
    if (this.joinButton) {
      this.joinButton.disabled = this.busy || !ROOM_CODE.test(this.roomInput.value);
    }
  }

  private playerName(): string {
    return this.nameInput.value.trim().slice(0, 12) || 'プレイヤー';
  }

  private setBusy(busy: boolean, message = ''): void {
    this.busy = busy;
    this.el.classList.toggle('is-busy', busy);
    this.feedback.textContent = message;
    this.feedback.classList.toggle('is-error', false);
    for (const tab of this.tabs) tab.disabled = busy;
    this.updateJoinState();
    const create = this.createPanel.querySelector('button');
    if (create instanceof HTMLButtonElement) create.disabled = busy;
    const join = this.joinPanel.querySelector('button');
    if (join instanceof HTMLButtonElement) join.disabled = busy || !ROOM_CODE.test(this.roomInput.value);
  }

  private async submitCreate(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true, 'ルームを作成しています…');
    const ok = await this.options.onCreate(this.playerName());
    this.setBusy(false);
    if (!ok) this.feedback.textContent = 'ルームを作成できませんでした。サーバーの状態を確認してください。';
  }

  private async submitJoin(): Promise<void> {
    if (this.busy) return;
    const roomId = normalizeCode(this.roomInput.value);
    if (!ROOM_CODE.test(roomId)) {
      this.feedback.textContent = 'あいことばは 6文字＋4文字のコードです（例: ABC123-K7Q9。I・L・O・0・1 は使いません）。';
      return;
    }
    this.setBusy(true, 'ルームを探しています…');
    const ok = await this.options.onJoin(roomId, this.playerName());
    this.setBusy(false);
    if (!ok) this.feedback.textContent = 'そのルームには入れませんでした。あいことばを確認するか、解散していないか見てください。';
  }
}