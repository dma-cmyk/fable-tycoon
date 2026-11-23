import { Audio } from '../../audio/audio';
import type { EmoteEvent, LobbyView, SeatInfo, ServerMsg } from '../../net/protocol';
import type { ConnectionState, Session } from '../../net/session-types';
import { avatar, clear, h, iconButton, type ModalHost, type ToastHost } from '../dom';
import { characterSprite, charsById, displayPlayerName, emotesById } from '../format';
import { readMute, uiSettings, writeMute, type MuteFlags } from '../settings';
import { ChatPanel, type ChatSeatInfo } from '../components/chatPanel';
import { EmotePalette } from '../components/emotePalette';
import { openCharacterPicker } from '../components/charPicker';
import { playEmoteVoice, resolveEmoteLines } from '../components/emotePlayback';
import { openPlayerMenu } from '../components/playerMenu';
import { perkInfo } from '../perks';
import type { ScreenHandle } from './types';

export interface TransportInfo {
  broker: string | null;
  p2pPeers: number;
  relayPeers: number;
}

export interface LobbyScreenOptions {
  session: Session;
  modal: ModalHost;
  toast: ToastHost;
  transportInfo?: () => TransportInfo | null;
  onLeave: () => void;
  onGameStart: () => void;
}

export class LobbyScreen implements ScreenHandle {
  readonly el: HTMLElement;
  private readonly cleanup: (() => void)[] = [];
  private readonly main: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly connBanner: HTMLElement;
  private readonly connText: HTMLElement;
  private readonly migrateBanner: HTMLElement;
  private readonly transportHost: HTMLElement;
  private readonly chat: ChatPanel;
  private readonly emotes: EmotePalette;
  private readonly muteCache = new Map<number, MuteFlags>();
  private lobby: LobbyView | null = null;
  private mySeat: number | null = null;
  private started = false;
  private readonly transportTimer: number;
  private migrationTimer = 0;

  constructor(private readonly options: LobbyScreenOptions) {
    const session = options.session;
    this.main = h('div', { class: 'lobby-main' });
    this.loading = h(
      'div',
      { class: 'lobby-loading' },
      h('div', { class: 'loading-spinner' }),
      h('p', { text: 'ルームに接続しています…' }),
    );
    this.connText = h('span', { class: 'conn-text', text: '' });
    this.connBanner = h(
      'div',
      { class: 'conn-banner', attrs: { hidden: 'hidden', role: 'status' } },
      h('span', { class: 'conn-spinner', attrs: { 'aria-hidden': 'true' } }),
      this.connText,
    );
    this.migrateBanner = h('div', {
      class: 'migrate-banner',
      attrs: { hidden: 'hidden', role: 'status' },
      text: 'ホストが切断…引き継ぎ中',
    });
    this.transportHost = h('div', { class: 'transport-chips' });

    this.chat = new ChatPanel({
      session,
      canChat: () => this.mySeat !== null,
      seatInfo: (seat) => this.seatInfo(seat),
      isMuted: (seat) => this.muteOf(seat).chat,
      showChat: () => uiSettings().showChat,
      onIncoming: (line) => {
        if (line.seat !== this.mySeat) Audio.sfx('chat');
        this.showSeatBubble(line.seat, line.text, 'chat');
      },
      class: 'lobby-chat-panel',
    });

    this.emotes = new EmotePalette({
      canSend: () => this.mySeat !== null && this.lobby?.status === 'lobby',
      ownSeats: () => (this.mySeat === null ? [] : [this.mySeat]),
      ownCharacterId: () => this.myCharacterId(),
      seatInfo: (seat) => this.seatInfo(seat),
      isMuted: (seat) => this.muteOf(seat).emote,
      playerCount: () => this.lobby?.seats.length ?? 4,
      onSend: (emoteId, target) => {
        session.send({ t: 'emote', emoteId, ...(target !== null ? { target } : {}) });
      },
    });

    const header = h(
      'header',
      { class: 'lobby-header' },
      iconButton('‹', 'もどる', () => options.onLeave()),
      h(
        'div',
        { class: 'lobby-title-wrap' },
        h('h1', { class: 'lobby-title', text: 'オンラインロビー' }),
        h('p', { class: 'lobby-subtitle', text: '同じ世界に集まった 4 席。ホストが開始します。' }),
      ),
      this.transportHost,
      h('span', { class: 'lobby-header-mark', text: '🌐', attrs: { 'aria-hidden': 'true' } }),
    );

    const commDock = h('div', { class: 'comm-dock' }, this.chat.fab, this.emotes.fab);
    this.el = h(
      'div',
      { class: 'screen lobby-screen' },
      header,
      this.connBanner,
      this.migrateBanner,
      h('div', { class: 'lobby-scroll scroll-y' }, this.main),
      this.loading,
      commDock,
      this.chat.panel,
      this.emotes.panel,
    );

    const unsubscribe = session.subscribe((msg) => this.onMessage(msg));
    this.cleanup.push(unsubscribe);
    const unConn = session.onConnection((state) => this.renderConnection(state));
    this.cleanup.push(unConn);
    this.renderConnection(session.connection());

    const bgm = () => Audio.bgm('lobby');
    const onUnlocked = () => bgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.cleanup.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked));
    bgm();

    this.renderTransport();
    this.transportTimer = window.setInterval(() => this.renderTransport(), 2000);
    this.cleanup.push(() => window.clearInterval(this.transportTimer));

    this.lobby = session.lobby();
    if (this.lobby) {
      this.loading.hidden = true;
      this.render();
      if (this.lobby.status !== 'lobby') this.startGame();
    }
  }

  destroy(): void {
    this.started = true;
    for (const fn of this.cleanup) fn();
    this.chat.destroy();
    this.emotes.destroy();
    window.clearTimeout(this.migrationTimer);
    Audio.stopVoice();
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.mySeat = msg.seat;
        this.lobby = msg.lobby;
        for (const line of msg.chat) this.chat.addLine(line);
        this.afterLobbyChange();
        break;
      case 'lobby':
        this.lobby = msg.lobby;
        this.afterLobbyChange();
        break;
      case 'snapshot':
        this.lobby = msg.lobby;
        this.loading.hidden = true;
        this.startGame();
        break;
      case 'update':
        this.startGame();
        break;
      case 'chat':
        this.chat.addLine(msg.line);
        break;
      case 'emote':
        this.playEmote(msg.emote);
        break;
      case 'system':
        this.chat.addSystem(msg.text);
        this.detectMigration(msg.text);
        break;
      case 'error':
        this.onError(msg.code, msg.message);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private afterLobbyChange(): void {
    this.loading.hidden = true;
    this.chat.refresh();
    if (this.lobby?.status !== 'lobby') {
      this.startGame();
      return;
    }
    this.render();
  }

  private startGame(): void {
    if (this.started) return;
    this.started = true;
    queueMicrotask(() => this.options.onGameStart());
  }

  private render(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const mySeat = this.mySeat;
    const isHost = mySeat !== null && !!lobby.seats[mySeat]?.isHost;
    const humans = lobby.seats.filter((seat) => seat.kind === 'human');
    const occupied = lobby.seats.filter((seat) => seat.kind !== 'open');
    const humansReady = humans.every((seat) => !!seat.characterId);
    const canStart = isHost && humans.length >= 1 && occupied.length >= 2 && humansReady;

    const inviteUrl = `${location.origin}${location.pathname}?room=${lobby.roomId}`;
    const roomCard = h(
      'section',
      { class: 'lobby-room panel' },
      h(
        'div',
        { class: 'lobby-room-left' },
        h('span', { class: 'lobby-room-label', text: 'あいことば' }),
        h('div', { class: 'lobby-room-code', text: lobby.roomId }),
        h('span', { class: 'muted', text: '6文字。招待URLをひらくと自動で入ります。' }),
      ),
      h(
        'div',
        { class: 'lobby-room-actions' },
        h('button', {
          class: 'btn btn-gold',
          text: '🔗 招待URLをコピー',
          attrs: { type: 'button' },
          on: { click: () => void copyText(inviteUrl, () => this.options.toast.show('招待URLをコピーしました', 'good')) },
        }),
        typeof navigator.share === 'function'
          ? h('button', {
              class: 'btn btn-ghost',
              text: '📤 共有',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  void navigator
                    .share({ title: 'グローバル寓話大富豪', text: '一緒に遊ぼう！', url: inviteUrl })
                    .catch(() => undefined);
                },
              },
            })
          : null,
      ),
    );

    const seatsPanel = h(
      'section',
      { class: 'lobby-seats-panel panel' },
      h(
        'div',
        { class: 'lobby-panel-head' },
        h('h2', { class: 'section-title', text: 'プレイヤー席' }),
        h('span', {
          class: 'badge',
          text: `${humans.length} 人 + CPU ${occupied.length - humans.length} / 全 ${occupied.length} 人`,
        }),
      ),
      h('div', { class: 'lobby-seats' }, ...lobby.seats.map((seat) => this.seatCard(seat, isHost))),
    );

    const settingsPanel = h(
      'section',
      { class: 'lobby-settings panel' },
      h(
        'div',
        { class: 'lobby-panel-head' },
        h('h2', { class: 'section-title', text: 'ゲーム設定' }),
        isHost ? h('span', { class: 'badge badge-gold', text: 'ホスト' }) : h('span', { class: 'muted', text: 'ホストが設定' }),
      ),
      h(
        'div',
        { class: 'lobby-setting-row' },
        h('span', { class: 'lobby-setting-label', text: '年数' }),
        segmented(
          [1, 3, 5, 10, 20].map((years) => ({
            label: `${years}年`,
            pressed: lobby.settings.years === years,
            disabled: !isHost,
            onClick: () => this.sendSettings({ years }),
          })),
        ),
      ),
      h(
        'div',
        { class: 'lobby-setting-row' },
        h('span', { class: 'lobby-setting-label', text: '手番の制限時間' }),
        segmented(
          [20, 30, 60, 0].map((seconds) => ({
            label: seconds === 0 ? '無制限' : `${seconds}秒`,
            pressed: lobby.settings.turnSeconds === seconds,
            disabled: !isHost,
            onClick: () => this.sendSettings({ turnSeconds: seconds }),
          })),
        ),
      ),
      h('p', {
        class: 'lobby-setting-note muted',
        text: '時間切れ・切断中は CPU が代行します。CPU の強さは席ごとにホストが設定できます。',
      }),
    );

    const startPanel = h(
      'section',
      { class: 'lobby-start panel' },
      h('h2', { class: 'section-title', text: isHost ? '開始' : '開始を待っています' }),
      isHost
        ? h(
            'div',
            { class: 'lobby-start-body' },
            h('p', {
              class: 'muted',
              text: !humansReady
                ? '人間のプレイヤーがキャラクターを選ぶまで開始できません。'
                : occupied.length < 2
                  ? 'あと 1 人（CPU でも可）必要です。'
                  : '全員の準備ができました。世界をはじめよう。',
            }),
            h(
              'button',
              {
                class: 'btn btn-gold lobby-start-btn',
                text: '▶ ゲームを開始',
                attrs: { type: 'button', disabled: !canStart },
                on: { click: () => this.options.session.send({ t: 'start' }) },
              },
            ),
          )
        : h(
            'div',
            { class: 'lobby-start-body' },
            h('p', { class: 'muted', text: 'ホストが開始するのを待っています…' }),
            h('div', { class: 'loading-spinner lobby-wait-spinner', attrs: { 'aria-hidden': 'true' } }),
          ),
      mySeat === null
        ? h('p', { class: 'lobby-spectator-note', text: '👀 観戦中です。空き席の「座る」で参加できます。' })
        : null,
      h('button', {
        class: 'btn btn-ghost lobby-leave',
        text: '退出する',
        attrs: { type: 'button' },
        on: { click: () => this.options.onLeave() },
      }),
    );

    clear(this.main);
    this.main.append(
      roomCard,
      h('div', { class: 'lobby-grid' }, seatsPanel, h('div', { class: 'lobby-side' }, settingsPanel, startPanel)),
    );
  }

  private seatCard(seat: SeatInfo, isHost: boolean): HTMLElement {
    const character = seat.characterId ? charsById.get(seat.characterId) : undefined;
    const self = seat.index === this.mySeat;
    const hostSeat = seat.kind === 'human' && seat.isHost;
    const actions = h('div', { class: 'lobby-seat-actions' });

    if (seat.kind === 'open') {
      if (this.mySeat === null) {
        actions.append(
          h('button', {
            class: 'btn btn-gold btn-small',
            text: '座る',
            attrs: { type: 'button' },
            on: {
              click: () => {
                this.mySeat = seat.index;
                this.chat.refresh();
                this.options.session.send({ t: 'take_seat', index: seat.index });
              },
            },
          }),
        );
      } else if (isHost) {
        for (const level of [1, 2, 3] as const) {
          actions.append(
            h('button', {
              class: 'btn btn-ghost btn-small',
              text: `CPU Lv${level}`,
              attrs: { type: 'button' },
              on: { click: () => this.options.session.send({ t: 'set_seat', index: seat.index, kind: 'cpu', cpuLevel: level }) },
            }),
          );
        }
      } else {
        actions.append(h('span', { class: 'muted', text: '空き席' }));
      }
    } else if (seat.kind === 'cpu') {
      if (isHost) {
        actions.append(
          h(
            'div',
            { class: 'lobby-cpu-levels' },
            ...[1, 2, 3].map((level) =>
              h('button', {
                class: 'chip chip-small',
                text: `Lv${level}`,
                attrs: { type: 'button', 'aria-pressed': String(seat.cpuLevel === level) },
                on: {
                  click: () =>
                    this.options.session.send({ t: 'set_seat', index: seat.index, kind: 'cpu', cpuLevel: level as 1 | 2 | 3 }),
                },
              }),
            ),
            h('button', {
              class: 'btn btn-ghost btn-small',
              text: '空きに戻す',
              attrs: { type: 'button' },
              on: { click: () => this.options.session.send({ t: 'set_seat', index: seat.index, kind: 'open' }) },
            }),
          ),
        );
      }
    } else if (self) {
      actions.append(
        h('button', {
          class: 'btn btn-gold btn-small',
          text: character ? 'キャラクターを変える' : 'キャラクターを選ぶ',
          attrs: { type: 'button' },
          on: { click: () => this.openPickerForSelf() },
        }),
      );
    } else if (seat.kind === 'human' && !seat.characterId) {
      actions.append(h('span', { class: 'badge badge-red', text: 'キャラ未選択' }));
    }

    if (seat.kind !== 'open') {
      actions.append(
        h('button', {
          class: 'lobby-seat-menu',
          text: '…',
          attrs: { type: 'button', 'aria-label': `${seat.name} のメニュー` },
          on: { click: () => this.openSeatMenu(seat) },
        }),
      );
    }

    return h(
      'article',
      {
        class: `lobby-seat lobby-seat-${seat.kind} ${self ? 'is-self' : ''} ${hostSeat ? 'is-host' : ''}`.trim(),
        dataset: { seat: String(seat.index) },
        attrs: { style: character ? `--char-color:${character.color}` : '' },
      },
      h(
        'header',
        { class: 'lobby-seat-head' },
        h('span', { class: 'lobby-seat-index', text: `${seat.index + 1}P` }),
        h(
          'span',
          { class: 'lobby-seat-tags' },
          self ? h('span', { class: 'badge badge-gold', text: 'あなた' }) : null,
          hostSeat ? h('span', { class: 'badge', text: '👑 ホスト' }) : null,
          seat.kind === 'cpu' ? h('span', { class: 'badge', text: `CPU Lv${seat.cpuLevel}` }) : null,
          seat.kind === 'open' ? h('span', { class: 'badge', text: '空き' }) : null,
          seat.autoplay ? h('span', { class: 'badge badge-red', text: 'CPU代行中' }) : null,
        ),
        seat.kind === 'human'
          ? h('span', {
              class: `conn-dot ${seat.connected ? 'is-online' : 'is-offline'}`,
              attrs: {
                title: seat.connected ? '接続中' : '切断中',
                'aria-label': seat.connected ? '接続中' : '切断中',
              },
            })
          : null,
      ),
      h(
        'div',
        { class: 'lobby-seat-body' },
        character
          ? avatar(characterSprite(character), character.color, 72, 'lobby-seat-avatar')
          : h('span', { class: 'lobby-seat-empty-avatar', text: seat.kind === 'open' ? '＋' : '？' }),
        h(
          'div',
          { class: 'lobby-seat-names' },
          h('strong', { class: 'lobby-seat-name', text: seat.kind === 'open' ? '空き席' : displayPlayerName({ name: seat.name, characterId: seat.characterId ?? undefined, isCpu: seat.kind === 'cpu' }) }),
          h('span', {
            class: 'lobby-seat-character muted',
            text: character
              ? `${character.nameJa} ・ ${character.origin}`
              : seat.kind === 'cpu'
                ? 'キャラクターはおまかせ'
                : 'キャラクター未選択',
          }),
          character ? h('span', { class: 'lobby-seat-perk', text: `${perkInfo(character.perk).icon} ${perkInfo(character.perk).label}` }) : null,
        ),
      ),
      actions,
      h('div', { class: 'lobby-seat-bubble-host' }),
    );
  }

  private openPickerForSelf(): void {
    const lobby = this.lobby;
    const seat = this.mySeat !== null ? lobby?.seats[this.mySeat] : undefined;
    if (!lobby || !seat) return;
    const exclude = new Set<string>();
    for (const other of lobby.seats) {
      if (other.index !== seat.index && other.characterId) exclude.add(other.characterId);
    }
    openCharacterPicker({
      modal: this.options.modal,
      title: 'あなたのキャラクター',
      subtitle: 'ほかの人と重複はできません',
      exclude,
      current: seat.characterId,
      onPick: (characterId) => this.options.session.send({ t: 'pick_character', characterId }),
    });
  }

  private openSeatMenu(seat: SeatInfo): void {
    openPlayerMenu({
      modal: this.options.modal,
      toasts: this.options.toast,
      session: this.options.session,
      seat: seat.index,
      name: displayPlayerName({ name: seat.name, characterId: seat.characterId ?? undefined, isCpu: seat.kind === 'cpu' }),
      characterId: seat.characterId,
      color: (seat.characterId ? charsById.get(seat.characterId)?.color : undefined) ?? '#9fb3d9',
      canReport: seat.kind === 'human' && seat.index !== this.mySeat,
      flags: { ...this.muteOf(seat.index) },
      onMute: (flags) => {
        this.muteCache.set(seat.index, flags);
        writeMute(this.options.session.roomId, seat.index, flags);
        this.chat.refresh();
      },
    });
  }

  private seatInfo(seat: number): ChatSeatInfo {
    const info = this.lobby?.seats[seat];
    const character = info?.characterId ? charsById.get(info.characterId) : undefined;
    return {
      name: info?.name ?? `席 ${seat + 1}`,
      characterId: info?.characterId ?? null,
      color: character?.color ?? '#9fb3d9',
    };
  }

  private myCharacterId(): string | null {
    if (this.mySeat === null) return null;
    return this.lobby?.seats[this.mySeat]?.characterId ?? null;
  }

  private muteOf(seat: number): MuteFlags {
    const cached = this.muteCache.get(seat);
    if (cached) return cached;
    const flags = readMute(this.options.session.roomId, seat);
    this.muteCache.set(seat, flags);
    return flags;
  }

  private sendSettings(settings: { years?: number; turnSeconds?: number }): void {
    this.options.session.send({ t: 'settings', settings });
  }

  private renderConnection(state: ConnectionState): void {
    if (state === 'open') {
      this.connBanner.hidden = true;
      return;
    }
    this.connBanner.hidden = false;
    this.connBanner.dataset.state = state;
    if (state === 'reconnecting') this.connText.textContent = '再接続しています…（席は保持されます）';
    else if (state === 'connecting') this.connText.textContent = 'ルームに接続しています…';
    else this.connText.textContent = '接続が切れました。タイトルへ戻って再接続してください。';
    this.loading.hidden = true;
  }

  private renderTransport(): void {
    const info = this.options.transportInfo?.();
    clear(this.transportHost);
    if (!info) return;
    this.transportHost.append(
      h('span', {
        class: `chip chip-small transport-chip ${info.p2pPeers > 0 ? 'is-good' : ''}`,
        attrs: { title: info.broker ? `シグナリング: ${info.broker}` : 'シグナリング未接続' },
        text: `⚡ P2P 直結 ${info.p2pPeers}`,
      }),
      h('span', {
        class: `chip chip-small transport-chip ${info.relayPeers > 0 ? 'is-relay' : ''}`,
        text: `🔁 中継 ${info.relayPeers}`,
      }),
    );
  }

  private detectMigration(text: string): void {
    if (!/ホスト/.test(text) || !/(切断|引き継ぎ|交代)/.test(text)) return;
    this.migrateBanner.textContent = text;
    this.migrateBanner.hidden = false;
    this.migrateBanner.classList.add('is-visible');
    window.clearTimeout(this.migrationTimer);
    this.migrationTimer = window.setTimeout(() => {
      this.migrateBanner.hidden = true;
      this.migrateBanner.classList.remove('is-visible');
    }, 6000);
  }

  private onError(code: string, message: string): void {
    if (code === 'rate_limited') {
      this.options.toast.show('少し待ってからもう一度送ってください', 'warn');
      return;
    }
    this.options.toast.show(message || `エラー: ${code}`, 'bad', 3600);
    const seat = this.mySeat !== null ? this.lobby?.seats[this.mySeat] : undefined;
    if (seat && seat.kind === 'open') {
      this.mySeat = null;
      this.chat.refresh();
      this.render();
    }
    if (code === 'no_room' || code === 'room_full') {
      window.setTimeout(() => {
        if (!this.started) this.options.onLeave();
      }, 1800);
    }
  }

  private playEmote(event: EmoteEvent): void {
    const def = emotesById.get(event.emoteId);
    const lobby = this.lobby;
    if (!def || !lobby) return;
    if (this.muteOf(event.seat).emote) return;
    const speaker = lobby.seats[event.seat];
    const speakerChar = speaker?.characterId ?? null;
    const victimChar = event.target !== null ? lobby.seats[event.target]?.characterId ?? null : null;
    const lines = resolveEmoteLines(def, speakerChar, victimChar);
    this.showSeatBubble(event.seat, lines.speaker, 'emote');
    const card = this.el.querySelector<HTMLElement>(`.lobby-seat[data-seat="${event.seat}"]`);
    if (card) {
      card.classList.add('is-emoting');
      window.setTimeout(() => card.classList.remove('is-emoting'), 1600);
    }
    Audio.sfx('emote_pop');
    void playEmoteVoice(lines, (characterId) => {
      if (characterId === speakerChar) return this.muteOf(event.seat).voice;
      if (event.target !== null && characterId === victimChar) return this.muteOf(event.target).voice;
      return false;
    });
    const targetSeat = event.target;
    if (targetSeat !== null && lines.hit) {
      const hitText = lines.hit;
      window.setTimeout(() => {
        this.showSeatBubble(targetSeat, hitText, 'emote hit');
        Audio.sfx('hit');
      }, 700);
    }
  }

  private showSeatBubble(seat: number, text: string, kind: string): void {
    const host = this.el.querySelector<HTMLElement>(`.lobby-seat[data-seat="${seat}"] .lobby-seat-bubble-host`);
    if (!host) return;
    const classes = kind
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `bubble-${part}`)
      .join(' ');
    host.replaceChildren(h('span', { class: `lobby-seat-bubble ${classes}`.trim(), text }));
    window.setTimeout(() => {
      if (host.firstElementChild?.textContent === text) host.replaceChildren();
    }, 4000);
  }
}

function segmented(
  options: { label: string; pressed: boolean; disabled: boolean; onClick: () => void }[],
): HTMLElement {
  const seg = h('div', { class: 'seg', attrs: { role: 'group' } });
  for (const option of options) {
    seg.append(
      h('button', {
        class: 'seg-btn',
        text: option.label,
        attrs: { type: 'button', 'aria-pressed': String(option.pressed), disabled: option.disabled },
        on: { click: option.onClick },
      }),
    );
  }
  return seg;
}

async function copyText(text: string, onCopied: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onCopied();
    return;
  } catch {
    /* fall through to prompt */
  }
  window.prompt('このURLをコピーしてください', text);
}