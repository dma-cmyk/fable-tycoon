import { Audio, bgmForEvent, voiceKeyOf, type BgmName } from '../../audio/audio';
import { destination as destinationNarration } from '../../audio/narration';
import {  actorOf, annualIncome, distance, netWorth, type PublicState } from '../../core/engine';
import { REALMS } from '../../core/realm';
import { wrapDx } from '../../core/geo';
import { purchasePrice } from '../../core/economy';
import type {Action, Fx, MoveOption, RealmId, SpeakerRef} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import type { EmoteEvent, LobbyView, ServerMsg } from '../../net/protocol';
import { FX_MS, type ConnectionState, type Session } from '../../net/session-types';
import { MapView } from '../../render/map';
import { loadMapAssets, type AssetProgress } from '../../render/assets';
import {
  assetUrl,
  characterSprite,
  charsById,
  displayPlayerName,
  citiesById,
  cityNodeId,
  countryFlag,
  emotesById,
  eventsById,
  formatDelta,
  formatOku,
  formatOkuShort,
  formatTurnLabel,
  nodesById,
  nodeLabel,
  playerColor,
  realmLabel,
  realmOfNode,
  transportSummary,
  REALM_ICON,
  seatColor,
  speakerName,
} from '../format';
import { avatar, h, iconButton, uiIcon, type ModalHandle } from '../dom';
import { effectiveUiSettings, uiSettings, readMute, writeMute, type MuteFlags } from '../settings';
import { ChatPanel } from '../components/chatPanel';
import { EmotePalette } from '../components/emotePalette';
import { DiceOverlay } from '../components/diceOverlay';
import { TurnTimer } from '../components/turnTimer';
import { EventPanel } from '../components/eventPanel';
import { CitySheetHandle, openCitySheet } from '../components/citySheet';
import { openCardsDialog } from '../components/cardsDialog';
import { openOwnedDialog } from '../components/ownedDialog';
import { openPropertyCatalog } from '../components/propertyCatalog';
import { openInfoDialog, type NewsLogEntry } from '../components/infoDialog';
import { openYearEndDialog, type YearEndHandle } from '../components/yearEndDialog';
import { openShopDialog, type ShopHandle } from '../components/shopDialog';
import { JOY_SPRITE_IDS, LANDMARK_FILES, SAD_SPRITE_IDS } from '../assetManifest';
import { animateCounter, confettiBurst, motionReduced, watchMotionPreference } from '../motion';
import { extraMapView, type MapViewId } from '../mapMotion';
import { myPlayerIds, playerToSeat, seatToPlayer } from '../session-map';
import { cardDepartureText, cardVehicle, vehicleBadge, vehicleForDice } from '../vehicles';
import {
  openCardTargetDialog,
  openDiscardDialog,
  openSellDialog,
} from '../components/phaseDialogs';
import { openPlayerMenu, openPlayerRoster, type PlayerView } from '../components/playerMenu';
import { playEmoteVoice, resolveEmoteLines } from '../components/emotePlayback';
import { ResultScreen } from './result';
import { FxPlayer, type PlaybackControl } from '../fxPlayer';
import type { App } from '../app';
import type { ScreenHandle } from './types';

export interface GameScreenOptions {
  app: App;
  session: Session;
}

type TransientKind = 'target' | 'discard' | 'sell';

interface TransientModal {
  kind: TransientKind;
  cardId: string | null;
  handle: ModalHandle;
}

const ERROR_JA: Record<string, string> = {
  bad_version: 'ゲームのバージョンが一致しません。再読み込みしてください。',
  no_room: 'ルームが見つかりません。',
  room_full: 'ルームが満員です。',
  not_host: 'ホストだけが操作できます。',
  not_your_turn: 'いまはあなたの番ではありません。',
  stale: '画面が古くなっていました。同期します…',
  illegal: 'その操作はできません。',
  bad_request: '送信内容に問題がありました。',
  rate_limited: '少し待ってからもう一度送ってください。',
  already_started: 'すでにゲームが始まっています。',
  character_taken: 'そのキャラクターは選ばれています。',
};

export class GameScreen implements ScreenHandle {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly session: Session;
  private readonly canvas: HTMLCanvasElement;
  private map: MapView | null = null;
  private state: PublicState | null = null;
  private seq = 0;
  private latestSeq = -1;
  private appliedSeq = -1;
  private deadline: number | null = null;
  private lobby: LobbyView | null = null;
  private mySeat: number | null = null;
  private actionPending = false;
  private pendingTimer = 0;
  private destroyed = false;
  private sessionBound = false;
  private initialFocused = false;
  private fxBusy = false;
  private lastHumanTurn: number | null = null;
  private readonly unsubscribeFns: (() => void)[] = [];
  private readonly muteCache = new Map<number, MuteFlags>();
  private flaggedSeats = new Set<number>();
  private readonly fxPlayer: FxPlayer;
  private readonly dice: DiceOverlay;
  private readonly timer: TurnTimer;
  private readonly chat: ChatPanel;
  private readonly emotes: EmotePalette;
  private readonly eventPanel: EventPanel;
  private readonly logs: string[] = [];
  private readonly newsLog: NewsLogEntry[] = [];
  private readonly rankBubbles = new Map<number, { text: string; expires: number }>();
  private citySheet: CitySheetHandle | null = null;
  private citySheetCityId: string | null = null;
  private citySheetBuyMode = false;
  private transient: TransientModal | null = null;
  private yearEnd: YearEndHandle | null = null;
  private shop: ShopHandle | null = null;
  private bulkBuyCityId: string | null = null;
  private cityPick: { cardId: string; options: Set<string> } | null = null;
  private viewRealm: MapViewId = 'world';
  private manualView = false;
  private playerRealm: RealmId | 'world' = 'world';
  private lastMonthShown: number | null = null;
  private readonly lastValues = new Map<string, number>();
  private portraitBaseSrc = '';
  private portraitVariantTimer = 0;
  private turnBannerTimer = 0;
  private monthFlipTimer = 0;
  private stepsTimer = 0;
  private rouletteFinish: ((skipped: boolean) => void) | null = null;
  private rouletteTimer = 0;
  private rouletteInterval = 0;
  private resultScreen: ResultScreen | null = null;
  private activeEventBgm: BgmName | null = null;
  private currentBgm: BgmName | null = null;
  private sayTimer = 0;
  private bannerTimer = 0;
  private handoffTimer = 0;
  private emoteQueue: EmoteEvent[] = [];
  private emotePlaying = false;
  private endedVoicePlayed = false;

  private readonly yearChip: HTMLElement;
  private readonly turnChip: HTMLElement;
  private readonly destChip: HTMLButtonElement;
  private readonly destText: HTMLElement;
  private readonly destDistance: HTMLElement;
  private readonly rankingHost: HTMLElement;
  private readonly portraitHost: HTMLElement;
  private readonly portraitImage: HTMLImageElement;
  private readonly portraitName: HTMLElement;
  private readonly portraitSub: HTMLElement;
  private readonly sayBubble: HTMLElement;
  private readonly sayBubbleName: HTMLElement;
  private readonly sayBubbleText: HTMLElement;
  private readonly subtitleBar: HTMLElement;
  private readonly subtitleName: HTMLElement;
  private readonly subtitleText: HTMLElement;
  private readonly moneyHost: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly primaryIcon: HTMLElement;
  private readonly primaryLabel: HTMLElement;
  private readonly moveOptionsHost: HTMLElement;
  private readonly cardBadge: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly miniMapCanvas: HTMLCanvasElement;
  private readonly recenterButton: HTMLButtonElement;
  private moveSelection: string | null = null;
  private moveOptionsKey = '';
  private moveOptionsCache: MoveOption[] = [];
  private readonly loading: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly loadingFill: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly loadingHome: HTMLButtonElement;
  private readonly connBanner: HTMLElement;
  private readonly connText: HTMLElement;
  private readonly connAction: HTMLButtonElement;
  private readonly gameBanner: HTMLElement;
  private readonly handoff: HTMLElement;
  private readonly handoffName: HTMLElement;
  private readonly handoffAvatar: HTMLElement;
  private readonly skipHint: HTMLElement;
  private readonly commDock: HTMLElement;
  private readonly hudIcons: HTMLElement;
  private readonly timerHost: HTMLElement;
  private readonly bottomBar: HTMLElement;
  private readonly topbar: HTMLElement;
  private readonly mapWrap: HTMLElement;
  private readonly emoteHost: HTMLElement;
  private readonly playerPlate: HTMLButtonElement;
  private readonly playerPlateAvatar: HTMLElement;
  private readonly playerPlateName: HTMLElement;
  private readonly playerPlateSub: HTMLElement;
  private readonly playerPlateCash: HTMLElement;
  private readonly realmChip: HTMLButtonElement;
  private readonly turnBanner: HTMLElement;
  private readonly turnBannerAvatar: HTMLElement;
  private readonly turnBannerName: HTMLElement;
  private readonly turnBannerSub: HTMLElement;
  private readonly monthFlip: HTMLElement;
  private readonly monthFlipIcon: HTMLElement;
  private readonly monthFlipValue: HTMLElement;
  private readonly rouletteOverlay: HTMLElement;
  private readonly rouletteImage: HTMLImageElement;
  private readonly rouletteBadge: HTMLElement;
  private readonly rouletteName: HTMLElement;
  private readonly rouletteCountry: HTMLElement;
  private readonly rouletteLandmark: HTMLImageElement;
  private readonly stepsCounter: HTMLElement;
  private readonly destArrow: HTMLElement;
  private readonly confettiHost: HTMLElement;
  private readonly cityPickBanner: HTMLElement;
  private readonly cityPickText: HTMLElement;
  private readonly portraitRank: HTMLElement;

  constructor(options: GameScreenOptions) {
    this.app = options.app;
    this.session = options.session;

    this.canvas = h('canvas', { class: 'map-canvas', attrs: { 'aria-label': '世界地図' } });
    this.mapWrap = h('div', { class: 'map-wrap' }, this.canvas);
    this.yearChip = h('span', { class: 'chip chip-gold game-year-chip', text: '1年目 4月' });
    this.turnChip = h('span', { class: 'chip chip-dark game-turn-chip', text: 'ターン 1 / 36' });
    this.destText = h('span', { class: 'dest-name', text: '目的地' });
    this.destDistance = h(
      'span',
      { class: 'dest-distance' },
      h('span', { class: 'dest-distance-label', text: '・あと' }),
      h('span', { class: 'dest-distance-value', text: '—' }),
      h('span', { class: 'dest-distance-unit', text: 'マス' }),
    );
    this.destChip = h(
      'button',
      {
        class: 'chip chip-blue dest-chip',
        attrs: { type: 'button', 'aria-label': '目的地をマップで表示' },
        on: { click: () => this.focusDestination() },
      },
      h('span', { class: 'dest-icon', text: '🎯', attrs: { 'aria-hidden': 'true' } }),
      this.destText,
      this.destDistance,
    );
    this.statusChip = h('span', { class: 'chip chip-small status-chip game-turn-label', text: '' });

    this.timer = new TurnTimer();
    this.timerHost = this.timer.el;

    this.playerPlateAvatar = h('span', { class: 'player-plate-avatar' });
    this.playerPlateName = h('span', { class: 'player-plate-name', text: '' });
    this.playerPlateSub = h('span', { class: 'player-plate-sub', text: '所持金' });
    this.playerPlateCash = h('strong', { class: 'player-plate-cash', text: '—' });
    this.playerPlate = h(
      'button',
      {
        class: 'player-plate',
        attrs: { type: 'button', 'aria-label': '手番プレイヤーの詳細' },
        on: { click: () => this.openRoster() },
      },
      this.playerPlateAvatar,
      h('span', { class: 'player-plate-text' }, this.playerPlateName, this.playerPlateSub),
      this.playerPlateCash,
    );
    this.realmChip = h(
      'button',
      { class: 'chip realm-chip', attrs: { type: 'button', hidden: 'hidden' }, on: { click: () => this.openMapViewDialog() } },
    );

    this.turnBannerAvatar = h('span', { class: 'turn-banner-avatar' });
    this.turnBannerName = h('span', { class: 'turn-banner-name', text: '' });
    this.turnBannerSub = h('span', { class: 'turn-banner-sub', text: 'のターン！' });
    this.turnBanner = h(
      'div',
      { class: 'turn-banner', attrs: { hidden: 'hidden', 'aria-live': 'polite' } },
      this.turnBannerAvatar,
      h('div', { class: 'turn-banner-text' }, this.turnBannerName, this.turnBannerSub),
    );
    this.monthFlipIcon = h('span', { class: 'month-flip-icon', text: '📅' });
    this.monthFlipValue = h('span', { class: 'month-flip-value', text: '' });
    this.monthFlip = h(
      'div',
      { class: 'month-flip', attrs: { hidden: 'hidden', 'aria-hidden': 'true' } },
      h('div', { class: 'month-flip-card' }, this.monthFlipIcon, this.monthFlipValue),
    );
    this.rouletteImage = h('img', {
      class: 'roulette-thumb',
      attrs: { alt: '', draggable: 'false', hidden: 'hidden' },
    });
    this.rouletteBadge = h('span', { class: 'roulette-city-badge', text: '🏙️', attrs: { 'aria-hidden': 'true' } });
    this.rouletteName = h('span', { class: 'roulette-name', text: '' });
    this.rouletteCountry = h('span', { class: 'roulette-country', text: '' });
    this.rouletteLandmark = h('img', { class: 'roulette-landmark', attrs: { alt: '', draggable: 'false' } });
    this.rouletteOverlay = h(
      'div',
      { class: 'roulette-overlay', attrs: { hidden: 'hidden', 'aria-live': 'polite' } },
      h(
        'div',
        { class: 'roulette-panel' },
        h('span', { class: 'roulette-kicker', text: '🎯 目的地ルーレット' }),
        h('div', { class: 'roulette-reel' }, this.rouletteBadge, this.rouletteImage, h('span', { class: 'roulette-names' }, this.rouletteName, this.rouletteCountry)),
        this.rouletteLandmark,
        h('span', { class: 'roulette-hint', text: '目的地が決まる…' }),
      ),
    );
    this.stepsCounter = h('div', { class: 'steps-counter', attrs: { hidden: 'hidden' } });
    this.confettiHost = h('div', { class: 'confetti-host', attrs: { 'aria-hidden': 'true' } });
    this.cityPickText = h('span', { class: 'city-pick-text', text: '地図の都市をタップして対象を選ぶ' });
    this.cityPickBanner = h(
      'div',
      { class: 'city-pick-banner', attrs: { hidden: 'hidden', role: 'status' } },
      this.cityPickText,
      h('button', {
        class: 'btn btn-ghost btn-small',
        text: 'やめる',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.clearCityPick();
            this.sendAction({ t: 'cancel' });
          },
        },
      }),
    );
    this.destArrow = h(
      'div',
      { class: 'dest-arrow', attrs: { hidden: 'hidden', 'aria-hidden': 'true' } },
      h('span', { class: 'dest-arrow-icon', text: '➤' }),
      h('span', { class: 'dest-arrow-label', text: '目的地' }),
    );

    this.miniMapCanvas = h('canvas', {
      class: 'game-minimap',
      attrs: { 'aria-label': 'ミニマップ。タップで now その地点へ移動' },
    });
    this.recenterButton = h(
      'button',
      {
        class: 'btn btn-ghost map-recenter',
        attrs: { type: 'button', hidden: 'hidden' },
        on: { click: () => this.recenterOnActor() },
      },
      uiIcon('flag', '🎯', 'map-recenter-icon'),
      h('span', { text: '手番へ戻る' }),
    );

    this.topbar = h(
      'header',
      { class: 'game-topbar' },
      this.playerPlate,
      h(
        'div',
        { class: 'logo-mini', attrs: { 'aria-hidden': 'true' } },
        h('span', { class: 'logo-mini-crown', text: '👑' }),
        h('span', { class: 'logo-mini-text', text: '寓話大富豪' }),
      ),
      h('div', { class: 'game-chips' }, this.yearChip, this.statusChip, this.destChip, this.stepsCounter, this.turnChip, this.realmChip),
      this.timerHost,
      h(
        'div',
        { class: 'top-actions' },
        iconButton('menu', 'メニュー', () => this.openMenu(), { class: 'top-action' }),
        iconButton('gear', '設定', () => this.app.openSettings(), { class: 'top-action' }),
        iconButton('help', 'ヘルプ', () => this.app.openHelp(), { class: 'top-action' }),
      ),
    );

    this.rankingHost = h('div', { class: 'ranking-panel', attrs: { 'aria-label': '順位' } });

    this.portraitImage = h('img', {
      class: 'portrait-image',
      attrs: { alt: '', draggable: 'false' },
      on: {
        error: () => {
          this.portraitImage.style.visibility = 'hidden';
        },
        load: () => {
          this.portraitImage.style.visibility = 'visible';
        },
      },
    });
    this.portraitRank = h('span', { class: 'portrait-rank', text: '' });
    this.portraitName = h('span', { class: 'portrait-name', text: '' });
    this.portraitSub = h('span', { class: 'portrait-sub', text: '' });
    this.sayBubbleName = h('span', { class: 'say-bubble-name', text: '' });
    this.sayBubbleText = h('span', { class: 'say-bubble-text', text: '' });
    this.sayBubble = h(
      'div',
      { class: 'say-bubble', attrs: { hidden: 'hidden' } },
      this.sayBubbleName,
      this.sayBubbleText,
    );
    this.portraitHost = h(
      'div',
      { class: 'portrait-area', attrs: { 'aria-hidden': 'true' } },
      this.portraitImage,
      this.portraitRank,
      h('div', { class: 'portrait-caption' }, this.portraitName, this.portraitSub),
      this.sayBubble,
    );
    this.subtitleName = h('span', { class: 'subtitle-name', text: '' });
    this.subtitleText = h('span', { class: 'subtitle-text', text: '' });
    this.subtitleBar = h(
      'div',
      { class: 'subtitle-bar', attrs: { hidden: 'hidden', role: 'status' } },
      this.subtitleName,
      this.subtitleText,
    );

    this.primaryIcon = h('span', { class: 'primary-icon', text: '▶', attrs: { 'aria-hidden': 'true' } });
    this.primaryLabel = h('span', { class: 'primary-label', text: 'サイコロをふる' });
    this.primary = h(
      'button',
      {
        class: 'btn btn-gold dice-primary',
        attrs: { type: 'button' },
        on: { click: () => this.onPrimary() },
      },
      this.primaryIcon,
      this.primaryLabel,
    );
    this.cardBadge = h('span', { class: 'icon-btn-badge', text: '0', attrs: { hidden: 'hidden' } });
    const cardButton = iconButton('cards', 'カード', () => this.openHand(), { class: 'hud-icon' });
    cardButton.append(this.cardBadge);
    this.commDock = h('div', { class: 'hud-comm' });
    const iconRow = h(
      'div',
      { class: 'hud-icons' },
      cardButton,
      iconButton('property', '物件', () => this.openCatalog(), { class: 'hud-icon' }),
      iconButton('flag', '目的地', () => this.openDestination(), { class: 'hud-icon' }),
      iconButton('globe', '地図', () => this.openMapViewDialog(), { class: 'hud-icon' }),
      iconButton('menu', 'その他', () => this.openOtherMenu(), { class: 'hud-icon' }),
      this.commDock,
    );
    this.hudIcons = iconRow;
    this.moveOptionsHost = h('div', { class: 'move-options', attrs: { hidden: 'hidden' } });
    this.bottomBar = h('div', { class: 'game-bottom-bar' }, this.moveOptionsHost, h('div', { class: 'bottom-primary-row' }, this.primary, iconRow));
    this.moneyHost = h('div', { class: 'money-panel' });

    this.chat = new ChatPanel({
      session: this.session,
      canChat: () => this.session.mySeats().length > 0,
      seatInfo: (seat) => this.chatSeatInfo(seat),
      isMuted: (seat) => this.muteOf(seat).chat,
      showChat: () => uiSettings().showChat,
      onIncoming: (line) => {
        const playerId = this.playerIdOfSeat(line.seat);
        if (playerId === null) return;
        if (!this.session.mySeats().includes(line.seat)) Audio.sfx('chat');
        this.showRankBubble(playerId, line.text);
        this.map?.bubble(playerId, line.text, 4200);
        this.addLog(`💬 ${this.playerName(playerId)}: ${line.text}`);
      },
      class: 'game-chat-panel',
    });

    this.emotes = new EmotePalette({
      canSend: () => this.emotePlayer() !== null && !this.destroyed,
      ownSeats: () => {
        const playerId = this.emotePlayer();
        return playerId === null ? [] : [playerId];
      },
      ownCharacterId: () => {
        const playerId = this.emotePlayer();
        return playerId !== null ? this.state?.players[playerId]?.characterId ?? null : null;
      },
      seatInfo: (playerId) => this.playerInfo(playerId),
      isMuted: (playerId) => {
        const seat = this.seatOfPlayer(playerId);
        return seat !== null && this.muteOf(seat).emote;
      },
      playerCount: () => this.state?.players.length ?? 4,
      onSend: (emoteId, targetPlayerId) => {
        const targetSeat = targetPlayerId !== null ? this.seatOfPlayer(targetPlayerId) : null;
        this.session.send({ t: 'emote', emoteId, ...(targetSeat !== null ? { target: targetSeat } : {}) });
      },
    });

    this.eventPanel = new EventPanel({
      onChoose: (index) => {
        if (!this.state || this.state.phase.t !== 'event' || !this.interactiveNow()) return;
        this.eventPanel.markChosen();
        this.sendAction({ t: 'choose', index });
      },
    });

    this.dice = new DiceOverlay();
    this.emoteHost = h('div', { class: 'game-emote-bubble-host' });

    this.loadingText = h('p', { class: 'loading-text', text: '世界地図をひらいています…' });
    this.loadingFill = h('span');
    this.loadingBar = h('div', { class: 'progress game-loading-bar' }, this.loadingFill);
    this.retryButton = h('button', {
      class: 'btn btn-gold',
      text: 'もう一度読み込む',
      attrs: { type: 'button', hidden: 'hidden' },
      on: { click: () => void this.initMap() },
    });
    this.loadingHome = h('button', {
      class: 'btn btn-ghost',
      text: 'タイトルへ',
      attrs: { type: 'button' },
      on: { click: () => this.app.goTitle() },
    });
    this.loading = h(
      'div',
      { class: 'game-loading' },
      h('div', { class: 'loading-spinner' }),
      this.loadingText,
      this.loadingBar,
      h('div', { class: 'game-loading-actions' }, this.retryButton, this.loadingHome),
    );

    this.connText = h('span', { class: 'conn-text', text: '' });
    this.connAction = h('button', {
      class: 'conn-action',
      text: '再読み込み',
      attrs: { type: 'button', hidden: 'hidden' },
      on: { click: () => location.reload() },
    });
    this.connBanner = h(
      'div',
      { class: 'conn-banner game-conn-banner', attrs: { hidden: 'hidden', role: 'status' } },
      h('span', { class: 'conn-spinner', attrs: { 'aria-hidden': 'true' } }),
      this.connText,
      this.connAction,
    );
    this.gameBanner = h('div', {
      class: 'game-banner',
      attrs: { hidden: 'hidden', role: 'status' },
    });

    this.handoffAvatar = h('span', { class: 'handoff-avatar' });
    this.handoffName = h('span', { class: 'handoff-name', text: '' });
    this.handoff = h(
      'div',
      { class: 'handoff-banner', attrs: { hidden: 'hidden', 'aria-live': 'assertive' } },
      this.handoffAvatar,
      h(
        'div',
        { class: 'handoff-text' },
        this.handoffName,
        h('span', { class: 'handoff-sub', text: '端末を渡してください' }),
      ),
    );
    this.skipHint = h('div', { class: 'skip-hint', attrs: { hidden: 'hidden' }, text: 'タップでスキップ ▶▶' });
    this.chat.fab.classList.add('hud-comm-button');
    this.emotes.fab.classList.add('hud-comm-button');
    this.commDock.append(this.chat.fab, this.emotes.fab);

    this.el = h(
      'div',
      { class: 'screen game-screen' },
      this.mapWrap,
      h('div', { class: 'map-vignette', attrs: { 'aria-hidden': 'true' } }),
      this.topbar,
      this.recenterButton,
      this.miniMapCanvas,
      this.rankingHost,
      this.portraitHost,
      this.subtitleBar,
      this.moneyHost,
      this.bottomBar,
      this.eventPanel.el,
      this.emoteHost,
      this.dice.el,
      this.connBanner,
      this.gameBanner,
      this.handoff,
      this.turnBanner,
      this.monthFlip,
      this.rouletteOverlay,
      this.destArrow,
      this.confettiHost,
      this.cityPickBanner,
      this.skipHint,
      this.loading,
      this.chat.panel,
      this.emotes.panel,
    );

    this.fxPlayer = new FxPlayer({
      settings: () => effectiveUiSettings(),
      handleFx: (fx, state, control) => this.handleFx(fx, state, control),
      applyState: (state, deadline, seq) => this.applyState(state, deadline, seq),
      setBusy: (busy) => {
        this.fxBusy = busy;
        this.updateHud();
        if (!busy) {
          this.updateAutoDialogs();
          this.advanceBulkBuy();
        }
      },
      setSkippable: (skippable) => {
        this.skipHint.hidden = !skippable || !!this.resultScreen;
      },
      onQueueChange: () => undefined,
    });

    this.bindKeyboard();
    this.bindClickToSkip();
    const onConn = this.session.onConnection((state) => this.renderConnection(state));
    this.unsubscribeFns.push(onConn);
    this.renderConnection(this.session.connection());

    const onUnlocked = () => this.updateBgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.unsubscribeFns.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked));
    this.unsubscribeFns.push(watchMotionPreference(() => this.map?.setReducedMotion(motionReduced())));
  }

  async init(): Promise<void> {
    await this.initMap();
  }

  destroy(): void {
    this.destroyed = true;
    this.fxPlayer.destroy();
    this.timer.destroy();
    this.dice.destroy();
    this.chat.destroy();
    this.emotes.destroy();
    this.resultScreen?.destroy();
    this.yearEnd?.close();
    this.shop?.close();
    this.transient?.handle.close();
    this.citySheet?.close();
    this.map?.setMiniMap(null);
    this.map?.destroy();
    for (const unsub of this.unsubscribeFns) unsub();
    window.clearTimeout(this.pendingTimer);
    window.clearTimeout(this.sayTimer);
    window.clearTimeout(this.bannerTimer);
    window.clearTimeout(this.handoffTimer);
    window.clearTimeout(this.portraitVariantTimer);
    window.clearTimeout(this.turnBannerTimer);
    window.clearTimeout(this.monthFlipTimer);
    window.clearTimeout(this.stepsTimer);
    window.clearTimeout(this.rouletteTimer);
    this.clearCityPick();
    window.clearInterval(this.rouletteInterval);
    this.rouletteFinish?.(true);
    this.canvas.removeEventListener('pointerdown', this.onMapInteract);
    this.canvas.removeEventListener('pointerup', this.onMapInteract);
    this.canvas.removeEventListener('wheel', this.onMapInteract);
    window.removeEventListener('resize', this.onWindowResize);
    Audio.stopVoice();
    this.el.remove();
  }

  // ---------------------------------------------------------------- loading & session

  private async initMap(): Promise<void> {
    if (this.destroyed) return;
    this.loading.hidden = false;
    this.loading.classList.remove('is-error');
    this.loadingText.textContent = '世界地図をひらいています…';
    this.loadingBar.hidden = false;
    this.retryButton.hidden = true;
    this.loadingFill.style.width = '0%';
    try {
      const assets = await loadMapAssets(GAME_DATA, (progress: AssetProgress) => {
        const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
        this.loadingFill.style.width = `${Math.round(ratio * 100)}%`;
        this.loadingText.textContent = `世界地図をひらいています… ${progress.label}`;
      });
      if (this.destroyed) return;
      this.map?.setMiniMap(null);
      this.map?.destroy();
      this.map = new MapView(this.canvas, GAME_DATA, assets);
      this.map.setReducedMotion(motionReduced());
      this.map.onCityTap((cityId) => this.onCityTap(cityId));
      this.map.setMiniMap(this.miniMapCanvas);
      this.map.resize();
      this.canvas.addEventListener('pointerdown', this.onMapInteract, { passive: true });
      this.canvas.addEventListener('pointerup', this.onMapInteract, { passive: true });
      this.canvas.addEventListener('wheel', this.onMapInteract, { passive: true });
      window.addEventListener('resize', this.onWindowResize);
      this.updateMapSafeArea();
      this.loadingBar.hidden = true;
      this.loadingText.textContent = '盤面を待っています…';
      this.bindSession();
      this.loading.hidden = !!this.state;
      if (this.state) this.map.setState(this.state);
    } catch (error) {
      if (this.destroyed) return;
      this.loading.classList.add('is-error');
      this.loadingText.textContent = `世界地図を読み込めませんでした。${error instanceof Error ? `（${error.message}）` : ''}`;
      this.retryButton.hidden = false;
      this.loadingBar.hidden = true;
    }
  }

  private bindSession(): void {
    if (this.sessionBound) return;
    this.sessionBound = true;
    const unsub = this.session.subscribe((msg) => this.onMessage(msg));
    this.unsubscribeFns.push(unsub);
    this.updateBgm();
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.mySeat = msg.seat;
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        for (const line of msg.chat) this.chat.addLine(line);
        this.renderConnections();
        break;
      case 'snapshot':
        if (msg.seq < this.latestSeq) break;
        this.fxPlayer.reset();
        this.latestSeq = Math.max(this.latestSeq, msg.seq);
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        this.deadline = msg.deadline;
        this.actionPending = false;
        this.endedVoicePlayed = false;
        this.applyState(msg.state, msg.deadline, msg.seq, true);
        this.eventPanel.resetChosen();
        break;
      case 'update':
        if (msg.seq <= this.latestSeq) break;
        this.latestSeq = msg.seq;
        this.deadline = msg.deadline;
        this.actionPending = false;
        this.clearPendingTimer();
        this.fxPlayer.enqueue({ seq: msg.seq, fx: msg.fx, state: msg.state, deadline: msg.deadline });
        this.updateHud();
        break;
      case 'lobby':
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        this.renderConnections();
        break;
      case 'flag': {
        this.flaggedSeats.add(msg.seat);
        const playerId = this.playerIdOfSeat(msg.seat);
        const name = playerId !== null ? this.playerName(playerId) : `席 ${msg.seat + 1}`;
        this.chat.addSystem(`${name} は通報により自動ミュートされました。`);
        this.app.toasts.show(`${name} を自動ミュートしました（通報）`, 'warn', 3600);
        this.chat.refreshLog();
        if (this.state) this.renderRanking(this.state, actorOf(this.state));
        break;
      }
      case 'chat':
        this.chat.addLine(msg.line);
        break;
      case 'emote':
        this.enqueueEmote(msg.emote);
        break;
      case 'system':
        this.chat.addSystem(msg.text);
        this.addLog(msg.text);
        this.showGameBanner(msg.text);
        break;
      case 'error':
        this.onServerError(msg.code, msg.message);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private onServerError(code: string, message: string): void {
    this.actionPending = false;
    if (code !== 'rate_limited') this.eventPanel.resetChosen();
    this.clearPendingTimer();
    if (code === 'rate_limited') {
      this.chat.notifyRateLimited('レート制限中。少し待ってから送ってください。');
      this.app.toasts.show(ERROR_JA.rate_limited, 'warn');
      return;
    }
    const japanese = ERROR_JA[code] ?? message ?? `エラー: ${code}`;
    this.app.toasts.show(japanese, 'bad', 3400);
    if (code === 'not_your_turn' || code === 'stale' || code === 'illegal' || code === 'bad_request') {
      this.refreshActionDialogs();
    }
    this.updateHud();
  }

  private refreshActionDialogs(): void {
    this.citySheet?.close();
    this.citySheet = null;
    this.citySheetCityId = null;
    this.citySheetBuyMode = false;
    this.transient?.handle.close();
    this.transient = null;
    this.yearEnd?.close();
    this.yearEnd = null;
    this.shop?.close();
    this.shop = null;
    this.updateAutoDialogs();
  }

  // ---------------------------------------------------------------- state & hud

  private applyState(state: PublicState, deadline: number | null, seq: number, instant = false): void {
    if (seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    this.seq = Math.max(this.seq, seq);
    const previousYear = this.state?.year;
    this.state = state;
    this.deadline = deadline;
    this.loading.hidden = true;
    this.map?.setState(state);
    this.map?.setMonth(state.month);
    this.renderHud();
    this.updateAutoDialogs();
    this.updateBgm();
    if (!this.initialFocused) {
      this.initialFocused = true;
      const actor = actorOf(state);
      const player = actor !== null ? state.players[actor] : state.players[0];
      requestAnimationFrame(() => {
        if (player) this.map?.focusNode(player.nodeId, { zoom: 0.82, ms: 0 });
        this.map?.follow(actor);
      });
    }
    if (previousYear !== undefined && state.year > previousYear && !instant) {
      this.showGameBanner(`第 ${state.year} 年 スタート！`);
    }
    if (this.lastMonthShown === null) {
      this.lastMonthShown = state.year * 100 + state.month;
    } else if (this.lastMonthShown !== state.year * 100 + state.month) {
      this.showMonthFlip(state.year, state.month);
    }
  }

  private updateHud(): void {
    // While fx play, do not repaint the portrait / move picker from the (older) adopted state.
    // Only the primary button and timer react to busy/pending changes during a cutscene.
    if (this.fxBusy) {
      if (this.state) {
        const actor = actorOf(this.state);
        this.updatePrimary(this.state, actor);
        this.updateTimer(this.state, actor);
      }
      return;
    }
    this.renderHud();
  }

  private renderHud(): void {
    const state = this.state;
    if (!state) return;
    const actor = actorOf(state);
    const displaySeat = this.displaySeat();
    const privateSeat = this.privateSeat();

    this.yearChip.textContent = `${state.year}年目 ${state.month}月`;
    this.turnChip.textContent = `ターン ${formatTurnLabel(state.round, state.config.years)}`;
    const focusPlayer = actor !== null ? state.players[actor] : undefined;
    const actorRealm = realmOfNode(focusPlayer?.nodeId);
    this.playerRealm = actorRealm;
    if (!this.manualView && this.viewRealm !== actorRealm) {
      this.viewRealm = actorRealm;
      this.applyMapView();
    }
    this.renderPlayerPlate(state, displaySeat, actor);
    this.updateRealmChip();
    const inRealm = actorRealm !== 'world';
    const portalId = inRealm ? portalNodeFor(actorRealm) : undefined;
    const destNode = inRealm && portalId ? portalId : cityNodeId(state.destination);
    const destination = citiesById.get(state.destination);
    this.destText.textContent = inRealm ? '出口' : destination?.nameJa ?? state.destination;
    this.destChip.classList.toggle('is-realm', inRealm);
    const distanceSeat = actor ?? displaySeat ?? 0;
    const destPlayer = state.players[distanceSeat];
    const steps = destPlayer ? distance(GAME_DATA, destPlayer.nodeId, destNode) : 0;
    const distanceValue = this.destDistance.querySelector('.dest-distance-value');
    if (distanceValue) distanceValue.textContent = Number.isFinite(steps) ? String(steps) : '—';
    this.updateDestArrow(state, actor, destNode);
    this.statusChip.textContent =
      this.resultScreen !== null
        ? 'ゲーム終了'
        : state.phase.t === 'game_over'
          ? 'ゲーム終了'
          : actor === null
            ? '観戦中'
            : this.myPlayerIds().includes(actor)
              ? 'あなたの番'
              : `${this.actorLabel(actor)} の番`;
    this.statusChip.classList.toggle(
      'is-mine',
      actor !== null && this.myPlayerIds().includes(actor) && state.phase.t !== 'game_over',
    );

    const choosing = state.phase.t === 'choose_dest' && actor !== null && this.myPlayerIds().includes(actor);
    this.el.classList.toggle('choosing-dest', choosing);
    this.renderRanking(state, actor);
    this.renderPortrait(state, actor);
    this.renderMoney(state, displaySeat, actor);
    this.renderMoveOptions(state, actor);
    this.updatePrimary(state, actor);
    this.updateTimer(state, actor);
    if (this.eventPanel.isOpen) this.eventPanel.setState(state, this.interactiveNow());
    const hand = privateSeat !== null ? state.players[privateSeat]?.cards.length ?? 0 : 0;
    this.cardBadge.textContent = String(hand);
    this.cardBadge.hidden = hand === 0;
    requestAnimationFrame(() => this.updateMapSafeArea());
  }

  private renderRanking(state: PublicState, actor: number | null): void {
    const order = [...state.players].sort((a, b) => {
      const diff = netWorth(GAME_DATA, state, b.id) - netWorth(GAME_DATA, state, a.id);
      return diff !== 0 ? diff : a.id - b.id;
    });
    const oldRects = new Map<number, { x: number; y: number }>();
    const oldIndexes = new Map<number, number>();
    if (!motionReduced()) {
      this.rankingHost.querySelectorAll<HTMLElement>('.rank-row').forEach((row, index) => {
        const seat = Number(row.dataset.seat);
        if (Number.isNaN(seat)) return;
        const rect = row.getBoundingClientRect();
        oldRects.set(seat, { x: rect.left, y: rect.top });
        oldIndexes.set(seat, index);
      });
    }
    this.rankingHost.replaceChildren(h('span', { class: 'ranking-caption', text: '総資産順' }));
    order.forEach((player, index) => {
      const character = charsById.get(player.characterId);
      const displayName = player.isCpu ? character?.nameJa ?? player.name : player.name;
      const net = netWorth(GAME_DATA, state, player.id);
      const isActor = player.id === actor;
      const isMine = this.myPlayerIds().includes(player.id);
      const lobbySeat = this.lobby?.seats[this.seatOfPlayer(player.id) ?? -1];
      const playerSeat = this.seatOfPlayer(player.id);
      const flagged = playerSeat !== null && this.flaggedSeats.has(playerSeat);
      const previousIndex = oldIndexes.get(player.id);
      const moved = previousIndex !== undefined && previousIndex !== index ? (previousIndex > index ? 'up' : 'down') : null;
      const bubble = this.rankBubbles.get(player.id);
      const row = h(
        'button',
        {
          class: `rank-row ${isActor ? 'is-current' : ''} ${isMine ? 'is-mine' : ''}`.trim(),
          attrs: { type: 'button', 'aria-label': `${displayName} の詳細`, style: `--seat-color:${seatColor(player.id)}` },
          dataset: { seat: String(player.id) },
          on: { click: () => this.openRoster() },
        },
        h('span', { class: `rank-badge rank-${index + 1}` }, h('span', { text: String(index + 1) })),
        avatar(characterSprite(character), character?.color ?? playerColor(player), 46, 'rank-avatar'),
        h(
          'span',
          { class: 'rank-main' },
          h(
            'span',
            { class: 'rank-name-line' },
            h('span', { class: 'rank-name', text: displayName }),
            player.isCpu ? h('span', { class: 'rank-tag', text: `Lv${player.cpuLevel}` }) : null,
            flagged ? h('span', { class: 'rank-tag is-flagged', text: '🚩自動ミュート' }) : null,
            isActor ? h('span', { class: 'rank-turn', text: '▶' }) : null,
            realmOfNode(player.nodeId) !== 'world'
              ? h('span', {
                  class: 'rank-realm',
                  text: REALM_ICON[realmOfNode(player.nodeId)],
                  title: realmLabel(realmOfNode(player.nodeId)),
                })
              : null,
            moved ? h('span', { class: `rank-move ${moved}`, text: moved === 'up' ? '▲' : '▼' }) : null,
            this.lobby?.status !== undefined && lobbySeat?.kind === 'human' && lobbySeat.connected === false
              ? h('span', { class: 'rank-tag is-offline', text: '切断' })
              : null,
            lobbySeat?.autoplay ? h('span', { class: 'rank-tag is-autoplay', text: '代行' }) : null,
          ),
          h(
            'span',
            { class: 'rank-money-line' },
            uiIcon('coins', '🪙', 'rank-coin'),
            h('span', { class: 'rank-money', text: '' }),
            state.piper.holder === player.id
              ? h('span', { class: 'rank-piper', text: `🎺 Lv${state.piper.level}` })
              : null,
          ),
        ),
        bubble && bubble.expires > Date.now()
          ? h('span', { class: 'rank-bubble', text: bubble.text })
          : null,
        h(
          'span',
          {
            class: 'rank-menu',
            role: 'button',
            attrs: { 'aria-label': `${displayName} のメニュー`, tabindex: '0' },
            on: {
              click: (event) => {
                event.stopPropagation();
                const seat = this.seatOfPlayer(player.id);
                if (seat !== null) this.openSeatMenu(seat);
              },
            },
          },
          h('span', { text: '…' }),
        ),
      );
      this.rankingHost.append(row);
      const moneyEl = row.querySelector<HTMLElement>('.rank-money');
      if (moneyEl) this.setCounter(moneyEl, `rank:${player.id}:net`, net, formatOku);
      const arrow = row.querySelector('.rank-move');
      if (arrow) window.setTimeout(() => arrow.remove(), 1300);
    });
    if (!motionReduced() && oldRects.size > 0) {
      requestAnimationFrame(() => {
        this.rankingHost.querySelectorAll<HTMLElement>('.rank-row').forEach((row) => {
          const seat = Number(row.dataset.seat);
          const old = oldRects.get(seat);
          if (!old) return;
          const rect = row.getBoundingClientRect();
          const dx = old.x - rect.left;
          const dy = old.y - rect.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          row.style.transition = 'none';
          row.style.transform = `translate(${dx}px, ${dy}px)`;
          requestAnimationFrame(() => {
            row.style.transition = 'transform 420ms cubic-bezier(.2,.8,.2,1)';
            row.style.transform = '';
          });
        });
      });
    }
  }

  private renderPortrait(state: PublicState, actor: number | null): void {
    const seat = actor ?? this.displaySeat();
    const player = seat !== null ? state.players[seat] : undefined;
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!player || !character) {
      this.portraitHost.hidden = true;
      return;
    }
    this.portraitHost.hidden = false;
    const src = characterSprite(character);
    this.portraitBaseSrc = src;
    if (this.portraitImage.getAttribute('src') !== src && !this.portraitImage.classList.contains('is-mood')) {
      this.portraitImage.src = src;
      this.portraitImage.alt = character.nameJa;
    }
    this.portraitName.textContent = displayPlayerName(player);
    this.portraitSub.textContent = `${character.nameJa} ・ ${character.origin}`;
    this.portraitHost.dataset.seat = String(player.id);
    const rank = [...state.players]
      .sort((a, b) => netWorth(GAME_DATA, state, b.id) - netWorth(GAME_DATA, state, a.id))
      .findIndex((candidate) => candidate.id === player.id) + 1;
    this.portraitRank.textContent = rank === 1 ? '👑 1位' : `${rank}位`;
    this.portraitRank.className = `portrait-rank rank-${rank}`;
  }

  private renderMoney(state: PublicState, seat: number | null, actor: number | null): void {
    const player = seat !== null ? state.players[seat] : undefined;
    if (!player) {
      this.moneyHost.hidden = true;
      return;
    }
    this.moneyHost.hidden = false;
    const character = charsById.get(player.characterId);
    const income = annualIncome(GAME_DATA, state, player.id);
    const net = netWorth(GAME_DATA, state, player.id);
    this.moneyHost.replaceChildren(
      h(
        'div',
        { class: 'money-head' },
        avatar(characterSprite(character), character?.color ?? playerColor(player), 34),
        uiIcon('moneybag', '💰', 'money-head-icon'),
        h(
          'div',
          { class: 'money-head-text' },
          h('span', { class: 'money-name', text: displayPlayerName(player) }),
          h('span', {
            class: 'money-role',
            text: seat === actor ? '手番プレイヤー' : 'あなた',
          }),
        ),
      ),
      h(
        'div',
        { class: 'money-grid' },
        h(
          'div',
          { class: 'money-cell' },
          h('span', { class: 'money-label', text: player.cash < 0 ? '借金' : '所持金' }),
          h('strong', { class: `money-value ${player.cash < 0 ? 'money-negative' : ''}`.trim(), text: '' }),
        ),
        h(
          'div',
          { class: 'money-cell' },
          h('span', { class: 'money-label', text: '年間収益' }),
          h('strong', { class: 'money-value money-positive', text: '' }),
        ),
        h(
          'div',
          { class: 'money-cell money-cell-net' },
          h('span', { class: 'money-label', text: '総資産' }),
          h('strong', { class: 'money-value', text: '' }),
        ),
      ),
    );
    const cashEl = this.moneyHost.querySelector<HTMLElement>('.money-value.money-negative, .money-cell .money-value');
    const incomeEl = this.moneyHost.querySelectorAll<HTMLElement>('.money-value')[1];
    const netEl = this.moneyHost.querySelectorAll<HTMLElement>('.money-value')[2];
    if (cashEl) this.setCounter(cashEl, `money:${player.id}:cash`, player.cash, formatOku);
    if (incomeEl) this.setCounter(incomeEl, `money:${player.id}:income`, Math.round(income), (n) => `${n >= 0 ? '+' : ''}${formatOkuShort(n)}`.replace('+▲', '▲'));
    if (netEl) this.setCounter(netEl, `money:${player.id}:net`, net, formatOku);
  }

  private renderMoveOptions(state: PublicState, actor: number | null): void {
    const canAct = actor !== null && this.myPlayerIds().includes(actor) && !this.fxBusy && !this.actionPending;
    if (state.phase.t !== 'choose_dest' || !canAct) {
      this.moveSelection = null;
      this.moveOptionsCache = [];
      this.moveOptionsKey = '';
      this.moveOptionsHost.hidden = true;
      this.moveOptionsHost.replaceChildren();
      this.map?.setMoveOptions(null, () => undefined);
      return;
    }
    const options = state.phase.options;
    if (this.moveSelection && !options.some((option) => option.nodeId === this.moveSelection)) this.moveSelection = null;
    const key = options.map((option) => `${option.nodeId}:${option.path.join(',')}`).join('|');
    if (key !== this.moveOptionsKey) {
      this.moveOptionsKey = key;
      this.moveOptionsCache = options;
      this.map?.setMoveOptions(options, {
        numbers: options.map((_, index) => index + 1),
        onSelect: (nodeId) => this.selectMoveOption(nodeId, true),
        onConfirm: (nodeId) => this.confirmMoveOption(nodeId),
      });
    }
    this.moveOptionsHost.hidden = false;
    const actorNode = actor !== null ? state.players[actor]?.nodeId : undefined;
    const scroller = h('div', { class: 'move-chip-scroll' });
    options.forEach((option, index) => {
      const summary = transportSummary(actorNode ? [actorNode, ...option.path] : option.path);
      const chip = h(
        'button',
        {
          class: `move-chip ${this.moveSelection === option.nodeId ? 'is-selected' : ''}`.trim(),
          attrs: {
            type: 'button',
            'aria-label': `${index + 1}: ${nodeLabel(option.nodeId)} を選ぶ`,
            'aria-pressed': String(this.moveSelection === option.nodeId),
          },
          on: { click: () => this.selectMoveOption(option.nodeId) },
        },
        h('span', { class: 'move-chip-num', text: String(index + 1) }),
        h('span', { class: 'move-chip-icon', text: squareIcon(option.nodeId), attrs: { 'aria-hidden': 'true' } }),
        h(
          'span',
          { class: 'move-chip-main' },
          h('span', { class: 'move-chip-name', text: nodeLabel(option.nodeId) }),
          h(
            'span',
            { class: 'move-chip-vehicle' },
            summary.rail > 0 ? h('span', { text: `電車 ${summary.rail}マス` }) : null,
            summary.sea > 0 ? h('span', { text: `船 ${summary.sea}マス` }) : null,
          ),
        ),
        h('span', { class: 'move-chip-steps', text: `${option.path.length}歩` }),
      );
      scroller.append(chip);
    });
    const page = (direction: number): void => {
      scroller.scrollBy({ left: direction * Math.max(180, scroller.clientWidth * 0.7), behavior: 'smooth' });
    };
    const prev = h('button', {
      class: 'move-scroll-btn',
      text: '‹',
      attrs: { type: 'button', 'aria-label': '前の行き先' },
      on: { click: (event) => { event.stopPropagation(); page(-1); } },
    });
    const next = h('button', {
      class: 'move-scroll-btn',
      text: '›',
      attrs: { type: 'button', 'aria-label': '次の行き先' },
      on: { click: (event) => { event.stopPropagation(); page(1); } },
    });
    this.moveOptionsHost.replaceChildren(
      h(
        'div',
        { class: 'move-options-head' },
        h('span', { class: 'move-options-label', text: `出目 ${state.phase.roll} ・ 候補 ${options.length}` }),
        h('span', { class: 'move-options-hint', text: '1回目のタップで選択、下のボタンで決定' }),
        prev,
        next,
      ),
      scroller,
    );
    this.updateMoveSelectionUi();
  }

  private selectMoveOption(nodeId: string, fromMap = false): void {
    if (!this.moveOptionsCache.some((option) => option.nodeId === nodeId)) return;
    this.moveSelection = nodeId;
    if (!fromMap) this.map?.selectMoveOption(nodeId);
    this.updateMoveSelectionUi();
    if (this.state) this.updatePrimary(this.state, actorOf(this.state));
  }

  private confirmMoveOption(nodeId?: string): void {
    const target = nodeId ?? this.moveSelection;
    if (!target || !this.moveOptionsCache.some((option) => option.nodeId === target)) return;
    this.moveSelection = null;
    this.moveOptionsCache = [];
    this.moveOptionsKey = '';
    this.moveOptionsHost.hidden = true;
    this.moveOptionsHost.replaceChildren();
    this.map?.setMoveOptions(null, () => undefined);
    this.sendAction({ t: 'move', nodeId: target });
  }

  private updateMoveSelectionUi(): void {
    this.moveOptionsHost.querySelectorAll<HTMLElement>('.move-chip').forEach((chip, index) => {
      const option = this.moveOptionsCache[index];
      const selected = !!option && option.nodeId === this.moveSelection;
      chip.classList.toggle('is-selected', selected);
      chip.setAttribute('aria-pressed', String(selected));
    });
  }

  private updatePrimary(state: PublicState, actor: number | null): void {
    const mine = actor !== null && this.myPlayerIds().includes(actor);
    let label = 'サイコロをふる';
    let icon = '▶';
    let disabled = true;
    let className = 'btn btn-gold dice-primary';
    if (state.phase.t === 'game_over' || this.resultScreen) {
      label = 'ゲーム終了';
      disabled = true;
    } else if (this.fxBusy) {
      label = '演出中…';
      icon = '🎬';
    } else if (this.actionPending) {
      label = '送信中…';
      icon = '⏳';
    } else if (!mine) {
      label = actor === null ? '観戦中' : `${this.actorLabel(actor)} の番…`;
      icon = '⌛';
    } else {
      const phase = state.phase;
      switch (phase.t) {
        case 'turn_start':
          label = 'サイコロをふる';
          icon = '▶';
          disabled = false;
          className = 'btn btn-gold dice-primary is-active';
          break;
        case 'choose_dest':
          if (this.moveSelection) {
            const selected = this.moveOptionsCache.find((option) => option.nodeId === this.moveSelection);
            label = selected ? `ここへ移動（${nodeLabel(selected.nodeId)}）` : 'ここへ移動';
            icon = '📍';
            disabled = false;
            className = 'btn btn-gold dice-primary is-active';
          } else {
            label = '行き先を選択';
            icon = '👆';
          }
          break;
        case 'buy':
          label = '物件を選んでください';
          icon = '🏙️';
          break;
        case 'event':
          label = 'ニュースを選択中';
          icon = '📰';
          break;
        case 'card_target':
          label = 'カードの対象を選択中';
          icon = '🎴';
          break;
        case 'discard':
          label = '手札を調整中';
          icon = '🃏';
          break;
        case 'sell':
          label = '支払いのため売却中';
          icon = '💸';
          break;
        case 'year_end':
          label = '決算を確認してください';
          icon = '📊';
          break;
        case 'shop':
          label = 'カード売り場でお買い物';
          icon = '🛒';
          break;
        default:
          label = 'お待ちください';
          break;
      }
    }
    this.primaryIcon.textContent = icon;
    this.primaryLabel.textContent = label;
    this.primary.disabled = disabled;
    this.primary.className = className;
  }

  private updateTimer(state: PublicState, actor: number | null): void {
    const totalSeconds = this.lobby?.settings.turnSeconds ?? 0;
    if (state.phase.t === 'game_over' || this.resultScreen || this.session.mode !== 'online' || totalSeconds <= 0 || this.deadline === null) {
      this.timer.set({ deadline: null, totalSeconds, isMine: false });
      return;
    }
    this.timer.set({
      deadline: this.deadline,
      totalSeconds,
      isMine: actor !== null && this.myPlayerIds().includes(actor),
    });
  }

  private updateAutoDialogs(): void {
    const state = this.state;
    if (!state || this.fxBusy) return;
    const canAct = this.interactiveNow();

    if (state.phase.t === 'buy') {
      const cityId = state.phase.cityId;
      if (!citiesById.has(cityId)) {
        if (canAct && !this.actionPending) {
          this.app.toasts.show('この駅は開業準備中です。手番を終了します。', 'warn', 3000);
          this.sendAction({ t: 'end_buy' });
        }
        return;
      }
      if (!this.citySheet || this.citySheetCityId !== cityId || !this.citySheetBuyMode) {
        this.citySheet?.close();
        this.citySheetCityId = cityId;
        this.citySheetBuyMode = true;
        this.citySheet = openCitySheet({
          modal: this.app.modal,
          cityId,
          state,
          buyMode: true,
          canAct,
          ownerWillAct: this.myPlayerIds().includes(state.current),
          onBuy: (propertyId) => this.sendAction({ t: 'buy', propertyId }),
          onBuyAll: () => {
            this.bulkBuyCityId = cityId;
            this.advanceBulkBuy();
          },
          onEndBuy: () => {
            this.bulkBuyCityId = null;
            this.citySheet?.close();
            this.citySheet = null;
            this.citySheetCityId = null;
            this.citySheetBuyMode = false;
            this.sendAction({ t: 'end_buy' });
          },
          onClose: () => {
            this.citySheet = null;
            this.citySheetCityId = null;
            this.citySheetBuyMode = false;
          },
        });
      } else {
        this.citySheet.update(state, canAct);
      }
    } else if (this.citySheet) {
      this.bulkBuyCityId = null;
      if (this.citySheetBuyMode) {
        this.citySheet.close();
        this.citySheet = null;
        this.citySheetCityId = null;
        this.citySheetBuyMode = false;
      } else {
        this.citySheet.update(state, canAct);
      }
    }

    this.updateTransientDialog(state, canAct);

    if (state.phase.t === 'shop') {
      if (!this.shop) {
        this.shop = openShopDialog({
          modal: this.app.modal,
          state,
          canAct,
          onBuy: (cardId) => this.sendAction({ t: 'buy_card', cardId }),
          onSell: (cardId) => this.sendAction({ t: 'sell_card', cardId }),
          onEnd: () => {
            this.shop?.close();
            this.shop = null;
            this.sendAction({ t: 'end_shop' });
          },
        });
      } else {
        this.shop.update(state, canAct);
      }
    } else if (this.shop) {
      this.shop.close();
      this.shop = null;
    }

    if (state.phase.t === 'year_end') {
      if (!this.yearEnd) {
        this.yearEnd = openYearEndDialog({
          modal: this.app.modal,
          state,
          canAct,
          actorName: this.actorLabel(state.current),
          onAck: () => {
            this.yearEnd?.close();
            this.yearEnd = null;
            this.sendAction({ t: 'ack' });
          },
        });
        this.setBgm('yearend');
      } else {
        this.yearEnd.update(state, canAct);
      }
    } else if (this.yearEnd) {
      this.yearEnd.close();
      this.yearEnd = null;
    }

    if (state.activeEventId) {
      const event = eventsById.get(state.activeEventId);
      if (event) {
        if (!this.eventPanel.isOpen) {
          this.openEventPanel(event.id, state);
        } else {
          this.eventPanel.setState(state, canAct);
        }
      }
    } else if (this.eventPanel.isOpen) {
      this.eventPanel.hide();
      this.syncEventComm();
      this.activeEventBgm = null;
    }

    if (state.phase.t === 'game_over') {
      this.showResult(state);
    } else if (this.resultScreen) {
      this.resultScreen.destroy();
      this.resultScreen = null;
      this.el.querySelector('.result-screen')?.remove();
    }
  }

  private updateTransientDialog(state: PublicState, canAct: boolean): void {
    const phase = state.phase;
    if (this.cityPick) {
      if (phase.t === 'card_target' && phase.cardId === this.cityPick.cardId) return;
      this.clearCityPick();
    }
    const wanted: TransientKind | null =
      phase.t === 'card_target' ? 'target' : phase.t === 'discard' ? 'discard' : phase.t === 'sell' ? 'sell' : null;
    if (!wanted) {
      if (this.transient) {
        this.transient.handle.close();
        this.transient = null;
      }
      return;
    }
    if (this.transient) {
      this.transient.handle.close();
      this.transient = null;
    }
    if (wanted === 'target' && phase.t === 'card_target') {
      const handle = openCardTargetDialog({
        modal: this.app.modal,
        state,
        canAct,
        cardId: phase.cardId,
        options: phase.options,
        onTarget: (target) => this.sendAction({ t: 'card_target', target }),
        onCancel: () => this.sendAction({ t: 'cancel' }),
        onPickOnMap: () => {
          const cityTargets = phase.options.filter((target) => nodesById.get(target)?.kind === 'city');
          this.cityPick = { cardId: phase.cardId, options: new Set(cityTargets) };
          this.transient?.handle.close();
          this.transient = null;
          this.cityPickText.textContent = `${cityTargets.length} 都市から地図で選択`;
          this.cityPickBanner.hidden = false;
          this.app.toasts.show('地図の光っている都市をタップしてください', 'info', 3200);
        },
      });
      this.transient = { kind: 'target', cardId: phase.cardId, handle };
    } else if (wanted === 'discard' && phase.t === 'discard') {
      const handle = openDiscardDialog({
        modal: this.app.modal,
        state,
        canAct,
        onDiscard: (cardIdToDiscard) => this.sendAction({ t: 'discard', cardId: cardIdToDiscard }),
      });
      if (handle) this.transient = { kind: 'discard', cardId: null, handle };
    } else if (wanted === 'sell' && phase.t === 'sell') {
      const handle = openSellDialog({
        modal: this.app.modal,
        state,
        canAct,
        onSell: (propertyId) => this.sendAction({ t: 'sell', propertyId }),
      });
      if (handle) this.transient = { kind: 'sell', cardId: null, handle };
    }
  }

  // ---------------------------------------------------------------- turn / actions

  private sendAction(action: Action): void {
    if (!this.state || this.actionPending || this.fxBusy) return;
    this.actionPending = true;
    this.armPendingTimer();
    this.updateHud();
    this.session.send({ t: 'action', seq: this.seq, action });
  }

  private advanceBulkBuy(): void {
    const state = this.state;
    const cityId = this.bulkBuyCityId;
    if (!state || !cityId) return;
    if (state.phase.t !== 'buy' || state.phase.cityId !== cityId || !this.interactiveNow()) return;
    const city = citiesById.get(cityId);
    const player = state.players[state.current];
    if (!city || !player) {
      this.bulkBuyCityId = null;
      return;
    }
    const next = city.properties
      .filter((property) => state.owner[property.id] === undefined)
      .map((property) => ({ property, price: Math.round(purchasePrice(GAME_DATA, state, state.current, property.id)) }))
      .filter((entry) => entry.price <= player.cash)
      .sort((a, b) => a.price - b.price)[0];
    if (!next) {
      this.bulkBuyCityId = null;
      this.app.toasts.show('買える物件をまとめて購入しました', 'good');
      return;
    }
    this.sendAction({ t: 'buy', propertyId: next.property.id });
  }

  private armPendingTimer(): void {
    this.clearPendingTimer();
    this.pendingTimer = window.setTimeout(() => {
      if (!this.actionPending) return;
      this.actionPending = false;
      this.eventPanel.resetChosen();
      this.updateHud();
      this.app.toasts.show('操作の応答がありませんでした。もう一度お試しください。', 'warn', 3200);
      this.refreshActionDialogs();
    }, 9000);
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== 0) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = 0;
    }
  }

  private onPrimary(): void {
    const state = this.state;
    if (!state) return;
    if (state.phase.t === 'game_over' || this.fxBusy) return;
    if (state.phase.t === 'turn_start') {
      if (!this.interactiveNow()) {
        this.app.toasts.show(`${this.actorLabel(state.current)} の番です`, 'info');
        return;
      }
      this.sendAction({ t: 'roll' });
      return;
    }
    if (state.phase.t === 'choose_dest') {
      if (this.moveSelection) this.confirmMoveOption(this.moveSelection);
      else this.app.toasts.show('マップの候補か行き先チップを1回タップして選んでください', 'info');
    }
  }

  private interactiveNow(): boolean {
    const state = this.state;
    if (!state || state.phase.t === 'game_over' || this.actionPending || this.fxBusy) return false;
    const actor = actorOf(state);
    return actor !== null && this.myPlayerIds().includes(actor);
  }

  private canActSeatNow(): boolean {
    const state = this.state;
    if (!state || state.phase.t === 'game_over' || this.actionPending || this.fxBusy) return false;
    const actor = actorOf(state);
    return actor !== null && this.myPlayerIds().includes(actor);
  }

  // ---------------------------------------------------------------- dialogs & panels

  private setCounter(
    el: HTMLElement,
    key: string,
    value: number,
    format: (n: number) => string,
    duration = 620,
  ): void {
    const previous = this.lastValues.get(key);
    this.lastValues.set(key, value);
    if (previous === undefined) {
      el.textContent = format(value);
      return;
    }
    animateCounter(el, previous, value, format, duration);
  }

  private renderPlayerPlate(state: PublicState, seat: number | null, actor: number | null): void {
    const player = seat !== null ? state.players[seat] : undefined;
    if (!player) {
      this.playerPlate.hidden = true;
      return;
    }
    this.playerPlate.hidden = false;
    const character = charsById.get(player.characterId);
    this.playerPlate.style.setProperty('--seat-color', seatColor(player.id));
    this.playerPlate.classList.toggle('is-turn', player.id === actor);
    this.playerPlateAvatar.replaceChildren(
      character
        ? h('img', { attrs: { src: characterSprite(character), alt: '', draggable: 'false' } })
        : h('span', { text: '？' }),
    );
    this.playerPlateName.textContent = displayPlayerName(player);
    this.playerPlateSub.textContent = '所持金';
    this.playerPlate.setAttribute('aria-label', `${displayPlayerName(player)} の詳細`);
    this.setCounter(this.playerPlateCash, `plate:${player.id}:cash`, player.cash, formatOku);
  }

  private updateRealmChip(): void {
    const viewing = this.viewRealm;
    this.realmChip.hidden = viewing === 'world';
    if (viewing === 'world') return;
    this.realmChip.className = `chip realm-chip realm-${viewing}`;
    this.realmChip.replaceChildren(
      h('span', { text: REALM_ICON[viewing], attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: realmLabel(viewing) }),
      h('span', { class: 'realm-chip-tag', text: '表示中' }),
    );
    this.realmChip.setAttribute('aria-label', `${realmLabel(viewing)}を表示中。マップ切替を開く`);
  }

  private applyMapView(): void {
    const map = this.map;
    if (!map) return;
    const extra = extraMapView(map);
    extra?.setView?.(this.viewRealm);
    if (this.viewRealm === 'world') void map.fitWorld(420);
    else {
      const first = GAME_DATA.board.nodes.find((node) => node.realm === this.viewRealm);
      if (first) void map.focusNode(first.id, { zoom: 0.9, ms: 420 });
    }
    map.setReducedMotion(motionReduced());
    this.updateBgm();
  }

  private readonly onMapInteract = (): void => {
    const state = this.state;
    const actor = state ? actorOf(state) : null;
    const node = actor !== null ? state?.players[actor]?.nodeId : undefined;
    if (!node || this.viewRealm !== 'world') return;
    this.recenterButton.hidden = this.map?.isNodeVisible(node) === true;
  };

  private readonly onWindowResize = (): void => {
    this.map?.resize();
    this.syncEventComm();
    this.updateMapSafeArea();
  };

  private syncEventComm(): void {
    const narrow = window.matchMedia('(max-width: 899px)').matches;
    if (this.eventPanel.isOpen && narrow) {
      if (this.commDock.parentElement !== this.eventPanel.commHost) this.eventPanel.commHost.append(this.commDock);
    } else if (this.commDock.parentElement !== this.hudIcons) {
      this.hudIcons.append(this.commDock);
    }
  }

  private recenterOnActor(): void {
    const state = this.state;
    const actor = state ? actorOf(state) : null;
    if (!state || actor === null) return;
    const player = state.players[actor];
    const node = player ? nodesById.get(player.nodeId) : undefined;
    if (!node) return;
    this.manualView = false;
    this.viewRealm = realmOfNode(node.id);
    this.map?.setView?.(this.viewRealm);
    this.map?.follow(actor);
    void this.map?.focusNode(node.id, { zoom: realmOfNode(node.id) === 'world' ? 0.92 : 0.9, ms: 420 });
    this.recenterButton.hidden = true;
    this.renderHud();
  }

  private updateMapSafeArea(): void {
    const map = this.map;
    if (!map) return;
    const root = this.el.getBoundingClientRect();
    const topbar = this.topbar.getBoundingClientRect();
    const ranking = this.rankingHost.getBoundingClientRect();
    const bottom = this.bottomBar.getBoundingClientRect();
    const money = this.moneyHost.getBoundingClientRect();
    const event = this.eventPanel.el.getBoundingClientRect();
    const narrow = window.matchMedia('(max-width: 899px)').matches;
    let top = Math.max(0, topbar.bottom - root.top + 6);
    let left = 0;
    let right = 0;
    let bottomInset = Math.max(0, root.bottom - bottom.top + 6);
    if (narrow) {
      if (this.rankingHost.offsetParent !== null) top = Math.max(top, ranking.bottom - root.top + 6);
      if (!this.moneyHost.hidden) bottomInset = Math.max(bottomInset, root.bottom - money.top + 6);
    } else {
      left = Math.max(0, ranking.right - root.left + 8);
      if (this.eventPanel.isOpen) right = Math.max(0, root.right - event.left + 8);
    }
    if (this.eventPanel.isOpen && narrow) top = Math.max(top, event.top - root.top + 6);
    map.setSafeArea({ top, right, bottom: bottomInset, left });
  }

  private updateDestArrow(state: PublicState, actor: number | null, nodeId: string): void {
    if (actor === null || !this.state) {
      this.destArrow.hidden = true;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      this.destArrow.hidden = true;
      return;
    }
    const extra = extraMapView(this.map);
    let point = extra?.screenPositionOfNode?.(nodeId) ?? null;
    if (point && point.visible !== false && point.x > 24 && point.x < rect.width - 24 && point.y > 24 && point.y < rect.height - 24) {
      this.destArrow.hidden = true;
      return;
    }
    let dx: number;
    let dy: number;
    if (point) {
      dx = point.x - rect.width / 2;
      dy = point.y - rect.height / 2;
    } else {
      const playerNode = nodesById.get(state.players[actor]?.nodeId ?? '');
      const targetNode = nodesById.get(nodeId);
      if (!playerNode || !targetNode || playerNode.realm !== targetNode.realm) {
        this.destArrow.hidden = true;
        return;
      }
      dx = wrapDx(playerNode.x, targetNode.x);
      dy = targetNode.y - playerNode.y;
    }
    if (Math.abs(dx) + Math.abs(dy) < 1) {
      this.destArrow.hidden = true;
      return;
    }
    const angle = Math.atan2(dy, dx);
    const radiusX = rect.width * 0.42;
    const radiusY = rect.height * 0.4;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const scale = 1 / Math.max(Math.abs(Math.cos(angle)) / radiusX, Math.abs(Math.sin(angle)) / radiusY);
    const x = cx + Math.cos(angle) * scale;
    const y = cy + Math.sin(angle) * scale;
    this.destArrow.hidden = false;
    this.destArrow.style.left = `${Math.round(x)}px`;
    this.destArrow.style.top = `${Math.round(y)}px`;
    this.destArrow.querySelector('.dest-arrow-icon')?.setAttribute('style', `transform:rotate(${angle}rad)`);
    this.destArrow.querySelector('.dest-arrow-label')!.textContent = this.playerRealm !== 'world' ? '出口' : '目的地';
  }

  private openMapViewDialog(): void {
    const state = this.state;
    if (!state) return;
    const counts = new Map<MapViewId, number>();
    for (const player of state.players) {
      const realm = realmOfNode(player.nodeId);
      counts.set(realm, (counts.get(realm) ?? 0) + 1);
    }
    let handle: ModalHandle | null = null;
    const views: MapViewId[] = ['world', 'heaven', 'hell', 'space'];
    const body = h(
      'div',
      { class: 'map-view-dialog' },
      h('p', {
        class: 'map-view-copy',
        text: '手番プレイヤーのいる世界を自動で表示します。タブで覗き見もできます。',
      }),
    );
    const grid = h('div', { class: 'map-view-grid' });
    for (const view of views) {
      const selected = this.viewRealm === view;
      grid.append(
        h(
          'button',
          {
            class: `map-view-tab ${selected ? 'is-selected' : ''} realm-${view}`.trim(),
            attrs: { type: 'button', 'aria-pressed': String(selected) },
            on: {
              click: () => {
                handle?.close();
                this.manualView = true;
                this.viewRealm = view;
                this.applyMapView();
                this.renderHud();
                this.app.toasts.show(`${realmLabel(view)}を表示しています`, 'info');
              },
            },
          },
          h('span', { class: 'map-view-icon', text: REALM_ICON[view], attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'map-view-name', text: realmLabel(view) }),
          h('span', { class: 'map-view-count', text: `${counts.get(view) ?? 0} 人` }),
        ),
      );
    }
    body.append(grid);
    body.append(
      h('button', {
        class: 'btn btn-gold map-view-overview',
        text: '🌍 地上を全体表示',
        attrs: { type: 'button' },
        on: {
          click: () => {
            handle?.close();
            this.manualView = true;
            this.viewRealm = 'world';
            this.applyMapView();
            this.focusWorld();
            this.renderHud();
          },
        },
      }),
      h('button', {
        class: 'btn btn-ghost map-view-return',
        text: '🎯 手番プレイヤーを追う',
        attrs: { type: 'button' },
        on: {
          click: () => {
            handle?.close();
            this.manualView = false;
            this.viewRealm = this.playerRealm;
            this.applyMapView();
            this.renderHud();
          },
        },
      }),
      h(
        'div',
        { class: 'map-view-legend' },
        ...views.map((view) =>
          h(
            'span',
            { class: `map-view-legend-item realm-${view}` },
            h('span', { text: REALM_ICON[view] }),
            h('span', { text: realmLabel(view) }),
          ),
        ),
      ),
    );
    handle = this.app.modal.open(body, {
      title: '🗺️ 全体マップ',
      subtitle: '地上・天国・地獄・宇宙を切り替え',
      className: 'map-view-modal',
    });
  }

  private openOtherMenu(): void {
    let handle: ModalHandle | null = null;
    const item = (icon: string, label: string, action: () => void): HTMLElement =>
      h(
        'button',
        {
          class: 'game-menu-item',
          attrs: { type: 'button' },
          on: {
            click: () => {
              handle?.close();
              action();
            },
          },
        },
        h('span', { class: 'game-menu-icon' }, uiIcon(icon, icon)),
        h('span', { text: label }),
        h('span', { class: 'game-menu-arrow', text: '▶', attrs: { 'aria-hidden': 'true' } }),
      );
    const body = h(
      'div',
      { class: 'game-menu' },
      item('property', '持ち物（所有物件）', () => this.openOwned()),
      item('chart', '情報（業種・ニュース・ログ）', () => this.openInfo()),
      item('globe', '地上マップを全体表示', () => {
        this.manualView = true;
        this.viewRealm = 'world';
        this.applyMapView();
        this.renderHud();
        this.focusWorld();
      }),
      item('gear', '設定', () => this.app.openSettings()),
      item('help', '遊び方', () => this.app.openHelp()),
      item('trophy', 'クレジット', () => this.app.openCredits()),
    );
    handle = this.app.modal.open(body, { title: '📜 その他', subtitle: '持ち物・情報・設定' });
  }


  private portraitMood(mood: 'joy' | 'sad', playerId?: number): void {
    if (motionReduced()) return;
    const state = this.state;
    const seat = playerId ?? (state ? actorOf(state) : null);
    const player = state && seat !== null && seat !== undefined ? state.players[seat] : undefined;
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!character) return;
    const available = mood === 'joy' ? JOY_SPRITE_IDS : SAD_SPRITE_IDS;
    if (!available.has(character.id)) {
      this.portraitMotion(mood === 'joy' ? 'jump' : 'shake');
      return;
    }
    window.clearTimeout(this.portraitVariantTimer);
    const src = assetUrl(`assets/chars/${character.id}_${mood}.webp`);
    this.portraitImage.src = src;
    this.portraitImage.classList.add('is-mood');
    this.portraitMoodClass(mood);
    this.portraitVariantTimer = window.setTimeout(() => {
      this.portraitImage.classList.remove('is-mood');
      if (this.portraitBaseSrc) this.portraitImage.src = this.portraitBaseSrc;
    }, 2100);
  }

  private portraitMoodClass(mood: 'joy' | 'sad'): void {
    this.portraitImage.classList.toggle('mood-joy', mood === 'joy');
    this.portraitImage.classList.toggle('mood-sad', mood === 'sad');
    window.setTimeout(() => this.portraitImage.classList.remove('mood-joy', 'mood-sad'), 2100);
  }

  private portraitMotion(kind: 'talk' | 'jump' | 'shake'): void {
    if (motionReduced()) return;
    const cls = kind === 'talk' ? 'is-talking' : kind === 'jump' ? 'is-jumping' : 'is-shaking';
    this.portraitImage.classList.remove('is-talking', 'is-jumping', 'is-shaking');
    // Force restart so rapid consecutive moments retrigger.
    void this.portraitImage.offsetWidth;
    this.portraitImage.classList.add(cls);
    window.setTimeout(() => this.portraitImage.classList.remove(cls), kind === 'talk' ? 600 : 700);
  }

  private confetti(count = 18): void {
    confettiBurst(this.confettiHost, count);
  }

  private showCoinFlow(playerId: number, delta: number): void {
    if (motionReduced() || Math.abs(delta) < 0.5) return;
    const wallet = this.moneyHost.getBoundingClientRect();
    if (wallet.width === 0) return;
    const origin = this.map?.screenPositionOf(playerId) ?? { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    const targetX = wallet.left + wallet.width / 2;
    const targetY = wallet.top + wallet.height / 2;
    const positive = delta > 0;
    const count = Math.min(14, Math.max(5, Math.round(Math.abs(delta) / 8)));
    for (let i = 0; i < count; i++) {
      const bit = h('span', { class: `coin-particle ${positive ? 'is-coin' : 'is-bill'}`, text: positive ? '🪙' : '📄' });
      bit.style.left = `${origin.x + (Math.random() - 0.5) * 30}px`;
      bit.style.top = `${origin.y + (Math.random() - 0.5) * 30}px`;
      document.body.append(bit);
      const startX = positive ? targetX : wallet.left + wallet.width * (0.2 + Math.random() * 0.6);
      const startY = positive ? targetY : wallet.top;
      const dx = positive ? startX - origin.x : (Math.random() - 0.5) * 200;
      const dy = positive ? startY - origin.y : -80 - Math.random() * 120;
      bit.animate(
        [
          { transform: `translate(${dx * 0.25}px, ${dy * 0.25 - 40}px) scale(1)`, opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(${positive ? 0.5 : 1.1}) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 0 },
        ],
        { duration: 620 + Math.random() * 260, easing: 'cubic-bezier(.2,.7,.3,1)', delay: i * 18, fill: 'forwards' },
      ).finished.finally(() => bit.remove());
    }
  }

  private showCardFlash(card: { id: string; name: string; desc: string }, mode: 'draw' | 'use'): void {
    const vehicle = cardVehicle(card.id);
    const flash = h(
      'div',
      { class: `card-flash ${mode === 'draw' ? 'is-draw' : 'is-use'}` },
      vehicle ? vehicleBadge(vehicle, 54) : h('span', { class: 'card-flash-emoji', text: '🃏' }),
      h('div', { class: 'card-flash-text' }, h('strong', { text: card.name }), h('span', { text: card.desc })),
    );
    this.el.append(flash);
    window.setTimeout(() => flash.classList.add('is-out'), 1000);
    window.setTimeout(() => flash.remove(), 1450);
  }

  private showMonthFlip(year: number, month: number): void {
    const key = year * 100 + month;
    if (this.lastMonthShown === key) return;
    this.lastMonthShown = key;
    const season = monthSeason(month);
    this.monthFlipIcon.textContent = season.icon;
    this.monthFlipValue.textContent = `${month}月`;
    this.monthFlip.hidden = false;
    this.monthFlip.classList.remove('is-flipping');
    void this.monthFlip.offsetWidth;
    this.monthFlip.classList.add('is-flipping');
    Audio.sfx('stamp');
    window.clearTimeout(this.monthFlipTimer);
    this.monthFlipTimer = window.setTimeout(() => {
      this.monthFlip.hidden = true;
      this.monthFlip.classList.remove('is-flipping');
    }, 1050);
  }

  private async showDestinationRoulette(cityId: string, control: PlaybackControl): Promise<void> {
    const city = citiesById.get(cityId);
    if (!city || motionReduced()) {
      if (city) {
        this.rouletteName.textContent = city.nameJa;
        this.rouletteCountry.textContent = city.countryJa;
      }
      void Audio.playVoice('narrator', destinationNarration(city?.nameJa ?? cityId));
      await control.wait(280);
      return;
    }
    const candidates = GAME_DATA.cities
      .filter((candidate) => candidate.id !== cityId)
      .sort(() => Math.random() - 0.5)
      .slice(0, 12);
    this.rouletteOverlay.hidden = false;
    this.rouletteOverlay.classList.add('is-spinning');
    this.rouletteLandmark.hidden = true;
    const { promise, resolve } = Promise.withResolvers<void>();
    let stopped = false;
    let cursor = 0;
    const names = [...candidates.map((candidate) => candidate), city];
    const stampFor = (candidate: typeof city): string =>
      candidate.tier === 1 ? 'metropolis' : candidate.tier === 2 && candidate.port ? 'port_town' : 'town';
    const paint = (candidate: typeof city): void => {
      this.rouletteName.textContent = candidate.nameJa;
      this.rouletteCountry.textContent = `${candidate.countryJa} ・ ${candidate.nameEn}`;
      this.rouletteBadge.textContent = countryFlag(candidate.country);
      this.rouletteBadge.className = `roulette-city-badge tier-${Math.min(3, Math.max(1, candidate.tier))}`;
      this.rouletteBadge.dataset.stamp = stampFor(candidate);
    };
    paint(names[0]);
    const interval = window.setInterval(() => {
      cursor = (cursor + 1) % names.length;
      paint(names[cursor]);
      Audio.sfx('click');
    }, 70);
    this.rouletteInterval = interval;
    const finish = (skipped: boolean): void => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(interval);
      window.clearTimeout(this.rouletteTimer);
    this.clearCityPick();
      this.rouletteOverlay.classList.remove('is-spinning');
      this.rouletteOverlay.classList.add('is-result');
      paint(city);
      if (city.landmark && LANDMARK_FILES.has(city.landmark)) {
        this.rouletteLandmark.hidden = false;
        this.rouletteLandmark.src = assetUrl(`assets/landmarks/${city.landmark}.webp`);
      }
      Audio.sfx('stamp');
      void Audio.playVoice('narrator', destinationNarration(city.nameJa));
      if (skipped) Audio.stopVoice();
      resolve();
    };
    this.rouletteFinish = finish;
    control.onSkip(() => finish(true));
    this.rouletteTimer = window.setTimeout(() => finish(false), 1400);
    await promise;
    await control.wait(480);
    this.rouletteOverlay.hidden = true;
    this.rouletteOverlay.classList.remove('is-result');
    this.rouletteFinish = null;
  }

  private clearCityPick(): void {
    this.cityPick = null;
    this.cityPickBanner.hidden = true;
  }

  private openHand(): void {
    const state = this.state;
    const seat = this.privateSeat();
    if (!state || seat === null) return;
    const canUse =
      this.interactiveNow() && state.phase.t === 'turn_start' && seat === actorOf(state);
    const handle = openCardsDialog({
      modal: this.app.modal,
      state,
      seat,
      canAct: canUse,
      onUse: (cardId) => {
        handle?.close();
        this.sendAction({ t: 'use_card', cardId });
      },
    });
  }

  private openOwned(): void {
    const state = this.state;
    const seat = this.privateSeat();
    if (!state || seat === null) return;
    openOwnedDialog({ modal: this.app.modal, state, seat });
  }

  private openCatalog(): void {
    const state = this.state;
    const seat = this.privateSeat();
    if (!state) return;
    openPropertyCatalog({ modal: this.app.modal, state, seat: seat ?? 0 });
  }

  private openInfo(): void {
    const state = this.state;
    if (!state) return;
    openInfoDialog({ modal: this.app.modal, state, newsLog: this.newsLog, logs: this.logs });
  }

  private focusWorld(): void {
    this.map?.fitWorld(450);
  }

  private focusDestination(): void {
    if (!this.state) return;
    const nodeId = this.playerRealm !== 'world' ? portalNodeFor(this.playerRealm) : cityNodeId(this.state.destination);
    if (nodeId) this.map?.focusNode(nodeId, { zoom: 0.95, ms: 500 });
  }

  private openDestination(): void {
    const state = this.state;
    if (!state) return;
    if (this.playerRealm !== 'world') {
      const portalId = portalNodeFor(this.playerRealm);
      const actor = actorOf(state);
      const player = actor !== null ? state.players[actor] : undefined;
      const steps = player && portalId ? distance(GAME_DATA, player.nodeId, portalId) : 0;
      this.app.toasts.show(`出口まで ${steps} マス。竪琴…ではなく、出口を目指そう。`, 'info', 3200);
      this.focusDestination();
      return;
    }
    const cityId = state.destination;
    if (this.citySheet) return;
    this.citySheetCityId = cityId;
    this.citySheetBuyMode = false;
    this.citySheet = openCitySheet({
      modal: this.app.modal,
      cityId,
      state,
      buyMode: false,
      canAct: this.canActSeatNow(),
      onBuy: () => undefined,
      onEndBuy: () => undefined,
      onClose: () => {
        this.citySheet = null;
        this.citySheetCityId = null;
        this.citySheetBuyMode = false;
      },
    });
  }

  private onCityTap(cityId: string): void {
    const state = this.state;
    if (!state) return;
    if (!citiesById.has(cityId)) {
      this.app.toasts.show('この駅は開業準備中です', 'warn');
      return;
    }
    if (this.cityPick) {
      const nodeId = cityNodeId(cityId);
      if (this.cityPick.options.has(nodeId)) {
        this.clearCityPick();
        this.sendAction({ t: 'card_target', target: nodeId });
      } else {
        this.app.toasts.show('その都市は対象に選べません。光っている都市をタップしてください。', 'warn', 2600);
      }
      return;
    }
    if (state.phase.t === 'choose_dest' && this.interactiveNow()) {
      // Let the map's move-picker handle the tap; opening the sheet here would fight it.
      return;
    }
    if (state.phase.t === 'buy' && state.phase.cityId === cityId) return;
    if (this.citySheet) return;
    this.citySheetCityId = cityId;
    this.citySheetBuyMode = false;
    this.citySheet = openCitySheet({
      modal: this.app.modal,
      cityId,
      state,
      buyMode: false,
      canAct: this.canActSeatNow(),
      onBuy: () => undefined,
      onEndBuy: () => undefined,
      onClose: () => {
        this.citySheet = null;
        this.citySheetCityId = null;
        this.citySheetBuyMode = false;
      },
    });
  }

  private openSeatMenu(seat: number): void {
    const state = this.state;
    const playerId = this.playerIdOfSeat(seat);
    const player = playerId !== null ? state?.players[playerId] : undefined;
    const lobbySeat = this.lobby?.seats[seat];
    openPlayerMenu({
      modal: this.app.modal,
      toasts: this.app.toasts,
      session: this.session,
      seat,
      name: displayPlayerName(player) || lobbySeat?.name || `席 ${seat + 1}`,
      characterId: player?.characterId ?? lobbySeat?.characterId ?? null,
      color: player ? playerColor(player) : '#9fb3d9',
      canReport: this.session.mode === 'online' && seat !== this.mySeat && !!player && !player.isCpu,
      flagged: this.flaggedSeats.has(seat) || lobbySeat?.flagged === true,
      flags: { ...this.muteOf(seat) },
      onMute: (flags) => {
        this.muteCache.set(seat, flags);
        writeMute(this.session.roomId, seat, flags);
        this.chat.refresh();
        if (this.state) this.renderRanking(this.state, actorOf(this.state));
      },
    });
  }

  private openRoster(): void {
    const state = this.state;
    if (!state) return;
    const rows = this.playerViews(state);
    openPlayerRoster({
      modal: this.app.modal,
      title: 'プレイヤー',
      rows,
      onMenu: (playerId) => {
        const seat = this.seatOfPlayer(playerId);
        if (seat !== null) this.openSeatMenu(seat);
      },
    });
  }

  private openMenu(): void {
    const state = this.state;
    const body = h('div', { class: 'game-menu' });
    let handle: ModalHandle | null = null;
    const item = (icon: string, label: string, action: () => void, danger = false): HTMLElement =>
      h(
        'button',
        {
          class: `game-menu-item ${danger ? 'is-danger' : ''}`.trim(),
          attrs: { type: 'button' },
          on: {
            click: () => {
              handle?.close();
              action();
            },
          },
        },
        h('span', { class: 'game-menu-icon' }, uiIcon(icon, icon)),
        h('span', { text: label }),
        h('span', { class: 'game-menu-arrow', text: '▶', attrs: { 'aria-hidden': 'true' } }),
      );
    body.append(
      h('p', {
        class: 'game-menu-room',
        text: `モード: ${this.session.mode === 'local' ? 'ローカル' : 'オンライン'} ・ ルーム ${this.session.roomId}`,
      }),
      item('gear', '設定', () => this.app.openSettings()),
      item('help', '遊び方', () => this.app.openHelp()),
      item('trophy', 'クレジット', () => this.app.openCredits()),
      item('menu', this.session.mode === 'online' ? '退出してタイトルへ' : 'タイトルへ', () => this.confirmLeave(), true),
    );
    if (state?.phase.t === 'game_over') {
      body.append(item('trophy', '結果画面を表示', () => this.showResult(state)));
    }
    handle = this.app.modal.open(body, { title: '☰ メニュー', subtitle: 'ゲームを止めずに設定を変えられます' });
  }

  private confirmLeave(): void {
    const isOnline = this.session.mode === 'online';
    let handle: ModalHandle | null = null;
    const body = h(
      'div',
      { class: 'modal-copy confirm-dialog' },
      h('p', {
        text: isOnline
          ? '退出すると、あなたの席は CPU が引き継ぎます。よろしいですか？'
          : 'タイトルへ戻ります。ローカル対戦はこの端末に保存され、「つづきから」で再開できます。',
      }),
      h(
        'div',
        { class: 'confirm-actions' },
        h('button', {
          class: 'btn btn-ghost',
          text: 'つづける',
          attrs: { type: 'button' },
          on: { click: () => handle?.close() },
        }),
        h('button', {
          class: 'btn btn-red',
          text: isOnline ? '退出する' : 'タイトルへ',
          attrs: { type: 'button' },
          on: {
            click: () => {
              handle?.close();
              this.app.goTitle();
            },
          },
        }),
      ),
    );
    handle = this.app.modal.open(body, { title: isOnline ? '退出しますか？' : 'タイトルへ戻りますか？' });
  }

  private openEventPanel(eventId: string, state: PublicState): void {
    const event = eventsById.get(eventId);
    if (!event) return;
    const currentPlayer = state.players.find((player) => player.id === state.current);
    const playerName = displayPlayerName(currentPlayer);
    this.eventPanel.show(event, state, playerName);
    requestAnimationFrame(() => this.updateMapSafeArea());
    this.eventPanel.setState(state, this.interactiveNow());
    this.activeEventBgm = bgmForEvent(event);
    this.setBgm(this.activeEventBgm);
    this.recordNews(eventId, state);
  }

  private showResult(state: PublicState): void {
    if (this.resultScreen) return;
    this.timer.set({ deadline: null, totalSeconds: 0, isMine: false });
    this.eventPanel.hide();
    this.syncEventComm();
    requestAnimationFrame(() => this.updateMapSafeArea());
    this.citySheet?.close();
    this.citySheet = null;
    this.citySheetCityId = null;
    this.transient?.handle.close();
    this.transient = null;
    this.yearEnd?.close();
    this.yearEnd = null;
    this.resultScreen = new ResultScreen({
      state,
      mode: this.session.mode,
      isVoiceMuted: (playerId) => {
        const seat = this.seatOfPlayer(playerId);
        return seat !== null && this.muteOf(seat).voice;
      },
      skipEndingVoice: this.endedVoicePlayed,
      onTitle: () => this.app.goTitle(),
      onRematch: () => this.app.rematch(),
    });
    this.app.toasts.el.replaceChildren();
    document.body.append(this.resultScreen.el);
    this.setBgm('result');
    this.skipHint.hidden = true;
  }

  // ---------------------------------------------------------------- fx playback

  private async handleFx(fx: Fx, pending: PublicState, control: PlaybackControl): Promise<void> {
    this.clearSay();
    switch (fx.t) {
      case 'turn': {
        this.manualView = false;
        let handoff = false;
        if (this.session.mode === 'local' && this.myPlayerIds().length > 1 && this.myPlayerIds().includes(fx.playerId)) {
          if (this.lastHumanTurn !== null && this.lastHumanTurn !== fx.playerId) {
            this.showHandoff(fx.playerId);
            handoff = true;
          }
          this.lastHumanTurn = fx.playerId;
        }
        if (!handoff) this.showTurnBanner(fx.playerId, pending);
        this.setPortraitFor(fx.playerId, pending);
        this.map?.follow(fx.playerId);
        this.addLog(`▶ ${this.actorLabel(fx.playerId)} の番`);
        await control.wait(FX_MS.turn);
        return;
      }
      case 'dice': {
        Audio.sfx('dice_roll');
        if (fx.values.length > 1) {
          const vehicle = vehicleForDice(fx.values.length);
          this.showGameBanner(`${vehicle.emoji} ${vehicle.label}で出発！`);
        }
        const ms = FX_MS.dice / control.speed;
        control.onSkip(() => this.dice.skip());
        await this.dice.show(fx.values, ms);
        Audio.sfx('dice_land');
        return;
      }
      case 'move': {
        Audio.sfx('step');
        this.startStepsCounter(fx.path.length, FX_MS.moveStep / control.speed);
        await this.map?.animateMove(fx.playerId, fx.path, FX_MS.moveStep / control.speed, { dice: fx.dice ?? 1 });
        this.stopStepsCounter();
        return;
      }
      case 'warp': {
        const via = fx.via ?? 'event';
        Audio.sfx('event');
        if (via === 'tornado') {
          this.showGameBanner('🌪️ オズの竜巻に飛ばされた！');
          this.map?.shake(0.7);
        } else if (via === 'realm') {
          this.showGameBanner('🌀 異世界へ…');
        } else if (via === 'rocket') {
          this.showGameBanner('🚀 ロケットで宇宙へ！');
          this.map?.shake(0.6);
        } else if (via === 'plane') {
          this.showGameBanner('✈️ 飛行機でひとっ飛び！');
        } else if (via === 'carpet') {
          this.showGameBanner('🧞 魔法のじゅうたんで移動！');
        }
        await this.map?.warp(fx.playerId, fx.nodeId, via);
        return;
      }
      case 'cash': {
        const player = pending.players[fx.playerId];
        if (player) {
          this.map?.floatText(player.nodeId, formatDelta(fx.delta), fx.delta >= 0 ? '#8affb0' : '#ff8a8a');
        }
        Audio.sfx(fx.delta >= 0 ? 'coin_gain' : 'coin_loss');
        this.showCoinFlow(fx.playerId, fx.delta);
        if (fx.delta > 0) {
          this.portraitMood('joy', fx.playerId);
          this.portraitMotion('jump');
          this.map?.celebrate(fx.playerId, 'buy');
        } else if (fx.delta < 0) {
          this.portraitMood('sad', fx.playerId);
          this.portraitMotion('shake');
          this.map?.shake(0.25);
        }
        this.addLog(`${this.playerName(fx.playerId)} ${formatDelta(fx.delta)}（${fx.reason}）`);
        await control.wait(FX_MS.cash);
        return;
      }
      case 'buy': {
        Audio.sfx('buy');
        this.portraitMood('joy', fx.playerId);
        this.portraitMotion('jump');
        this.map?.setMood(fx.playerId, 'joy', 6000);
        this.map?.celebrate(fx.playerId, fx.monopoly ? 'monopoly' : 'buy');
        if (fx.monopoly) {
          Audio.sfx('monopoly');
          this.showGameBanner(`${this.playerName(fx.playerId)} が都市を独占！ 収益 2 倍`);
          this.confetti(14);
        }
        this.addLog(`${this.playerName(fx.playerId)} が物件を購入${fx.monopoly ? '（独占！）' : ''}`);
        await control.wait(FX_MS.buy);
        return;
      }
      case 'sell': {
        Audio.sfx('coin_loss');
        this.portraitMood('sad', fx.playerId);
        this.portraitMotion('shake');
        this.map?.setMood(fx.playerId, 'sad', 6000);
        this.map?.shake(0.3);
        this.addLog(`${this.playerName(fx.playerId)} が物件を ${formatOku(fx.amount)} で売却`);
        await control.wait(FX_MS.sell);
        return;
      }
      case 'card_get': {
        const card = GAME_DATA.cards.find((c) => c.id === fx.cardId);
        Audio.sfx('card_get');
        if (card) this.showCardFlash(card, 'draw');
        this.app.toasts.show(`🃏 カード獲得: ${card?.name ?? fx.cardId}`, 'good');
        this.addLog(`🃏 ${this.playerName(fx.playerId)} が ${card?.name ?? fx.cardId} を獲得`);
        await control.wait(FX_MS.card_get);
        return;
      }
      case 'card_use': {
        const card = GAME_DATA.cards.find((c) => c.id === fx.cardId);
        Audio.sfx('card_use');
        if (card) this.showCardFlash(card, 'use');
        const departure = cardDepartureText(fx.cardId);
        this.showGameBanner(`🃏 ${departure ?? `${card?.name ?? fx.cardId} 発動！`}`);
        this.addLog(`🃏 ${this.playerName(fx.playerId)} が ${card?.name ?? fx.cardId} を使用`);
        await control.wait(FX_MS.card_use);
        return;
      }
      case 'say': {
        await this.playSay(fx, pending, control);
        return;
      }
      case 'event_open': {
        this.openEventPanel(fx.eventId, pending);
        await control.wait(FX_MS.event_open);
        return;
      }
      case 'event_close': {
        this.eventPanel.hide();
        this.syncEventComm();
        this.activeEventBgm = null;
        this.updateBgm();
        await control.wait(FX_MS.event_close);
        return;
      }
      case 'goal': {
        const city = citiesById.get(fx.cityId);
        Audio.sfx('goal_fanfare');
        this.portraitMood('joy', fx.playerId);
        this.portraitMotion('jump');
        this.map?.celebrate(fx.playerId, 'goal');
        this.map?.setMood(fx.playerId, 'joy', 6000);
        this.confetti(22);
        this.map?.focusNode(cityNodeId(fx.cityId), { zoom: 1.1, ms: 600 });
        this.map?.floatText(cityNodeId(fx.cityId), `+${formatOkuShort(fx.bonus)}`, '#ffd23f');
        this.app.toasts.show(`🎯 ${this.playerName(fx.playerId)} が ${city?.nameJa ?? fx.cityId} に一番乗り！ +${formatOku(fx.bonus)}`, 'good', 3400);
        this.addLog(`🎯 ${this.playerName(fx.playerId)} が ${city?.nameJa ?? fx.cityId} に一番乗り`);
        await control.wait(FX_MS.goal);
        return;
      }
      case 'destination': {
        const city = citiesById.get(fx.cityId);
        await this.showDestinationRoulette(fx.cityId, control);
        if (this.playerRealm === 'world') this.map?.focusNode(cityNodeId(fx.cityId), { zoom: 0.8, ms: 700 });
        this.showGameBanner(`🎯 次の目的地は ${city?.nameJa ?? fx.cityId}！`);
        this.addLog(`🎯 目的地が ${city?.nameJa ?? fx.cityId} に決定`);
        await control.wait(260);
        return;
      }
      case 'piper': {
        Audio.sfx('piper');
        if (fx.holder !== null) {
          this.portraitMood('sad', fx.holder);
          this.portraitMotion('shake');
          this.map?.setMood(fx.holder, 'sad', 7000);
          this.map?.shake(0.45);
        }
        this.app.toasts.show(fx.message, 'warn', 3800);
        if (fx.holder !== null) this.map?.bubble(fx.holder, fx.message, 4200);
        this.addLog(`🎺 ${fx.message}`);
        await control.wait(FX_MS.piper);
        return;
      }
      case 'industry': {
        Audio.sfx('event');
        this.showGameBanner(`${fx.label}: 収益 ×${fx.mult.toFixed(2)}`);
        this.addLog(`📈 ${fx.label} 収益 ×${fx.mult.toFixed(2)}`);
        await control.wait(FX_MS.industry);
        return;
      }
      case 'skip': {
        Audio.sfx('bad');
        this.app.toasts.show(`${this.playerName(fx.playerId)} は 1 回休み`, 'warn');
        this.map?.bubble(fx.playerId, '1回休み…', 3000);
        this.addLog(`${this.playerName(fx.playerId)} は 1 回休み`);
        await control.wait(FX_MS.skip);
        return;
      }
      case 'month': {
        this.yearChip.textContent = `${fx.year}年目 ${fx.month}月`;
        this.showMonthFlip(fx.year, fx.month);
        await control.wait(Math.max(FX_MS.month, 620));
        return;
      }
      case 'year_end': {
        Audio.sfx('year_end');
        this.setBgm('yearend');
        await control.wait(FX_MS.year_end);
        return;
      }
      case 'game_over': {
        this.setBgm('result');
        await control.wait(FX_MS.game_over);
        return;
      }
      case 'toast': {
        this.app.toasts.show(fx.text, 'info', 3200);
        this.addLog(fx.text);
        await control.wait(FX_MS.toast);
        return;
      }
      default:
        return;
    }
  }

  private async playSay(
    fx: Extract<Fx, { t: 'say' }>,
    state: PublicState,
    control: PlaybackControl,
  ): Promise<void> {
    const speaker = fx.speaker;
    const speakerSeat = this.speakerSeat(speaker, fx.playerId, state);
    const character = speakerSeat !== null ? charsById.get(state.players[speakerSeat]?.characterId ?? '') : undefined;
    const speakerCharId =
      speaker === 'self'
        ? state.players[speakerSeat ?? state.current]?.characterId ?? null
        : speaker.startsWith('char:')
          ? speaker.slice(5)
          : null;
    const displayName =
      speaker === 'self'
        ? state.players[speakerSeat ?? state.current]?.name ?? '手番'
        : speakerName(speaker);
    const label = speaker === 'self' ? `${displayName}` : speakerName(speaker);
    this.showSayBubble(label, fx.text);
    if (this.eventPanel.isOpen) this.eventPanel.setSpeaker(speaker, fx.text);
    if (speakerSeat !== null && speaker !== 'narrator') {
      this.map?.bubble(speakerSeat, fx.text, 4200);
    }
    const where = character ? `（${character.nameJa}）` : '';
    this.portraitMotion('talk');
    if (fx.lineKey === 'blue' || fx.lineKey === 'buy' || fx.lineKey === 'monopoly' || fx.lineKey === 'goal' || fx.lineKey === 'card') {
      this.portraitMood('joy', speakerSeat ?? undefined);
    } else if (fx.lineKey === 'red' || fx.lineKey === 'piper_hit' || fx.lineKey === 'piper_get' || fx.lineKey === 'lose') {
      this.portraitMood('sad', speakerSeat ?? undefined);
    }
    this.addLog(`🗣️ ${label}${where}: ${fx.text}`);
    if (fx.lineKey === 'win' || fx.lineKey === 'lose') this.endedVoicePlayed = true;

    const voiceKey: string =
      speaker === 'self'
        ? voiceKeyOf('self', speakerCharId ?? undefined)
        : voiceKeyOf(speaker);
    const speakerLobbySeat = speakerSeat !== null ? this.seatOfPlayer(speakerSeat) : null;
    const muted = speakerLobbySeat !== null && this.muteOf(speakerLobbySeat).voice;
    const duration = FX_MS.sayBase + FX_MS.sayPerChar * [...fx.text].length;
    const stopVoice = () => Audio.stopVoice();
    control.onSkip(stopVoice);
    let voicePromise: Promise<void> = Promise.resolve();
    if (!muted) {
      voicePromise = Audio.playVoice(voiceKey, fx.text);
    }
    const advance = uiSettings().autoAdvance ? control.wait(duration) : control.waitManual();
    await Promise.all([voicePromise, advance]);
  }

  private speakerSeat(speaker: SpeakerRef, playerId: number | undefined, state: PublicState): number | null {
    if (speaker === 'self') return playerId ?? state.current;
    if (speaker.startsWith('char:')) {
      const characterId = speaker.slice(5);
      return state.players.find((player) => player.characterId === characterId)?.id ?? null;
    }
    return null;
  }

  private showSayBubble(name: string, text: string): void {
    this.sayBubble.hidden = false;
    this.sayBubbleName.textContent = name;
    this.sayBubbleText.textContent = text;
    this.subtitleBar.hidden = false;
    this.subtitleName.textContent = name;
    this.subtitleText.textContent = text;
    window.clearTimeout(this.sayTimer);
    this.sayTimer = window.setTimeout(() => this.clearSay(), Math.min(9000, 1600 + text.length * 110));
  }

  private clearSay(): void {
    window.clearTimeout(this.sayTimer);
    this.sayBubble.hidden = true;
    this.subtitleBar.hidden = true;
  }

  private setPortraitFor(playerId: number, state: PublicState): void {
    const player = state.players[playerId];
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!character) return;
    const base = characterSprite(character);
    this.portraitBaseSrc = base;
    if (!this.portraitImage.classList.contains('is-mood')) this.portraitImage.src = base;
    this.portraitImage.alt = character.nameJa;
    this.portraitName.textContent = displayPlayerName(player);
    this.portraitSub.textContent = `${character.nameJa} ・ ${character.origin}`;
    this.portraitHost.dataset.seat = String(playerId);
  }

  // ---------------------------------------------------------------- emotes

  private enqueueEmote(event: EmoteEvent): void {
    if (this.muteOf(event.seat).emote) return;
    if (this.emoteQueue.length >= 2) this.emoteQueue.shift();
    this.emoteQueue.push(event);
    void this.pumpEmotes();
  }

  private async pumpEmotes(): Promise<void> {
    if (this.emotePlaying) return;
    this.emotePlaying = true;
    while (this.emoteQueue.length > 0) {
      const event = this.emoteQueue.shift();
      if (!event) break;
      await this.playEmote(event);
    }
    this.emotePlaying = false;
  }

  private async playEmote(event: EmoteEvent): Promise<void> {
    const state = this.state;
    if (!state) return;
    const def = emotesById.get(event.emoteId);
    const speakerPlayerId = this.playerIdOfSeat(event.seat);
    const targetPlayerId = event.target !== null ? this.playerIdOfSeat(event.target) : null;
    if (speakerPlayerId === null) return;
    const speaker = state.players[speakerPlayerId];
    const victim = targetPlayerId !== null ? state.players[targetPlayerId] : undefined;
    if (!def || !speaker) return;
    const speakerChar = speaker.characterId;
    const victimChar = victim?.characterId ?? null;
    const lines = resolveEmoteLines(def, speakerChar, victimChar);
    this.map?.bubble(speakerPlayerId, lines.speaker, 3000);
    Audio.sfx('emote_pop');
    const anim = this.map?.playEmote(speakerPlayerId, def, targetPlayerId) ?? Promise.resolve();
    void playEmoteVoice(lines, (characterId) => {
      if (characterId === speakerChar) return this.muteOf(event.seat).voice;
      if (event.target !== null && characterId === victimChar) return this.muteOf(event.target).voice;
      return false;
    });
    if (targetPlayerId !== null && lines.hit) {
      const hitText = lines.hit;
      window.setTimeout(() => {
        this.map?.bubble(targetPlayerId, hitText, 2600);
        Audio.sfx('hit');
      }, 650);
    }
    await anim.catch(() => undefined);
  }

  // ---------------------------------------------------------------- chat bubbles & helpers

  private showRankBubble(playerId: number, text: string): void {
    if (!uiSettings().showChat) return;
    this.rankBubbles.set(playerId, { text, expires: Date.now() + 4000 });
    if (this.state) this.renderRanking(this.state, actorOf(this.state));
    window.setTimeout(() => {
      const entry = this.rankBubbles.get(playerId);
      if (entry && entry.expires <= Date.now()) {
        this.rankBubbles.delete(playerId);
        if (this.state) this.renderRanking(this.state, actorOf(this.state));
      }
    }, 4100);
  }

  private showGameBanner(text: string): void {
    this.gameBanner.textContent = text;
    this.gameBanner.hidden = false;
    this.gameBanner.classList.add('is-visible');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.gameBanner.hidden = true;
      this.gameBanner.classList.remove('is-visible');
    }, 4200);
  }

  private showTurnBanner(playerId: number, state: PublicState): void {
    const player = state.players[playerId];
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!player || !character) return;
    this.turnBannerAvatar.replaceChildren(
      h('img', { attrs: { src: characterSprite(character), alt: '', draggable: 'false' } }),
    );
    this.turnBannerName.textContent = player.isCpu ? character.nameJa : player.name;
    this.turnBannerSub.textContent = 'のターン！';
    this.turnBanner.style.setProperty('--seat-color', seatColor(playerId));
    this.turnBanner.hidden = false;
    this.turnBanner.classList.remove('is-showing');
    void this.turnBanner.offsetWidth;
    this.turnBanner.classList.add('is-showing');
    window.clearTimeout(this.turnBannerTimer);
    this.turnBannerTimer = window.setTimeout(() => {
      this.turnBanner.hidden = true;
      this.turnBanner.classList.remove('is-showing');
    }, 1300);
  }

  private startStepsCounter(total: number, stepMs: number): void {
    this.stopStepsCounter();
    let remaining = total;
    this.stepsCounter.hidden = false;
    this.el.classList.add('is-moving');
    this.stepsCounter.innerHTML = `<span class="steps-label">移動 あと</span><strong class="steps-value">${remaining}</strong><span class="steps-unit">マス</span>`;
    const tick = (): void => {
      remaining = Math.max(0, remaining - 1);
      const value = this.stepsCounter.querySelector('.steps-value');
      if (value) {
        value.textContent = String(remaining);
        value.classList.add('is-pop');
        window.setTimeout(() => value.classList.remove('is-pop'), 180);
      }
      if (remaining <= 0) this.stopStepsCounter();
    };
    this.stepsTimer = window.setInterval(tick, Math.max(90, stepMs));
  }

  private stopStepsCounter(): void {
    window.clearInterval(this.stepsTimer);
    this.stepsTimer = 0;
    this.stepsCounter.hidden = true;
    this.el.classList.remove('is-moving');
  }

  private showHandoff(playerId: number): void {
    const state = this.state;
    const player = state?.players[playerId];
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!player || !character) return;
    this.handoffName.textContent = `${displayPlayerName(player)} の番です`;
    this.handoffAvatar.replaceChildren(
      h('img', { attrs: { src: characterSprite(character), alt: '', draggable: 'false' } }),
    );
    this.handoff.hidden = false;
    window.clearTimeout(this.handoffTimer);
    window.clearTimeout(this.portraitVariantTimer);
    window.clearTimeout(this.turnBannerTimer);
    window.clearTimeout(this.monthFlipTimer);
    window.clearTimeout(this.stepsTimer);
    window.clearTimeout(this.rouletteTimer);
    this.clearCityPick();
    window.clearInterval(this.rouletteInterval);
    this.rouletteFinish?.(true);
    this.handoffTimer = window.setTimeout(() => {
      this.handoff.hidden = true;
    }, 2200);
  }

  private addLog(text: string): void {
    this.logs.push(text);
    while (this.logs.length > 100) this.logs.shift();
  }

  private recordNews(eventId: string, state: PublicState): void {
    const last = this.newsLog[this.newsLog.length - 1];
    if (last && last.eventId === eventId && last.year === state.year && last.month === state.month) return;
    this.newsLog.push({ eventId, year: state.year, month: state.month });
    while (this.newsLog.length > 30) this.newsLog.shift();
  }

  private playerViews(state: PublicState): PlayerView[] {
    const order = [...state.players].sort((a, b) => {
      const diff = netWorth(GAME_DATA, state, b.id) - netWorth(GAME_DATA, state, a.id);
      return diff !== 0 ? diff : a.id - b.id;
    });
    const actor = actorOf(state);
    return order.map((player, index) => {
      const character = charsById.get(player.characterId);
      const lobbySeat = this.lobby?.seats[this.seatOfPlayer(player.id) ?? -1];
      const cash = player.cash;
      return {
        seat: player.id,
        name: displayPlayerName(player),
        characterId: player.characterId,
        color: character?.color ?? playerColor(player),
        cash,
        income: annualIncome(GAME_DATA, state, player.id),
        net: netWorth(GAME_DATA, state, player.id),
        rank: index + 1,
        isCurrent: player.id === actor,
        isCpu: player.isCpu,
        flagged: this.flaggedSeats.has(this.seatOfPlayer(player.id) ?? -1),
        connected: lobbySeat?.kind === 'human' ? lobbySeat.connected : null,
        autoplay: lobbySeat?.autoplay ?? false,
        piperLevel: state.piper.holder === player.id ? state.piper.level : null,
        cashText: formatOku(cash),
        incomeText: `${formatOkuShort(Math.round(annualIncome(GAME_DATA, state, player.id)))}`,
        netText: formatOku(netWorth(GAME_DATA, state, player.id)),
        negativeCash: cash < 0,
      };
    });
  }

  private chatSeatInfo(seat: number) {
    const playerId = this.playerIdOfSeat(seat);
    const player = playerId !== null ? this.state?.players[playerId] : undefined;
    const lobbySeat = this.lobby?.seats[seat];
    const character = player ? charsById.get(player.characterId) : lobbySeat?.characterId ? charsById.get(lobbySeat.characterId) : undefined;
    return {
      name: displayPlayerName(player) || lobbySeat?.name || `席 ${seat + 1}`,
      characterId: player?.characterId ?? lobbySeat?.characterId ?? null,
      color: character?.color ?? '#9fb3d9',
    };
  }

  private playerInfo(playerId: number) {
    const player = this.state?.players[playerId];
    const seat = this.seatOfPlayer(playerId);
    const lobbySeat = seat !== null ? this.lobby?.seats[seat] : undefined;
    const character = player ? charsById.get(player.characterId) : lobbySeat?.characterId ? charsById.get(lobbySeat.characterId) : undefined;
    return {
      name: displayPlayerName(player) || lobbySeat?.name || `プレイヤー${playerId + 1}`,
      characterId: player?.characterId ?? lobbySeat?.characterId ?? null,
      color: character?.color ?? '#9fb3d9',
    };
  }

  private playerName(playerId: number): string {
    const player = this.state?.players[playerId];
    return displayPlayerName(player) || `プレイヤー${playerId + 1}`;
  }

  private actorLabel(playerId: number): string {
    const player = this.state?.players[playerId];
    if (!player) return `プレイヤー${playerId + 1}`;
    return `${displayPlayerName(player)}${player.isCpu ? '（CPU）' : ''}`;
  }

  private myPlayerIds(): number[] {
    return myPlayerIds(this.session);
  }

  private playerIdOfSeat(seat: number): number | null {
    return seatToPlayer(this.session, seat);
  }

  private seatOfPlayer(playerId: number): number | null {
    return playerToSeat(this.session, playerId);
  }

  private privateSeat(): number | null {
    const state = this.state;
    const mine = this.myPlayerIds();
    if (!state) return mine[0] ?? null;
    if (this.session.mode === 'online') {
      const myId = mine[0] ?? null;
      return myId !== null && state.players[myId] ? myId : actorOf(state);
    }
    const actor = actorOf(state);
    if (actor !== null && mine.includes(actor)) return actor;
    return mine[0] ?? actor;
  }

  private displaySeat(): number | null {
    const state = this.state;
    const mine = this.myPlayerIds();
    if (!state) return mine[0] ?? null;
    if (this.session.mode === 'online') {
      const myId = mine[0] ?? null;
      return myId !== null && state.players[myId] ? myId : actorOf(state);
    }
    return actorOf(state) ?? mine[0] ?? null;
  }

  private emotePlayer(): number | null {
    const state = this.state;
    const mine = this.myPlayerIds();
    if (!state) return mine[0] ?? null;
    if (this.session.mode === 'online') return mine[0] ?? null;
    const actor = actorOf(state);
    if (actor !== null && mine.includes(actor)) return actor;
    return mine[0] ?? null;
  }

  private muteOf(seat: number): MuteFlags {
    if (this.flaggedSeats.has(seat)) return { chat: true, emote: true, voice: true };
    const cached = this.muteCache.get(seat);
    if (cached) return cached;
    const flags = readMute(this.session.roomId, seat);
    this.muteCache.set(seat, flags);
    return flags;
  }

  private syncFlaggedSeats(): void {
    const seats = this.lobby?.seats;
    if (!seats) return;
    this.flaggedSeats = new Set(seats.filter((seat) => seat.flagged === true).map((seat) => seat.index));
  }

  private renderConnections(): void {
    if (this.state) this.renderRanking(this.state, actorOf(this.state));
  }

  private updateBgm(): void {
    if (!this.state) return;
    if (this.resultScreen || this.state.phase.t === 'game_over') this.setBgm('result');
    else if (this.yearEnd) this.setBgm('yearend');
    else if (this.eventPanel.isOpen && this.activeEventBgm) this.setBgm(this.activeEventBgm);
    else if (this.viewRealm !== 'world') this.setBgm(REALMS[this.viewRealm].bgm as BgmName);
    else this.setBgm(boardTrack(this.state.year));
  }

  private setBgm(name: BgmName): void {
    if (this.currentBgm === name) return;
    this.currentBgm = name;
    Audio.bgm(name);
  }

  private renderConnection(connection: ConnectionState): void {
    if (connection === 'open') {
      this.connBanner.hidden = true;
      this.connAction.hidden = true;
      return;
    }
    this.connBanner.hidden = false;
    this.connBanner.dataset.state = connection;
    if (connection === 'reconnecting') {
      this.connText.textContent = '再接続しています…（操作は自動で復帰します）';
      this.connAction.hidden = true;
    } else if (connection === 'connecting') {
      this.connText.textContent = '接続しています…';
      this.connAction.hidden = true;
    } else {
      this.connText.textContent = '接続が切れました。席に戻るには再読み込みしてください。';
      this.connAction.hidden = false;
    }
  }

  // ---------------------------------------------------------------- input

  private bindClickToSkip(): void {
    this.el.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.fxBusy) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest('button, a, input, textarea, select, .modal-panel, .chat-panel, .emote-palette, .comm-fab')) return;
        event.stopPropagation();
        this.fxPlayer.skip();
      },
      true,
    );
  }

  private bindKeyboard(): void {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const inText = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === 'Escape') {
        if (this.app.modal.isOpen()) return;
        if (this.emotes.isOpen) {
          this.emotes.close();
          event.preventDefault();
          return;
        }
        if (this.chat.isOpen) {
          this.chat.close();
          event.preventDefault();
        }
        return;
      }
      if (inText) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('button, a, [role="button"], input, textarea, select, .modal-panel, .chat-panel, .emote-palette')) return;
      if (this.app.modal.isOpen()) return;
      if (this.fxBusy && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        this.fxPlayer.skip();
        return;
      }
      if (this.eventPanel.isOpen && /^[1-3]$/.test(event.key)) {
        const buttons = this.eventPanel.el.querySelectorAll<HTMLButtonElement>('.event-choice:not(:disabled)');
        const button = buttons[Number(event.key) - 1];
        if (button) {
          event.preventDefault();
          button.click();
        }
        return;
      }
      if ((event.key === ' ' || event.key === 'Enter') && !this.primary.disabled) {
        event.preventDefault();
        this.primary.click();
      }
    };
    document.addEventListener('keydown', onKey);
    this.unsubscribeFns.push(() => document.removeEventListener('keydown', onKey));
  }
}

function boardTrack(year: number): BgmName {
  if (year <= 1) return 'board_a';
  if (year <= 3) return 'board_b';
  return 'board_c';
}

function squareIcon(nodeId: string): string {
  const node = nodesById.get(nodeId);
  if (!node) return '•';
  if (node.kind === 'city') return '🏙️';
  if (node.kind === 'blue') return '💎';
  if (node.kind === 'red') return '🔥';
  if (node.kind === 'yellow') return '🃏';
  if (node.kind === 'shop') return '🛒';
  if (node.kind === 'warp') return '🌪️';
  return '📰';
}

function portalNodeFor(realm: RealmId | 'world'): string | undefined {
  if (realm === 'world') return undefined;
  return GAME_DATA.board.nodes.find((node) => node.realm === realm && node.kind === 'portal')?.id;
}


function monthSeason(month: number): { icon: string; label: string } {
  if (month >= 4 && month <= 5) return { icon: '🌸', label: '春' };
  if (month >= 6 && month <= 8) return { icon: '🌻', label: '夏' };
  if (month >= 9 && month <= 11) return { icon: '🍁', label: '秋' };
  return { icon: '⛄', label: '冬' };
}
