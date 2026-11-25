import { Audio, bgmForEvent, voiceKeyOf, type BgmName } from '../../audio/audio';
import { destination as destinationNarration } from '../../audio/narration';
import {  actorOf, annualIncome, distance, netWorth, type PublicState } from '../../core/engine';
import { REALMS } from '../../core/realm';
import { wrapDx } from '../../core/geo';
import type {Action, Fx, MoveOption, RealmId, SpeakerRef} from '../../core/types';
import { GAME_DATA } from '../../data/index';
import type { EmoteEvent, LobbyView, ServerMsg } from '../../net/protocol';
import { FX_MS, type ConnectionState, type Session } from '../../net/session-types';
import { MapView, moveKindChip, type SquareInspectEvent } from '../../render/map';
import { loadMapAssets, type AssetProgress } from '../../render/assets';
import {
  assetUrl,
  characterSprite,
  charsById,
  displayPlayerName,
  citiesById,
  cityNodeId,
  cityOfNode,
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
  propertiesById,
  realmLabel,
  realmOfNode,
  transportSummary,
  REALM_ICON,
  seatColor,
  speakerName,
  speakerSprite,
} from '../format';
import { avatar, h, iconButton, uiIcon, type ModalHandle } from '../dom';
import { rubyName } from '../ruby';
import { fitTextOneLine } from '../fitText';
import { placeDestinationArrow } from '../destArrow';
import { effectiveUiSettings, uiSettings, readMute, writeMute, type MuteFlags } from '../settings';
import { isIdenticalResync, type ResyncWatermark } from '../resync';
import { raceWithTimeout, voiceBudgetMs, voicePlaybackRate } from '../../audio/voiceBudget';
import { ChatPanel } from '../components/chatPanel';
import { EmotePalette } from '../components/emotePalette';
import { DiceOverlay } from '../components/diceOverlay';
import { PiperShow } from '../components/piperShow';
import { SkillCutin, openSkillCommand, openSkillTargetDialog } from '../components/skillCutin';
import { PIPER_FORMS } from '../../core/piperLines';
import { TurnTimer } from '../components/turnTimer';
import { EventPanel } from '../components/eventPanel';
import { MessageWindow } from '../components/messageWindow';
import { CitySheetHandle, openCitySheet, planBulkPurchase } from '../components/citySheet';
import { openCardsDialog } from '../components/cardsDialog';
import { openOwnedDialog } from '../components/ownedDialog';
import { openPropertyCatalog } from '../components/propertyCatalog';
import { openInfoDialog, type NewsLogEntry } from '../components/infoDialog';
import { openSquareLegendDialog } from '../components/squareLegend';
import { openYearEndDialog, type YearEndHandle } from '../components/yearEndDialog';
import { openShopDialog, type ShopHandle } from '../components/shopDialog';
import { showFinalYearBanner, type FinalYearBannerHandle } from '../components/finalYearBanner';
import { canUseUnderdog, finalYearNarration, isFinalYearActive } from '../../core/showdown';
import { describeBoardNode, squareInfoOf, squareTileUrl, tileThumb } from '../squareInfo';
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
import { isRoutineCpuSay } from '../cpuPacing';
import { biasedMoveRecommendation, cityMoveInfo, moveChipPriceLabel, type CityMoveInfo } from '../moveChipInfo';
import type { App } from '../app';
import type { ScreenHandle } from './types';

export interface GameScreenOptions {
  app: App;
  session: Session;
}

type TransientKind = 'target' | 'skill' | 'discard' | 'sell';

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

/** 背景色が明るいマス種（番号の文字を濃色にする）。moveKindChip の色と対応。 */
const LIGHT_KIND_COLORS = new Set(['#ffc72f', '#ffa63d', '#ffd84a']);

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
  private latestGen = 0;
  private appliedGen = -1;
  private appliedWatermark: ResyncWatermark | null = null;
  private lastDestinationBannerAt = 0;
  private mapReady = false;
  private readonly pendingMessages: ServerMsg[] = [];
  private deadline: number | null = null;
  private latestDeadline: number | null = null;
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
  private readonly piperShow: PiperShow;
  private readonly skillCutin: SkillCutin;
  private skillButton: HTMLButtonElement | null = null;
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
  private bulkBuyQueue: string[] = [];
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
  private bannerTimer = 0;
  private handoffTimer = 0;
  private overviewTimer = 0;
  private emoteQueue: EmoteEvent[] = [];
  private emotePlaying = false;
  private endedVoicePlayed = false;
  private transientMsgPending = false;
  private suppressMapTapUntil = 0;
  private pendingPhaseEnd: 'end_buy' | 'end_shop' | null = null;
  private handoffResolve: (() => void) | null = null;
  private moveOnlyCities = false;

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
  private readonly msgWindow: MessageWindow;
  private readonly moneyHost: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly primaryIcon: HTMLElement;
  private readonly primaryLabel: HTMLElement;
  private readonly primaryKeyHint: HTMLElement;
  private readonly moveOptionsHost: HTMLElement;
  private readonly cardBadge: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly miniMapCanvas: HTMLCanvasElement;
  private readonly recenterButton: HTMLButtonElement;
  private readonly overviewBanner: HTMLButtonElement;
  private readonly mapButton: HTMLButtonElement;
  private readonly pcRankingSlot: HTMLElement;
  private readonly pcCommFab: HTMLButtonElement;
  private readonly pcCommBadge: HTMLElement;
  private readonly pcCommDrawer: HTMLElement;
  private readonly pcCommTabChat: HTMLButtonElement;
  private readonly pcCommTabEmote: HTMLButtonElement;
  private readonly pcCommBody: HTMLElement;
  private pcCommTab: 'chat' | 'emote' = 'chat';
  private pcCommUnread = 0;
  private readonly squareInspectCard: HTMLElement;
  private moveSelection: string | null = null;
  private moveOptionsKey = '';
  private moveOptionsCache: MoveOption[] = [];
  /** 目的地（異世界では出口）までの残りホップ数（候補ノードID → 距離、不明は null）。 */
  private moveRemain = new Map<string, number | null>();
  /** 距離の向き先。異世界では最寄りの出口。 */
  private moveRemainTarget: 'destination' | 'exit' = 'destination';
  /** 駅チップの価格・所有者情報（候補ノードID → 情報）。候補か所持金が変わったときだけ作り直す。 */
  private moveChipInfoCache = new Map<string, CityMoveInfo>();
  private recommendedMoveNodeId: string | null = null;
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
  private readonly handoffBackdrop: HTMLElement;
  private readonly handoff: HTMLElement;
  private readonly handoffName: HTMLElement;
  private readonly handoffAvatar: HTMLElement;
  private readonly handoffStartBtn: HTMLButtonElement;
  private readonly skipHint: HTMLElement;
  private readonly commDock: HTMLElement;
  private readonly commMergedButton: HTMLButtonElement;
  private commChooser: HTMLElement | null = null;
  private commChooserOutside: ((event: PointerEvent) => void) | null = null;
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
  private readonly playerPlateDest: HTMLElement;
  private readonly playerPlateDestName: HTMLElement;
  private readonly playerPlateDestSteps: HTMLElement;
  private readonly realmChip: HTMLButtonElement;
  private readonly finalYearChip: HTMLElement;
  private finalYearBanner: FinalYearBannerHandle | null = null;
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
    this.playerPlateDestName = h('span', { class: 'player-plate-dest-name', text: '目的地' });
    this.playerPlateDestSteps = h('span', { class: 'player-plate-dest-steps', text: 'あと—マス' });
    this.playerPlateDest = h(
      'span',
      { class: 'player-plate-dest' },
      h('span', { class: 'player-plate-dest-icon', text: '🎯', attrs: { 'aria-hidden': 'true' } }),
      this.playerPlateDestName,
      this.playerPlateDestSteps,
    );
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
      this.playerPlateDest,
    );
    this.realmChip = h(
      'button',
      { class: 'chip realm-chip', attrs: { type: 'button', hidden: 'hidden' }, on: { click: () => this.openMapViewDialog() } },
    );
    this.finalYearChip = h(
      'span',
      {
        class: 'chip chip-final-year',
        attrs: { hidden: 'hidden', 'aria-live': 'polite' },
      },
      h('span', { text: '🔥', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'final-year-chip-text', text: '最終年！目的地ボーナス×2' }),
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
      h('span', { text: '手番のコマへ戻る' }),
    );
    this.overviewBanner = h(
      'button',
      {
        class: 'map-overview-banner',
        attrs: {
          type: 'button',
          hidden: 'hidden',
          'aria-label': '全体地図を表示中。タップで手番のコマへ拡大',
        },
        on: { click: () => this.recenterOnActor() },
      },
      h('span', { class: 'map-overview-banner-icon', text: '🌍', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: '全体地図 ・ タップで拡大' }),
    );

    this.pcRankingSlot = h('div', { class: 'pc-topbar-ranking' });
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
      h('div', { class: 'game-chips' }, this.yearChip, this.finalYearChip, this.statusChip, this.destChip, this.stepsCounter, this.turnChip, this.realmChip),
      this.timerHost,
      this.pcRankingSlot,
      h(
        'div',
        { class: 'top-actions' },
        iconButton('menu', 'メニュー', () => this.openMenu(), { class: 'top-action top-action-menu' }),
        iconButton('gear', '設定', () => this.app.openSettings(), { class: 'top-action top-action-secondary' }),
        iconButton('help', 'ヘルプ', () => this.app.openHelp(), { class: 'top-action top-action-secondary' }),
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
    this.portraitHost = h(
      'div',
      { class: 'portrait-area', attrs: { 'aria-hidden': 'true' } },
      this.portraitImage,
      this.portraitRank,
      h('div', { class: 'portrait-caption' }, this.portraitName, this.portraitSub),
    );
    this.msgWindow = new MessageWindow({
      speed: () => effectiveUiSettings().fxSpeed,
      onStateChange: () => this.syncMessageWindowLayer(),
    });

    this.primaryIcon = h('span', { class: 'primary-icon', text: '▶', attrs: { 'aria-hidden': 'true' } });
    this.primaryLabel = h('span', { class: 'primary-label', text: 'サイコロをふる' });
    this.primaryKeyHint = h('kbd', { class: 'pc-key-hint pc-key-primary', text: 'Space / 1' });
    this.primary = h(
      'button',
      {
        class: 'btn btn-gold dice-primary',
        attrs: { type: 'button' },
        on: { click: () => this.onPrimary() },
      },
      this.primaryIcon,
      this.primaryLabel,
      this.primaryKeyHint,
    );
    this.cardBadge = h('span', { class: 'icon-btn-badge', text: '0', attrs: { hidden: 'hidden' } });
    const cardButton = iconButton('cards', 'カード', () => this.openHand(), { class: 'hud-icon hud-cmd-card' });
    cardButton.append(this.cardBadge, h('kbd', { class: 'pc-key-hint', text: '2' }));
    const propertyButton = iconButton('property', '物件', () => this.openCatalog(), { class: 'hud-icon hud-secondary hud-cmd-property' });
    propertyButton.append(h('kbd', { class: 'pc-key-hint', text: '3' }));
    const destButton = iconButton('flag', '目的地', () => this.openDestination(), { class: 'hud-icon hud-secondary hud-cmd-dest' });
    destButton.append(h('kbd', { class: 'pc-key-hint', text: '4' }));
    const mapButton = iconButton('globe', '地図', () => this.openMapViewDialog(), { class: 'hud-icon hud-secondary hud-cmd-map' });
    mapButton.setAttribute('aria-pressed', 'false');
    mapButton.append(h('kbd', { class: 'pc-key-hint', text: '5' }));
    this.mapButton = mapButton;
    const skillButton = h(
      'button',
      {
        class: 'icon-btn hud-icon hud-cmd-skill',
        attrs: { type: 'button', 'aria-label': '固有技', title: '固有技（1 年 1 回）' },
        on: { click: () => this.openSkill() },
      },
      uiIcon('skill', '✨', 'icon-btn-icon'),
      h('span', { class: 'icon-btn-label', text: '固有技' }),
      h('kbd', { class: 'pc-key-hint', text: '6' }),
    );
    this.skillButton = skillButton;
    const otherButton = iconButton('treasure', 'その他', () => this.openOtherMenu(), { class: 'hud-icon hud-other-btn' });
    this.commDock = h('div', { class: 'hud-comm' });
    // スマホはチャットとエモートを 1 ボタンに統合する（固有技を足して 8 個になり、
    // 下部バーが 2 行にはみ出していたため）。PC では CSS で非表示。
    this.commMergedButton = h(
      'button',
      {
        class: 'icon-btn hud-icon hud-comm-button hud-comm-merged',
        attrs: { type: 'button', 'aria-label': 'チャットとエモート', title: 'チャット・エモート' },
        on: { click: () => this.toggleCommChooser() },
      },
      uiIcon('chat', '💬', 'icon-btn-icon'),
      h('span', { class: 'icon-btn-label', text: 'チャット' }),
    );
    const iconRow = h(
      'div',
      { class: 'hud-icons' },
      cardButton,
      propertyButton,
      destButton,
      mapButton,
      skillButton,
      otherButton,
      this.commDock,
    );
    this.hudIcons = iconRow;
    this.moveOptionsHost = h('div', { class: 'move-options', attrs: { hidden: 'hidden' } });
    this.bottomBar = h('div', { class: 'game-bottom-bar' }, this.moveOptionsHost, h('div', { class: 'bottom-primary-row' }, this.primary, iconRow));
    this.moneyHost = h('div', { class: 'money-panel' });

    this.pcCommBadge = h('span', { class: 'icon-btn-badge pc-comm-badge', text: '0', attrs: { hidden: 'hidden' } });
    this.pcCommFab = h(
      'button',
      {
        class: 'pc-comm-fab',
        attrs: { type: 'button', 'aria-label': 'チャットとエモートをひらく', title: 'チャット・エモート' },
        on: { click: () => this.togglePcComm() },
      },
      uiIcon('chat', '💬', 'pc-comm-fab-icon'),
      this.pcCommBadge,
    );
    this.pcCommTabChat = h('button', {
      class: 'pc-comm-tab is-active',
      text: '💬 チャット',
      dataset: { tab: 'chat' },
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'true' },
      on: { click: () => this.openPcComm('chat') },
    });
    this.pcCommTabEmote = h('button', {
      class: 'pc-comm-tab',
      text: '😆 エモート',
      dataset: { tab: 'emote' },
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
      on: { click: () => this.openPcComm('emote') },
    });
    this.pcCommBody = h('div', { class: 'pc-comm-body' });
    this.pcCommDrawer = h(
      'aside',
      { class: 'pc-comm-drawer', attrs: { hidden: 'hidden', 'aria-label': 'チャットとエモート' } },
      h(
        'header',
        { class: 'pc-comm-head' },
        h('div', { class: 'pc-comm-tabs', attrs: { role: 'tablist' } }, this.pcCommTabChat, this.pcCommTabEmote),
        h('button', {
          class: 'pc-comm-close',
          text: '✕',
          attrs: { type: 'button', 'aria-label': 'チャットとエモートをとじる' },
          on: { click: () => this.closePcComm() },
        }),
      ),
      this.pcCommBody,
    );
    this.squareInspectCard = h('div', {
      class: 'square-inspect-card',
      attrs: { hidden: 'hidden', role: 'tooltip', 'aria-live': 'polite' },
    });

    this.chat = new ChatPanel({
      session: this.session,
      canChat: () => this.session.mySeats().length > 0,
      seatInfo: (seat) => this.chatSeatInfo(seat),
      isMuted: (seat) => this.muteOf(seat).chat,
      showChat: () => uiSettings().showChat,
      onIncoming: (line) => {
        if (!this.chat.isOpen) {
          this.pcCommUnread += 1;
          this.syncPcCommBadge();
        }
        const playerId = this.playerIdOfSeat(line.seat);
        if (playerId === null) return;
        if (!this.session.mySeats().includes(line.seat)) Audio.sfx('chat');
        this.showRankBubble(playerId, line.text);
        this.map?.bubble(playerId, line.text, 4200);
        this.addLog(`💬 ${this.playerName(playerId)}: ${line.text}`);
      },
      onOpenChange: (open) => {
        if (open) {
          this.pcCommUnread = 0;
          this.syncPcCommBadge();
          if (this.isPcLayout() && this.emotes.isOpen) this.emotes.close();
          this.pcCommTab = 'chat';
        }
        this.syncPcCommUi();
        this.updateMapSafeArea();
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
      onOpenChange: (open) => {
        if (open) {
          if (this.isPcLayout() && this.chat.isOpen) this.chat.close();
          this.pcCommTab = 'emote';
        }
        this.syncPcCommUi();
        this.updateMapSafeArea();
      },
    });

    this.eventPanel = new EventPanel({
      onChoose: (index) => {
        if (!this.state || this.state.phase.t !== 'event' || !this.interactiveNow()) return;
        this.eventPanel.markChosen();
        this.sendAction({ t: 'choose', index });
      },
      onSkipFx: () => this.skipEventIntro(),
    });

    this.dice = new DiceOverlay();
    this.piperShow = new PiperShow();
    this.skillCutin = new SkillCutin();
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
    this.handoffStartBtn = h('button', {
      class: 'btn btn-gold handoff-start-btn',
      text: '▶ タップしてはじめる',
      attrs: { type: 'button' },
      on: {
        click: (event) => {
          event.stopPropagation();
          this.resolveHandoff();
        },
      },
    });
    this.handoff = h(
      'div',
      { class: 'handoff-banner', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-live': 'assertive' } },
      this.handoffAvatar,
      h(
        'div',
        { class: 'handoff-text' },
        this.handoffName,
        h('span', { class: 'handoff-sub', text: '端末を渡して、準備ができたらタップしてください' }),
      ),
      this.handoffStartBtn,
    );
    this.handoffBackdrop = h(
      'div',
      {
        class: 'handoff-backdrop',
        attrs: { hidden: 'hidden' },
        on: {
          click: () => this.resolveHandoff(),
        },
      },
      this.handoff,
    );
    this.skipHint = h('div', { class: 'skip-hint', attrs: { hidden: 'hidden' }, text: 'タップでスキップ ▶▶' });
    this.chat.fab.classList.add('hud-comm-button');
    this.emotes.fab.classList.add('hud-comm-button');
    this.commDock.append(this.chat.fab, this.emotes.fab, this.commMergedButton);

    this.el = h(
      'div',
      { class: 'screen game-screen' },
      this.mapWrap,
      h('div', { class: 'map-vignette', attrs: { 'aria-hidden': 'true' } }),
      this.topbar,
      this.recenterButton,
      this.overviewBanner,
      this.miniMapCanvas,
      this.rankingHost,
      this.portraitHost,
      this.msgWindow.el,
      this.moneyHost,
      this.bottomBar,
      this.eventPanel.el,
      this.emoteHost,
      this.dice.el,
      this.piperShow.el,
      this.skillCutin.el,
      this.connBanner,
      this.gameBanner,
      this.handoffBackdrop,
      this.turnBanner,
      this.monthFlip,
      this.rouletteOverlay,
      this.destArrow,
      this.squareInspectCard,
      this.confettiHost,
      this.cityPickBanner,
      this.skipHint,
      this.loading,
      this.pcCommFab,
      this.pcCommDrawer,
      this.chat.panel,
      this.emotes.panel,
    );
    this.syncResponsiveLayout();

    this.fxPlayer = new FxPlayer({
      settings: () => effectiveUiSettings(),
      handleFx: (fx, state, control) => this.handleFx(fx, state, control),
      applyState: (state, deadline, seq, gen) => this.applyState(state, deadline, seq, false, gen),
      setBusy: (busy) => {
        this.fxBusy = busy;
        if (busy) this.destArrow.hidden = true;
        this.updateHud();
        if (!busy) {
          if (!this.flushPendingPhaseEnd()) {
            this.updateAutoDialogs();
            this.advanceBulkBuy();
          }
        }
      },
      setSkippable: (skippable) => {
        this.skipHint.hidden = !skippable || !!this.resultScreen;
      },
      onQueueChange: () => undefined,
      onWatchdog: () => {
        Audio.stopVoice();
        this.dice.cancel();
        this.cancelRoulette();
        this.resolveHandoff();
        this.pendingPhaseEnd = null;
        this.map?.cancelAnimations(false);
        this.stopStepsCounter();
        this.transientMsgPending = false;
        this.msgWindow.clear();
        this.syncMessageWindowLayer();
      },
    });

    this.bindKeyboard();
    this.bindClickToSkip();
    const onConn = this.session.onConnection((state) => this.renderConnection(state));
    this.unsubscribeFns.push(onConn);
    this.unsubscribeFns.push(this.app.modal.onChange(() => this.syncMessageWindowLayer()));
    this.renderConnection(this.session.connection());

    const onUnlocked = () => this.updateBgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.unsubscribeFns.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked));
    this.unsubscribeFns.push(watchMotionPreference(() => this.map?.setReducedMotion(motionReduced())));
    if (import.meta.env.DEV) {
      // 開発時だけのテスト seams（本番ビルドでは丸ごと削除される）。UI には出さない。
      // スクリーンショット検証が実 UI 上で取り立て屋の演出を強制再生するために使う。
      (globalThis as { __fableGame?: GameScreen }).__fableGame = this;
    }
  }

  async init(): Promise<void> {
    this.bindSession();
    await this.initMap();
  }

  destroy(): void {
    this.destroyed = true;
    this.resolveHandoff();
    this.pendingPhaseEnd = null;
    this.fxPlayer.destroy();
    this.timer.destroy();
    this.dice.destroy();
    this.piperShow.hide();
    this.skillCutin.hide();
    this.closeCommChooser();
    this.finalYearBanner?.close();
    this.finalYearBanner = null;
    this.msgWindow.destroy();
    this.chat.destroy();
    this.emotes.destroy();
    this.resultScreen?.destroy();
    this.yearEnd?.close();
    this.shop?.close();
    this.transient?.handle.close();
    this.citySheet?.close();
    this.map?.setOverviewCallback(null);
    this.map?.setMiniMap(null);
    this.map?.destroy();
    for (const unsub of this.unsubscribeFns) unsub();
    window.clearTimeout(this.pendingTimer);
    window.clearTimeout(this.bannerTimer);
    window.clearTimeout(this.handoffTimer);
    window.clearInterval(this.overviewTimer);
    window.clearTimeout(this.portraitVariantTimer);
    window.clearTimeout(this.turnBannerTimer);
    window.clearTimeout(this.monthFlipTimer);
    if (this.stepsTimer) cancelAnimationFrame(this.stepsTimer);
    this.clearCityPick();
    this.cancelRoulette();
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
      this.map.onSquareInspect((info) => this.renderSquareInspect(info));
      this.map.setMiniMap(this.miniMapCanvas);
      this.map.resize();
      this.map.setOverviewCallback(() => this.syncOverviewUi());
      this.syncOverviewUi();
      // The renderer only flips its overview flag on drawn frames; poll lightly so the
      // banner/recenter button still appear if the final tween frame is coalesced.
      window.clearInterval(this.overviewTimer);
      this.overviewTimer = window.setInterval(() => {
        if (!this.destroyed) this.syncOverviewUi();
      }, 350);
      this.canvas.addEventListener('pointerdown', this.onMapInteract, { passive: true });
      this.canvas.addEventListener('pointerup', this.onMapInteract, { passive: true });
      this.canvas.addEventListener('wheel', this.onMapInteract, { passive: true });
      window.addEventListener('resize', this.onWindowResize);
      this.updateMapSafeArea();
      this.loadingBar.hidden = true;
      this.loadingText.textContent = '盤面を待っています…';
      this.mapReady = true;
      this.flushPendingMessages();
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

  private messageGen(msg: ServerMsg): number {
    if (msg.t === 'welcome' || msg.t === 'lobby' || msg.t === 'snapshot' || msg.t === 'update') {
      return msg.gen ?? this.latestGen;
    }
    return this.latestGen;
  }

  private isResync(msg: ServerMsg): boolean {
    return msg.t === 'snapshot' && msg.resync === true;
  }

  private beginGeneration(gen: number): void {
    this.interruptInFlightFx();
    this.latestGen = gen;
    this.latestSeq = -1;
    this.appliedSeq = -1;
    this.seq = 0;
    this.latestDeadline = null;
    this.actionPending = false;
    this.pendingPhaseEnd = null;
    this.clearPendingTimer();
    this.eventPanel.resetChosen();
  }

  private cancelRoulette(): void {
    window.clearTimeout(this.rouletteTimer);
    this.rouletteTimer = 0;
    window.clearInterval(this.rouletteInterval);
    this.rouletteInterval = 0;
    const finish = this.rouletteFinish;
    this.rouletteFinish = null;
    finish?.(true);
    this.rouletteOverlay.hidden = true;
    this.rouletteOverlay.classList.remove('is-spinning', 'is-result');
  }

  /**
   * Cancels everything a re-adopted snapshot invalidates: the running voice line, the 3D dice,
   * pending fx awaits (resolved, not dropped) and the move-option UI. Must run before applying
   * the snapshot, while the old presentation is still coherent.
   */
  private interruptInFlightFx(): void {
    Audio.stopVoice();
    this.dice.cancel();
    this.piperShow.hide();
    this.skillCutin.hide();
    this.closeCommChooser();
    this.finalYearBanner?.close();
    this.finalYearBanner = null;
    this.cancelRoulette();
    this.resolveHandoff();
    this.pendingPhaseEnd = null;
    // Cancel in-flight move/warp animations BEFORE fxPlayer.reset() so snapshot adoption
    // never leaves an old animation running (even when its endpoint matches the snapshot).
    this.map?.cancelAnimations(false);
    this.fxPlayer.reset();
    this.stopStepsCounter();
    this.transientMsgPending = false;
    this.msgWindow.clear();
    this.syncMessageWindowLayer();
    this.moveSelection = null;
    this.moveOptionsCache = [];
    this.moveOptionsKey = '';
    this.moveOnlyCities = false;
    this.moveRemain.clear();
    this.moveRemainTarget = 'destination';
    this.recommendedMoveNodeId = null;
    this.moveOptionsHost.hidden = true;
    this.moveOptionsHost.replaceChildren();
    this.map?.setMoveOptions(null, () => undefined);
  }

  private flushPendingMessages(): void {
    if (!this.mapReady || this.pendingMessages.length === 0) return;
    const messages = this.pendingMessages.splice(0);
    for (const msg of messages) this.onMessage(msg);
  }

  private onMessage(msg: ServerMsg): void {
    if (!this.mapReady && (msg.t === 'snapshot' || msg.t === 'update')) {
      this.pendingMessages.push(msg);
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        const gen = this.messageGen(msg);
        if (gen > this.latestGen) this.beginGeneration(gen);
        this.mySeat = msg.seat;
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        for (const line of msg.chat) this.chat.addLine(line);
        this.renderConnections();
        break;
      }
      case 'snapshot': {
        const gen = this.messageGen(msg);
        if (gen < this.latestGen) break;
        if (gen > this.latestGen) this.beginGeneration(gen);
        const resync = this.isResync(msg);
        // Never allow a delayed lower-seq resync snapshot in the same generation to roll back a
        // newer update already received from the host.
        if (gen === this.latestGen && msg.seq < this.latestSeq) break;
        // A same-(gen, seq) resync that matches what is already on screen (and is not replacing
        // queued fx) must not interrupt a running cutscene.
        if (
          resync &&
          !this.fxPlayer.busy &&
          !this.fxBusy &&
          isIdenticalResync(this.appliedWatermark, { gen, seq: msg.seq, state: msg.state })
        ) {
          this.fxPlayer.dropThrough(gen, msg.seq);
          this.latestDeadline = msg.deadline;
          this.deadline = msg.deadline;
          this.lobby = msg.lobby;
          this.syncFlaggedSeats();
          this.updateHud();
          break;
        }
        this.interruptInFlightFx();
        // The snapshot supersedes every queued update: never replay a reconnect backlog.
        this.fxPlayer.dropThrough(gen, msg.seq);
        this.latestGen = gen;
        this.latestSeq = Math.max(this.latestSeq, msg.seq);
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        this.latestDeadline = msg.deadline;
        this.deadline = msg.deadline;
        this.actionPending = false;
        this.clearPendingTimer();
        this.endedVoicePlayed = false;
        this.applyState(msg.state, msg.deadline, msg.seq, true, gen);
        this.eventPanel.resetChosen();
        break;
      }
      case 'update': {
        const gen = this.messageGen(msg);
        if (gen < this.latestGen) break;
        if (gen > this.latestGen) this.beginGeneration(gen);
        if (gen === this.latestGen && msg.seq <= this.latestSeq) break;
        this.latestGen = gen;
        this.latestSeq = msg.seq;
        this.latestDeadline = msg.deadline;
        this.deadline = msg.deadline;
        this.actionPending = false;
        this.clearPendingTimer();
        this.fxPlayer.enqueue({ seq: msg.seq, fx: msg.fx, state: msg.state, deadline: msg.deadline, gen });
        this.updateHud();
        break;
      }
      case 'lobby': {
        const gen = this.messageGen(msg);
        if (gen > this.latestGen) this.beginGeneration(gen);
        this.lobby = msg.lobby;
        this.syncFlaggedSeats();
        this.renderConnections();
        break;
      }
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
    this.pendingPhaseEnd = null;
    if (code !== 'rate_limited') this.eventPanel.resetChosen();
    this.clearPendingTimer();
    if (code === 'rate_limited') {
      this.chat.notifyRateLimited('レート制限中。少し待ってから送ってください。');
      this.app.toasts.show(ERROR_JA.rate_limited, 'warn');
      return;
    }
    const japanese = ERROR_JA[code] ?? message ?? `エラー: ${code}`;
    this.app.toasts.show(japanese, 'bad', 3400);
    if (code === 'stale') this.session.requestResync?.();
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

  private applyState(state: PublicState, deadline: number | null, seq: number, instant = false, gen = this.latestGen): void {
    if (gen < this.appliedGen) return;
    if (gen === this.appliedGen && seq < this.appliedSeq) return;
    if (gen > this.appliedGen) {
      this.appliedGen = gen;
      this.appliedSeq = -1;
      this.seq = 0;
    }
    this.appliedSeq = seq;
    this.seq = Math.max(this.seq, seq);
    this.appliedWatermark = { gen, seq, state };
    const previousYear = this.state?.year;
    this.state = state;
    if (gen === this.latestGen && seq < this.latestSeq) {
      this.deadline = this.latestDeadline;
    } else {
      this.deadline = deadline;
      if (gen === this.latestGen) this.latestDeadline = deadline;
    }
    this.loading.hidden = true;
    this.map?.setState(state);
    this.map?.setMonth(state.month);
    this.enforcePhaseDialogs(state);
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
    // Only the primary button, timer and event choice lock react to busy/pending changes.
    if (this.fxBusy) {
      if (this.state) {
        const actor = actorOf(this.state);
        this.updatePrimary(this.state, actor);
        this.updateTimer(this.state, actor);
        if (this.eventPanel.isOpen) {
          this.eventPanel.setState(this.state, false, {
            fxPlaying: true,
            isMine: this.isActorMine(this.state),
          });
        }
      }
      return;
    }
    this.renderHud();
  }

  private isActorMine(state: PublicState): boolean {
    const actor = actorOf(state);
    return actor !== null && this.myPlayerIds().includes(actor);
  }

  private updateStatusChip(state: PublicState, actor: number | null): void {
    const mine = actor !== null && this.myPlayerIds().includes(actor);
    const hotseat = this.session.mode === 'local' && this.myPlayerIds().length > 1;
    this.statusChip.textContent =
      this.resultScreen !== null
        ? 'ゲーム終了'
        : state.phase.t === 'game_over'
          ? 'ゲーム終了'
          : actor === null
            ? '観戦中'
            : mine && !hotseat
              ? 'あなたの番'
              : `${this.actorLabel(actor)} の番`;
    this.statusChip.classList.toggle(
      'is-mine',
      mine && state.phase.t !== 'game_over',
    );
  }

  /** Keep top turn badge, plate, wallet, ranking and portrait aligned with the speaker on turn handoff. */
  private syncTurnPresentation(playerId: number, state: PublicState): void {
    this.hideGameBanner();
    this.app.toasts.el.replaceChildren();
    this.updateStatusChip(state, playerId);
    const displaySeat = this.session.mode === 'online' ? (this.myPlayerIds()[0] ?? playerId) : playerId;
    this.renderPlayerPlate(state, displaySeat, playerId);
    this.renderMoney(state, displaySeat, playerId);
    this.renderRanking(state, playerId);
    this.setPortraitFor(playerId, state);
  }

  private renderHud(): void {
    const state = this.state;
    if (!state) return;
    const actor = actorOf(state);
    const displaySeat = this.displaySeat();
    const privateSeat = this.privateSeat();

    this.yearChip.textContent = `${state.year}年目 ${state.month}月`;
    const finalYear = isFinalYearActive(state);
    this.finalYearChip.hidden = !finalYear;
    if (finalYear) {
      const label = state.config.years <= 1 ? '最終盤！目的地ボーナス×2' : '最終年！目的地ボーナス×2';
      const textEl = this.finalYearChip.querySelector('.final-year-chip-text');
      if (textEl && textEl.textContent !== label) textEl.textContent = label;
      this.finalYearChip.setAttribute('aria-label', `${label}。青マスは首位以外+50%`);
    }
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
    this.destText.replaceChildren(
      inRealm ? '出口' : destination ? rubyName(destination.nameJa, destination.nameKana) : state.destination,
    );
    fitTextOneLine(this.destText, { minPx: 10 });
    this.destChip.classList.toggle('is-realm', inRealm);
    const distanceSeat = actor ?? displaySeat ?? 0;
    const destPlayer = state.players[distanceSeat];
    const steps = destPlayer ? distance(GAME_DATA, destPlayer.nodeId, destNode) : 0;
    const distanceValue = this.destDistance.querySelector('.dest-distance-value');
    if (distanceValue) distanceValue.textContent = Number.isFinite(steps) ? String(steps) : '—';
    const destFullName = inRealm ? '出口' : destination ? destination.nameJa : state.destination;
    const stepsLabel = Number.isFinite(steps) ? `あと${steps}マス` : '距離不明';
    this.destChip.title = `${destFullName}（${stepsLabel}）`;
    this.destChip.setAttribute('aria-label', `目的地 ${destFullName}、${stepsLabel}。タップでマップ表示`);
    this.playerPlateDestName.replaceChildren(
      inRealm ? '出口' : destination ? rubyName(destination.nameJa, destination.nameKana) : state.destination,
    );
    fitTextOneLine(this.playerPlateDestName, { minPx: 11 });
    this.playerPlateDestSteps.textContent = stepsLabel;
    this.playerPlateDest.classList.toggle('is-realm', inRealm);
    this.updateDestArrow(state, actor, destNode);
    this.updateStatusChip(state, actor);

    const choosing = state.phase.t === 'choose_dest' && actor !== null && this.myPlayerIds().includes(actor);
    this.el.classList.toggle('choosing-dest', choosing);
    this.renderRanking(state, actor);
    this.renderPortrait(state, actor);
    this.renderMoney(state, displaySeat, actor);
    this.renderMoveOptions(state, actor);
    this.updatePrimary(state, actor);
    this.updateTimer(state, actor);
    if (this.eventPanel.isOpen) {
      this.eventPanel.setState(state, this.interactiveNow(), {
        fxPlaying: this.fxBusy,
        isMine: this.isActorMine(state),
      });
    }
    const hand = privateSeat !== null ? state.players[privateSeat]?.cards.length ?? 0 : 0;
    this.cardBadge.textContent = String(hand);
    this.cardBadge.hidden = hand === 0;
    requestAnimationFrame(() => {
      this.updateMapSafeArea();
      this.syncOverviewUi();
    });
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
    this.portraitSub.textContent =
      character.nameJa === character.origin
        ? `${character.nameJa} ・ ${character.originRegion}`
        : `${character.nameJa} ・ ${character.origin}`;
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
      this.moveOnlyCities = false;
      this.moveRemain.clear();
      this.moveRemainTarget = 'destination';
      this.recommendedMoveNodeId = null;
      this.moveOptionsHost.hidden = true;
      this.moveOptionsHost.classList.remove('is-many', 'is-very-many');
      this.moveOptionsHost.replaceChildren();
      this.map?.setMoveOptions(null, () => undefined);
      return;
    }
    const options = state.phase.options;
    if (this.moveSelection && !options.some((option) => option.nodeId === this.moveSelection)) this.moveSelection = null;
    const moverId = actor ?? 0;
    const moverCash = state.players[moverId]?.cash ?? 0;
    const key = `${state.destination}#${this.playerRealm}#${moverId}:${moverCash}#${options.map((option) => `${option.nodeId}:${option.path.join(',')}`).join('|')}`;
    const freshOptions = key !== this.moveOptionsKey;
    if (freshOptions) {
      this.moveOptionsKey = key;
      this.moveOnlyCities = false;
      this.moveRemain.clear();
      this.moveRemainTarget = 'destination';
      this.moveChipInfoCache.clear();
      for (const option of options) {
        const info = this.map?.getMoveOptionDistanceInfo(option.nodeId) ?? null;
        this.moveRemain.set(option.nodeId, info?.hops ?? null);
        if (info) this.moveRemainTarget = info.target;
        const city = cityOfNode(option.nodeId);
        if (city) this.moveChipInfoCache.set(city.id, cityMoveInfo(GAME_DATA, state, moverId, city));
      }
      const anyKnown = options.some((option) => typeof this.moveRemain.get(option.nodeId) === 'number');
      const ranked = options.map((option, index) => ({
        option,
        index,
        remain: this.moveRemain.get(option.nodeId),
        city: nodesById.get(option.nodeId)?.kind === 'city' ? 0 : 1,
      }));
      if (anyKnown) {
        // 目的地に近い順。同距離は駅を優先し、最後は元の順序で安定させる。
        ranked.sort((a, b) => {
          const aKnown = typeof a.remain === 'number';
          const bKnown = typeof b.remain === 'number';
          if (aKnown !== bKnown) return aKnown ? -1 : 1;
          if (aKnown && bKnown && a.remain !== b.remain) return (a.remain as number) - (b.remain as number);
          if (a.city !== b.city) return a.city - b.city;
          return a.index - b.index;
        });
      }
      this.moveOptionsCache = ranked.map((entry) => entry.option);
      const onSelect = (nodeId: string | null): void => this.selectMoveOption(nodeId, true);
      this.map?.setMoveOptions(this.moveOptionsCache, {
        numbers: this.moveOptionsCache.map((_, index) => index + 1),
        onSelect,
      });
      // 目的地順の推奨を基本に、レースが遠いときだけ「買える駅」を最大2歩の寄り道で優先する。
      this.recommendedMoveNodeId =
        biasedMoveRecommendation({
          options: this.moveOptionsCache,
          remainOf: (nodeId) => this.moveRemain.get(nodeId) ?? null,
          cityOf: (nodeId) => cityOfNode(nodeId) ?? null,
          infoFor: (city) => this.moveChipInfoCache.get(city.id) ?? cityMoveInfo(GAME_DATA, state, moverId, city),
        }) ?? this.map?.getRecommendedMoveOption() ?? null;
      // 候補が出た時点で「おすすめ」を選択済みにし、主ボタンを即有効化する（未選択の金枠で迷わせない）。
      const preferred = this.recommendedMoveNodeId ?? this.moveOptionsCache[0]?.nodeId ?? null;
      if (preferred && this.moveOptionsCache.some((option) => option.nodeId === preferred)) {
        this.moveSelection = preferred;
        this.map?.selectMoveOption(preferred, { frame: false });
      }
    }
    this.moveOptionsHost.hidden = false;
    const many = this.moveOptionsCache.length >= 7;
    const veryMany = this.moveOptionsCache.length >= 12;
    this.moveOptionsHost.classList.toggle('is-many', many);
    this.moveOptionsHost.classList.toggle('is-very-many', veryMany);
    const cityOptionsCount = this.moveOptionsCache.filter((option) => nodesById.get(option.nodeId)?.kind === 'city').length;
    if (this.moveOnlyCities && cityOptionsCount === 0) this.moveOnlyCities = false;

    const actorNode = actor !== null ? state.players[actor]?.nodeId : undefined;
    const scroller = h('div', { class: `move-chip-scroll ${many ? 'is-two-row' : ''}`.trim() });
    const visibleEntries = this.moveOptionsCache
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !this.moveOnlyCities || nodesById.get(option.nodeId)?.kind === 'city');

    visibleEntries.forEach(({ option, index }) => {
      const summary = transportSummary(actorNode ? [actorNode, ...option.path] : option.path);
      const node = nodesById.get(option.nodeId);
      const nodeKind = node?.kind ?? 'blue';
      const kind = moveKindChip(nodeKind);
      const info = squareInfoOf(nodeKind);
      const remain = this.moveRemain.get(option.nodeId) ?? null;
      // 距離が取れたときはマップが見ている対象（目的地/出口）に合わせ、
      // 取れないときは手番プレイヤーのいる盤面で言い分ける。
      const remainTarget = remain !== null ? this.moveRemainTarget : this.playerRealm === 'world' ? 'destination' : 'exit';
      const remainLabel = remainTarget === 'exit' ? '出口' : '目的地';
      const remainText = remain === null ? `${remainLabel}まで —` : `${remainLabel}まで あと${remain}マス`;
      const recommended = option.nodeId === this.recommendedMoveNodeId;
      const topNear = many && !recommended && index < 3;
      const selected = this.moveSelection === option.nodeId;
      const city = cityOfNode(option.nodeId);
      const chipInfo = city
        ? this.moveChipInfoCache.get(city.id) ?? cityMoveInfo(GAME_DATA, state, moverId, city)
        : null;
      const priceLabel = chipInfo ? moveChipPriceLabel(chipInfo) : null;
      const ownerNames = chipInfo ? chipInfo.otherOwnerIds.map((id) => this.playerName(id)) : [];
      const priceClass = !chipInfo
        ? ''
        : chipInfo.cheapest === null
          ? 'is-sold-out'
          : chipInfo.affordable
            ? 'is-ok'
            : 'is-over';
      const nameContent = city ? rubyName(city.nameJa, city.nameKana) : info.name;
      const fullAriaName = city ? `${city.nameJa}（駅）` : info.name;
      const tileSrc = squareTileUrl(nodeKind, true, city);
      const chip = h(
        'button',
        {
          class: `move-chip ${selected ? 'is-selected' : ''} ${recommended ? 'is-recommended' : ''} ${topNear ? 'is-top-near' : ''}`.trim(),
          dataset: { nodeId: option.nodeId, kind: nodeKind },
          attrs: {
            type: 'button',
            'aria-label': `${index + 1}: ${fullAriaName} を選ぶ。${remainText}${priceLabel ? `。${priceLabel}` : ''}${ownerNames.length > 0 ? `。${ownerNames.join('・')}が所有` : ''}`,
            'aria-pressed': String(selected),
            style: `--kind-color:${kind.color}`,
          },
          on: { click: () => this.selectMoveOption(option.nodeId) },
        },
        h(
          'span',
          { class: `move-chip-num ${LIGHT_KIND_COLORS.has(kind.color.toLowerCase()) ? 'is-light' : ''}`.trim() },
          String(index + 1),
        ),
        h(
          'span',
          { class: 'move-chip-kind is-tile', attrs: { style: `--kind-color:${kind.color}`, title: info.name, 'aria-hidden': 'true' } },
          tileThumb(tileSrc, 'move-chip-tile', info.name),
        ),
        h(
          'span',
          { class: 'move-chip-main' },
          h(
            'span',
            { class: 'move-chip-name-row' },
            h('span', { class: 'move-chip-name' }, nameContent),
            city ? h('span', { class: 'move-chip-type', text: '駅' }) : null,
          ),
          h(
            'span',
            { class: 'move-chip-vehicle' },
            summary.rail > 0 ? h('span', { class: 'move-chip-transport', text: `電車 ${summary.rail}マス` }) : null,
            summary.sea > 0 ? h('span', { class: 'move-chip-transport', text: `船 ${summary.sea}マス` }) : null,
            summary.air > 0 ? h('span', { class: 'move-chip-transport', text: `✈ 空路 ${summary.air}マス` }) : null,
            chipInfo && chipInfo.otherOwnerIds.length > 0
              ? h(
                  'span',
                  {
                    class: 'move-chip-owners',
                    attrs: { title: `${ownerNames.join('・')}が所有`, 'aria-label': `${ownerNames.join('・')}が所有` },
                  },
                  ...chipInfo.otherOwnerIds.map((id) =>
                    h('span', {
                      class: 'move-chip-owner-dot',
                      attrs: { style: `--owner-color:${playerColor(state.players[id])}`, 'aria-hidden': 'true' },
                    }),
                  ),
                )
              : null,
            priceLabel ? h('span', { class: `move-chip-price ${priceClass}`.trim(), text: priceLabel }) : null,
          ),
        ),
        h(
          'span',
          { class: 'move-chip-meta' },
          recommended
            ? h('span', { class: 'move-chip-tag', text: 'おすすめ' })
            : topNear
              ? h('span', { class: 'move-chip-tag is-near', text: `近い #${index + 1}` })
              : null,
          h(
            'span',
            { class: 'move-chip-dest' },
            h('span', { class: 'move-chip-dest-prefix', text: `${remainLabel}まで ` }),
            remain === null ? '—' : `あと${remain}マス`,
          ),
          h('span', { class: 'move-chip-steps', text: `${option.path.length}歩` }),
        ),
      );
      scroller.append(chip);
    });
    const page = (direction: number): void => {
      scroller.scrollBy({ left: direction * Math.max(240, scroller.clientWidth * 0.88), behavior: 'smooth' });
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
    const jumpTopBtn = veryMany
      ? h('button', {
          class: 'move-filter-btn',
          text: '🎯 近い順',
          attrs: { type: 'button', title: '目的地に近い上位へ戻る' },
          on: {
            click: (event) => {
              event.stopPropagation();
              scroller.scrollTo({ left: 0, behavior: 'smooth' });
              const topNode = this.recommendedMoveNodeId ?? visibleEntries[0]?.option.nodeId;
              if (topNode) this.selectMoveOption(topNode);
            },
          },
        })
      : null;
    const cityFilterBtn =
      many && cityOptionsCount > 0 && cityOptionsCount < this.moveOptionsCache.length
        ? h('button', {
            class: `move-filter-btn ${this.moveOnlyCities ? 'is-active' : ''}`.trim(),
            text: this.moveOnlyCities ? `すべて (${this.moveOptionsCache.length})` : `駅のみ (${cityOptionsCount})`,
            attrs: { type: 'button', 'aria-pressed': String(this.moveOnlyCities) },
            on: {
              click: (event) => {
                event.stopPropagation();
                this.moveOnlyCities = !this.moveOnlyCities;
                if (this.state) this.renderMoveOptions(this.state, actorOf(this.state));
              },
            },
          })
        : null;
    const targetName = this.moveRemainTarget === 'exit' ? '出口' : '目的地';
    const promptText = many
      ? `${targetName}に近い順（${visibleEntries.length}${this.moveOnlyCities ? `駅 / 全${options.length}` : 'か所'}）`
      : `光っているマスから行き先をえらぼう（${options.length}か所）`;
    this.moveOptionsHost.replaceChildren(
      h(
        'div',
        { class: 'move-options-head' },
        h('span', { class: 'move-options-label', text: `出目 ${state.phase.roll}` }),
        h('span', {
          class: 'move-options-prompt',
          text: promptText,
        }),
        jumpTopBtn,
        cityFilterBtn,
        prev,
        next,
      ),
      scroller,
    );
    this.updateMoveSelectionUi();
    // 駅名は 1 行が基本。まず縮小で収め、最小サイズでも入らないときだけ
    // 2 行に折り返す（スマホでも「シュト／ゥット／ガルト」のようには割らない）。
    const chipNames = [...this.moveOptionsHost.querySelectorAll<HTMLElement>('.move-chip-name')];
    chipNames.forEach((name) => name.classList.remove('is-long'));
    chipNames.forEach((name) => fitTextOneLine(name, { minPx: 11 }));
    chipNames
      .filter((name) => name.scrollWidth > name.clientWidth + 0.5)
      .forEach((name) => {
        name.classList.add('is-long');
        fitTextOneLine(name, { minPx: 11 });
      });
    if (freshOptions) {
      // Measure the newly visible move-options tray immediately and re-frame so candidates
      // never sit behind the bottom option bar or top ranking strip on mobile viewports.
      this.updateMapSafeArea();
      this.map?.reframeMoveOptions();
    }
  }

  private selectMoveOption(nodeId: string | null, fromMap = false): void {
    if (nodeId === null) {
      this.moveSelection = null;
      this.updateMoveSelectionUi();
      if (this.state) this.updatePrimary(this.state, actorOf(this.state));
      return;
    }
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
    this.moveOptionsHost.querySelectorAll<HTMLElement>('.move-chip').forEach((chip) => {
      const nodeId = chip.dataset.nodeId;
      const selected = !!nodeId && nodeId === this.moveSelection;
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
        case 'skill_target':
          label = '固有技の対象を選択中';
          icon = '✨';
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
    this.primaryKeyHint.hidden = disabled;
    const isGameOver = state.phase.t === 'game_over' || this.resultScreen !== null;
    const isMyTurn = mine && !isGameOver;
    const waitingTurn = !isGameOver && (!mine || this.fxBusy || this.actionPending);
    this.bottomBar.classList.toggle('is-my-turn', isMyTurn);
    this.bottomBar.classList.toggle('is-waiting-turn', waitingTurn);

    // 固有技ボタン: 自分の手番開始で未使用のときだけ光らせる。
    if (this.skillButton) {
      const actorPlayer = actor !== null ? state.players[actor] : undefined;
      const used = actorPlayer !== undefined && actorPlayer.skillUsedYear === state.year;
      const ready = isMyTurn && !this.fxBusy && !this.actionPending && state.phase.t === 'turn_start' && !used;
      this.skillButton.classList.toggle('is-ready', ready);
      this.skillButton.classList.toggle('is-used', used);
      this.skillButton.disabled = isGameOver;
    }
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

  private closeCitySheet(): void {
    this.citySheet?.close();
    this.citySheet = null;
    this.citySheetCityId = null;
    this.citySheetBuyMode = false;
    this.bulkBuyCityId = null;
    this.bulkBuyQueue = [];
  }

  private closeTransientDialog(): void {
    this.transient?.handle.close();
    this.transient = null;
    this.clearCityPick();
  }

  /** Phase gate runs on every adopted state, even while fx are queued/busy. */
  private enforcePhaseDialogs(state: PublicState): void {
    const phase = state.phase;
    const actor = actorOf(state);
    const actorIsMine = actor !== null && this.myPlayerIds().includes(actor);
    const terminal = phase.t === 'year_end' || phase.t === 'game_over' || this.resultScreen !== null;

    if (this.citySheet) {
      if (terminal || (this.citySheetBuyMode && (phase.t !== 'buy' || phase.cityId !== this.citySheetCityId || !actorIsMine))) {
        this.closeCitySheet();
      }
    }
    if (this.shop && (terminal || phase.t !== 'shop' || !actorIsMine)) {
      this.shop.close();
      this.shop = null;
    }
    if (this.transient) {
      const expected: TransientKind | null =
        phase.t === 'card_target'
          ? 'target'
          : phase.t === 'skill_target'
            ? 'skill'
            : phase.t === 'discard'
              ? 'discard'
              : phase.t === 'sell'
                ? 'sell'
                : null;
      if (terminal || !actorIsMine || expected !== this.transient.kind) this.closeTransientDialog();
    }
    if (this.eventPanel.isOpen) {
      if (terminal || !state.activeEventId || (this.eventPanel.eventId !== null && this.eventPanel.eventId !== state.activeEventId)) {
        this.eventPanel.hide();
        this.syncEventComm();
      }
    }
    if (this.yearEnd) {
      if (phase.t !== 'year_end' || this.resultScreen) {
        this.yearEnd.close();
        this.yearEnd = null;
      } else {
        this.app.modal.closeOthers(this.yearEnd.root);
      }
    }
  }

  private updateAutoDialogs(): void {
    const state = this.state;
    if (!state || this.fxBusy) return;
    const canAct = this.interactiveNow();

    if (state.phase.t === 'buy') {
      if (this.pendingPhaseEnd === 'end_buy') {
        this.flushPendingPhaseEnd();
        return;
      }
      const actor = actorOf(state);
      const actorIsMine = actor !== null && this.myPlayerIds().includes(actor);
      if (!actorIsMine) {
        if (this.citySheetBuyMode) this.closeCitySheet();
        return;
      }
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
          onBuyout: (propertyId) => this.sendAction({ t: 'buyout', propertyId }),
          onBuyAll: (propertyIds) => {
            this.bulkBuyCityId = cityId;
            const current = this.state;
            const actor = current?.players[current.current];
            const currentCity = citiesById.get(cityId);
            const fallback = current && actor && currentCity ? planBulkPurchase(currentCity, current, actor.cash) : null;
            this.bulkBuyQueue = propertyIds.length > 0
              ? [...propertyIds]
              : fallback?.items.map((entry) => entry.property.id) ?? [];
            this.advanceBulkBuy();
          },
          onEndBuy: () => this.requestPhaseEnd('end_buy'),
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
      if (this.pendingPhaseEnd === 'end_buy') this.pendingPhaseEnd = null;
      this.bulkBuyCityId = null;
      this.bulkBuyQueue = [];
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
      if (this.pendingPhaseEnd === 'end_shop') {
        this.flushPendingPhaseEnd();
        return;
      }
      const actor = actorOf(state);
      if (actor === null || !this.myPlayerIds().includes(actor)) {
        this.shop?.close();
        this.shop = null;
        return;
      }
      if (!this.shop) {
        this.shop = openShopDialog({
          modal: this.app.modal,
          state,
          canAct,
          onBuy: (cardId) => this.sendAction({ t: 'buy_card', cardId }),
          onSell: (cardId) => this.sendAction({ t: 'sell_card', cardId }),
          onEnd: () => this.requestPhaseEnd('end_shop'),
        });
      } else {
        this.shop.update(state, canAct);
      }
    } else if (this.shop) {
      if (this.pendingPhaseEnd === 'end_shop') this.pendingPhaseEnd = null;
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
      this.app.modal.closeOthers(this.yearEnd.root);
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
          this.eventPanel.setState(state, canAct, {
            fxPlaying: this.fxBusy,
            isMine: this.isActorMine(state),
          });
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
      phase.t === 'card_target'
        ? 'target'
        : phase.t === 'skill_target'
          ? 'skill'
          : phase.t === 'discard'
            ? 'discard'
            : phase.t === 'sell'
              ? 'sell'
              : null;
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
    } else if (wanted === 'skill' && phase.t === 'skill_target') {
      const handle = openSkillTargetDialog({
        modal: this.app.modal,
        state,
        options: phase.options,
        canAct,
        onTarget: (target) => this.sendAction({ t: 'skill_target', target }),
        onCancel: () => this.sendAction({ t: 'cancel' }),
      });
      this.transient = { kind: 'skill', cardId: null, handle };
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

  /**
   * Finish buy/shop reliably with a single tap even if a purchase fx or prior request is still
   * in flight: close the dialog immediately, fast-forward the purchase fx if playing, and queue
   * the end action so the dialog never pops back open.
   */
  private requestPhaseEnd(kind: 'end_buy' | 'end_shop'): void {
    if (kind === 'end_buy') {
      this.closeCitySheet();
    } else {
      this.shop?.close();
      this.shop = null;
    }
    if (this.interactiveNow()) {
      this.pendingPhaseEnd = null;
      this.sendAction({ t: kind });
      return;
    }
    this.pendingPhaseEnd = kind;
    if (this.fxBusy) {
      Audio.stopVoice();
      this.msgWindow.clear();
      this.fxPlayer.skipUpdate();
    }
  }

  private flushPendingPhaseEnd(): boolean {
    const pending = this.pendingPhaseEnd;
    if (!pending) return false;
    const state = this.state;
    const expectedPhase = pending === 'end_buy' ? 'buy' : 'shop';
    if (!state || state.phase.t !== expectedPhase) {
      this.pendingPhaseEnd = null;
      return false;
    }
    if (!this.interactiveNow()) return true;
    this.pendingPhaseEnd = null;
    this.sendAction({ t: pending });
    return true;
  }

  private skipEventIntro(): void {
    if (!this.fxBusy) return;
    Audio.stopVoice();
    this.msgWindow.clear();
    this.fxPlayer.skipUpdate();
  }

  /**
   * When manual text advance is active while a modal (such as the full-screen property purchase
   * sheet on mobile) is open, lift the message window out of the `inert` screen-host above the
   * modal layer so the player can read and tap to advance without getting blocked.
   */
  private syncMessageWindowLayer(): void {
    const overModal = !this.destroyed && this.msgWindow.isManualWaiting && this.app.modal.isOpen();
    if (overModal) {
      if (this.msgWindow.el.parentElement !== this.app.root) {
        this.app.root.append(this.msgWindow.el);
      }
      this.msgWindow.el.classList.add('is-over-modal');
    } else {
      this.msgWindow.el.classList.remove('is-over-modal');
      if (!this.destroyed && this.msgWindow.el.parentElement !== this.el && this.portraitHost.isConnected) {
        this.portraitHost.after(this.msgWindow.el);
      }
    }
  }

  // ---------------------------------------------------------------- turn / actions

  private sendAction(action: Action): void {
    if (!this.state || this.actionPending || this.fxBusy) return;
    if (this.appliedGen !== this.latestGen) {
      this.session.requestResync?.();
      this.app.toasts.show('最新の盤面を同期しています…', 'info', 2500);
      return;
    }
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
      this.bulkBuyQueue = [];
      return;
    }
    let propertyId: string | undefined;
    while (this.bulkBuyQueue.length > 0) {
      const candidate = this.bulkBuyQueue.shift();
      if (!candidate) break;
      const property = city.properties.find((entry) => entry.id === candidate);
      if (!property || state.owner[candidate] !== undefined) continue;
      propertyId = candidate;
      break;
    }
    if (!propertyId) {
      this.bulkBuyCityId = null;
      this.bulkBuyQueue = [];
      this.app.toasts.show('まとめて購入できる物件を買い切りました', 'good');
      return;
    }
    this.sendAction({ t: 'buy', propertyId });
  }

  private armPendingTimer(): void {
    this.clearPendingTimer();
    this.pendingTimer = window.setTimeout(() => {
      if (!this.actionPending) return;
      this.actionPending = false;
      this.eventPanel.resetChosen();
      this.updateHud();
      this.session.requestResync?.();
      this.app.toasts.show('操作の応答がありませんでした。もう一度お試しください。', 'warn', 3200);
      this.refreshActionDialogs();
    }, 13_000);
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
      h('span', { class: 'realm-chip-name', text: realmLabel(viewing) }),
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
    this.syncOverviewUi();
    // ドラッグやホイールの直後に矢印の位置を合わせ直す（次フレームの描画後）。
    if (this.state) {
      const state = this.state;
      const actor = actorOf(state);
      const nodeId = this.destArrowNodeId(state, actor);
      if (nodeId) requestAnimationFrame(() => this.updateDestArrow(state, actor, nodeId));
    }
  };

  /** いま矢印が向くべきノード（異世界では出口）。 */
  private destArrowNodeId(state: PublicState, actor: number | null): string | null {
    if (actor === null) return null;
    const realm = realmOfNode(state.players[actor]?.nodeId);
    if (realm === 'world') return cityNodeId(state.destination) ?? null;
    return portalNodeFor(realm) ?? null;
  }

  private isPcLayout(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches;
  }

  /** Keep PC-only DOM placements cleanly separated from the mobile vertical/landscape tree. */
  private syncResponsiveLayout(): void {
    const isPc = this.isPcLayout();
    if (isPc) {
      if (this.rankingHost.parentElement !== this.pcRankingSlot) {
        this.pcRankingSlot.append(this.rankingHost);
      }
      if (this.chat.panel.parentElement !== this.pcCommBody) {
        this.pcCommBody.append(this.chat.panel);
      }
      if (this.emotes.panel.parentElement !== this.pcCommBody) {
        this.pcCommBody.append(this.emotes.panel);
      }
    } else {
      if (this.rankingHost.parentElement !== this.el && this.miniMapCanvas.isConnected) {
        this.miniMapCanvas.after(this.rankingHost);
      }
      if (this.chat.panel.parentElement !== this.el) {
        this.el.append(this.chat.panel);
      }
      if (this.emotes.panel.parentElement !== this.el) {
        this.el.append(this.emotes.panel);
      }
      this.pcCommDrawer.hidden = true;
    }
    this.syncPcCommUi();
  }

  /** スマホ用: 統合ボタンからチャット/エモートを選ぶ小さなポップオーバー。 */
  private toggleCommChooser(): void {
    if (this.commChooser) {
      this.closeCommChooser();
      return;
    }
    const choose = (kind: 'chat' | 'emote'): void => {
      this.closeCommChooser();
      if (kind === 'chat') this.chat.openPanel();
      else this.emotes.openPalette();
    };
    const chooser = h(
      'div',
      { class: 'hud-comm-chooser', attrs: { role: 'menu', 'aria-label': 'チャットとエモート' } },
      h(
        'button',
        {
          class: 'hud-comm-choice hud-comm-choice-chat',
          attrs: { type: 'button', role: 'menuitem' },
          on: { click: () => choose('chat') },
        },
        uiIcon('chat', '💬', 'hud-comm-choice-icon'),
        h('span', { text: 'チャット' }),
      ),
      h(
        'button',
        {
          class: 'hud-comm-choice hud-comm-choice-emote',
          attrs: { type: 'button', role: 'menuitem' },
          on: { click: () => choose('emote') },
        },
        uiIcon('emote', '😆', 'hud-comm-choice-icon'),
        h('span', { text: 'エモート' }),
      ),
    );
    this.el.append(chooser);
    this.commChooser = chooser;
    this.commMergedButton.setAttribute('aria-expanded', 'true');
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (chooser.contains(event.target) || this.commMergedButton.contains(event.target)) return;
      this.closeCommChooser();
    };
    this.commChooserOutside = onDown;
    document.addEventListener('pointerdown', onDown, true);
  }

  private closeCommChooser(): void {
    this.commChooser?.remove();
    this.commChooser = null;
    if (this.commChooserOutside) {
      document.removeEventListener('pointerdown', this.commChooserOutside, true);
      this.commChooserOutside = null;
    }
    this.commMergedButton.setAttribute('aria-expanded', 'false');
  }

  private togglePcComm(): void {
    if (this.chat.isOpen || this.emotes.isOpen) {
      this.closePcComm();
    } else {
      this.openPcComm(this.pcCommTab);
    }
  }

  private openPcComm(tab: 'chat' | 'emote'): void {
    this.pcCommTab = tab;
    if (tab === 'chat') {
      if (this.emotes.isOpen) this.emotes.close();
      if (!this.chat.isOpen) this.chat.openPanel();
    } else {
      if (this.chat.isOpen) this.chat.close();
      if (!this.emotes.isOpen) this.emotes.openPalette();
    }
    this.syncPcCommUi();
  }

  private closePcComm(): void {
    if (this.chat.isOpen) this.chat.close();
    if (this.emotes.isOpen) this.emotes.close();
    this.syncPcCommUi();
  }

  private syncPcCommUi(): void {
    const isPc = this.isPcLayout();
    const anyOpen = this.chat.isOpen || this.emotes.isOpen;
    this.pcCommDrawer.hidden = !isPc || !anyOpen;
    this.pcCommFab.classList.toggle('is-open', isPc && anyOpen);
    this.pcCommFab.setAttribute('aria-expanded', String(isPc && anyOpen));
    const chatActive = this.chat.isOpen || (!this.emotes.isOpen && this.pcCommTab === 'chat');
    this.pcCommTabChat.classList.toggle('is-active', chatActive);
    this.pcCommTabChat.setAttribute('aria-selected', String(chatActive));
    this.pcCommTabEmote.classList.toggle('is-active', !chatActive);
    this.pcCommTabEmote.setAttribute('aria-selected', String(!chatActive));
  }

  private syncPcCommBadge(): void {
    const count = Math.min(99, this.pcCommUnread);
    this.pcCommBadge.textContent = count > 9 ? '9+' : String(count);
    this.pcCommBadge.hidden = count <= 0;
  }

  private hideSquareInspect(): void {
    this.squareInspectCard.hidden = true;
    this.squareInspectCard.classList.remove('is-pinned');
  }

  private renderSquareInspect(info: SquareInspectEvent | null): void {
    if (!info || this.app.modal.isOpen() || this.resultScreen) {
      this.hideSquareInspect();
      return;
    }
    const card = describeBoardNode(info.node, this.state);
    const pinned = info.trigger === 'longpress';
    this.squareInspectCard.classList.toggle('is-pinned', pinned);
    const parts: Node[] = [
      h(
        'div',
        { class: 'square-inspect-head' },
        tileThumb(card.iconUrl, 'square-inspect-icon', card.title),
        h(
          'div',
          { class: 'square-inspect-titles' },
          h('strong', { class: 'square-inspect-title', text: card.title }),
          h('span', { class: 'square-inspect-badge', text: card.badge }),
        ),
        pinned
          ? h('button', {
              class: 'square-inspect-close',
              text: '✕',
              attrs: { type: 'button', 'aria-label': '説明をとじる' },
              on: { click: () => this.hideSquareInspect() },
            })
          : null,
      ),
      h('p', { class: 'square-inspect-desc', text: card.description }),
    ];
    if (card.extra) parts.push(h('p', { class: 'square-inspect-extra', text: card.extra }));
    this.squareInspectCard.replaceChildren(...parts);
    this.squareInspectCard.hidden = false;

    // Position the card cleanly near the square while clamping inside the viewport and HUD.
    const rootRect = this.el.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const cardRect = this.squareInspectCard.getBoundingClientRect();
    const topBound = (this.isLayoutVisible(this.topbar) ? this.topbar.getBoundingClientRect().bottom - rootRect.top : 0) + 10;
    const bottomBound =
      (this.isLayoutVisible(this.bottomBar) ? this.bottomBar.getBoundingClientRect().top - rootRect.top : rootRect.height) - 10;
    const anchorX = canvasRect.left - rootRect.left + info.x;
    const anchorY = canvasRect.top - rootRect.top + info.y;
    const width = Math.max(200, cardRect.width || 260);
    const height = Math.max(76, cardRect.height || 100);
    const left = Math.max(10, Math.min(rootRect.width - width - 10, anchorX - width / 2));
    let top = anchorY - height - 22;
    if (top < topBound) top = anchorY + 26;
    top = Math.max(topBound, Math.min(Math.max(topBound, bottomBound - height), top));
    this.squareInspectCard.style.left = `${Math.round(left)}px`;
    this.squareInspectCard.style.top = `${Math.round(top)}px`;
  }

  private readonly onWindowResize = (): void => {
    this.map?.resize();
    this.syncResponsiveLayout();
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
    void this.map
      ?.focusNode(node.id, { zoom: realmOfNode(node.id) === 'world' ? 0.92 : 0.9, ms: 420 })
      .then(() => this.syncOverviewUi());
    this.renderHud();
  }

  private syncOverviewUi(): void {
    const map = this.map;
    if (!map) return;
    const overview = map.isOverviewMode();
    this.overviewBanner.hidden = !overview;
    this.el.classList.toggle('overview-mode', overview);
    this.mapButton.classList.toggle('is-active', overview);
    this.mapButton.setAttribute('aria-pressed', String(overview));
    const state = this.state;
    const actor = state ? actorOf(state) : null;
    const node = actor !== null ? state?.players[actor]?.nodeId : undefined;
    if (!node || this.viewRealm !== 'world') {
      this.recenterButton.hidden = !overview;
      return;
    }
    const actorVisible = map.isNodeVisible(node) === true;
    this.recenterButton.hidden = !(overview || !actorVisible);
    this.recenterButton.classList.toggle('is-overview', overview);
  }

  /** CSS-hidden elements (display:none, visibility:hidden, no boxes) must not shape the map viewport. */
  private isLayoutVisible(el: HTMLElement | null | undefined): el is HTMLElement {
    if (!el || !el.isConnected || el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.getClientRects().length === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  private updateMapSafeArea(): void {
    const map = this.map;
    if (!map) return;
    const root = this.el.getBoundingClientRect();
    const topbar = this.isLayoutVisible(this.topbar) ? this.topbar.getBoundingClientRect() : null;
    const ranking = this.isLayoutVisible(this.rankingHost) ? this.rankingHost.getBoundingClientRect() : null;
    const bottom = this.isLayoutVisible(this.bottomBar) ? this.bottomBar.getBoundingClientRect() : null;
    const moveOptions =
      !this.moveOptionsHost.hidden && this.isLayoutVisible(this.moveOptionsHost)
        ? this.moveOptionsHost.getBoundingClientRect()
        : null;
    const money = this.isLayoutVisible(this.moneyHost) ? this.moneyHost.getBoundingClientRect() : null;
    const eventPanelVisible = this.eventPanel.isOpen && this.isLayoutVisible(this.eventPanel.el);
    const event = eventPanelVisible ? this.eventPanel.el.getBoundingClientRect() : null;
    const narrow = window.matchMedia('(max-width: 899px)').matches;
    let top = topbar ? Math.max(0, topbar.bottom - root.top + 6) : 0;
    let left = 0;
    let right = 0;
    let bottomInset = bottom ? Math.max(0, root.bottom - bottom.top + 6) : 0;
    if (moveOptions) bottomInset = Math.max(bottomInset, root.bottom - moveOptions.top + 6);
    if (narrow) {
      if (ranking) top = Math.max(top, ranking.bottom - root.top + 6);
      if (money) bottomInset = Math.max(bottomInset, root.bottom - money.top + 6);
    } else {
      // On PC (>= 900px) ranking sits inside the top bar, so left stays full-width.
      if (ranking && this.rankingHost.parentElement !== this.pcRankingSlot) {
        left = Math.max(0, ranking.right - root.left + 8);
      }
      if (event) right = Math.max(0, root.right - event.left + 8);
    }
    if (event && narrow) top = Math.max(top, event.top - root.top + 6);
    // Never collapse the board: keep at least 40% of each axis, or at least 110px vertically
    // while move-options is open on short landscape screens so bottomInset is not clipped.
    const minKeepH = 0.4;
    const minKeepV = moveOptions ? Math.min(0.4, 110 / Math.max(1, root.height)) : 0.4;
    const verticalBudget = root.height * (1 - minKeepV);
    if (top + bottomInset > verticalBudget) {
      const excess = top + bottomInset - verticalBudget;
      if (bottomInset >= top) bottomInset = Math.max(0, bottomInset - excess);
      else top = Math.max(0, top - excess);
      const rest = top + bottomInset - verticalBudget;
      if (rest > 0) {
        top = Math.max(0, top - rest / 2);
        bottomInset = Math.max(0, bottomInset - rest / 2);
      }
    }
    const horizontalBudget = root.width * (1 - minKeepH);
    if (left + right > horizontalBudget) {
      const excess = left + right - horizontalBudget;
      if (right >= left) right = Math.max(0, right - excess);
      else left = Math.max(0, left - excess);
    }
    map.setSafeArea({ top, right, bottom: bottomInset, left });
    const canvasRect = this.canvas.getBoundingClientRect();
    const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
    const addObstacle = (el: HTMLElement | null | undefined, visible = true): void => {
      if (!visible || !this.isLayoutVisible(el)) return;
      const rect = el.getBoundingClientRect();
      obstacles.push({
        x: rect.left - canvasRect.left,
        y: rect.top - canvasRect.top,
        w: rect.width,
        h: rect.height,
      });
    };
    addObstacle(this.topbar);
    addObstacle(this.rankingHost);
    addObstacle(this.portraitHost);
    addObstacle(this.moneyHost);
    addObstacle(this.bottomBar);
    addObstacle(this.moveOptionsHost, !this.moveOptionsHost.hidden);
    addObstacle(this.eventPanel.el, this.eventPanel.isOpen);
    addObstacle(this.chat.panel, this.chat.isOpen);
    addObstacle(this.emotes.panel, this.emotes.isOpen);
    addObstacle(this.pcCommFab);
    addObstacle(this.pcCommDrawer, !this.pcCommDrawer.hidden);
    addObstacle(this.recenterButton, !this.recenterButton.hidden);
    addObstacle(this.overviewBanner, !this.overviewBanner.hidden);
    map.setLabelObstacles(obstacles);
  }

  private updateDestArrow(state: PublicState, actor: number | null, nodeId: string): void {
    // サイコロ後（行き先選択中）と演出中は、下部ボタンや候補の邪魔になるので出さない。
    const choosing = state.phase.t === 'choose_dest';
    if (actor === null || !this.state || choosing || this.fxBusy) {
      this.destArrow.hidden = true;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      this.destArrow.hidden = true;
      return;
    }
    const extra = extraMapView(this.map);
    const point = extra?.screenPositionOfNode?.(nodeId) ?? null;
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
    const placement = placeDestinationArrow({
      width: rect.width,
      height: rect.height,
      box: this.destArrowBox(rect),
      blockers: this.destArrowBlockers(rect),
      dx,
      dy,
    });
    if (!placement) {
      this.destArrow.hidden = true;
      return;
    }
    this.destArrow.hidden = false;
    this.destArrow.style.left = `${Math.round(placement.x)}px`;
    this.destArrow.style.top = `${Math.round(placement.y)}px`;
    this.destArrow.querySelector('.dest-arrow-icon')?.setAttribute('style', `transform:rotate(${placement.angle}rad)`);
    this.destArrow.querySelector('.dest-arrow-label')!.textContent = this.playerRealm !== 'world' ? '出口' : '目的地';
  }

  /** 目的地矢印を置いてよい盤面の矩形（HUD を避けた内側）。canvas ローカル座標。 */
  private destArrowBox(rect: DOMRect): { left: number; top: number; right: number; bottom: number } | null {
    const toLocal = (el: HTMLElement | null | undefined): DOMRect | null => {
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return r;
    };
    const topbar = toLocal(this.topbar);
    const bottomBar = toLocal(this.bottomBar);
    const ranking = toLocal(this.rankingHost);
    const event = this.eventPanel.isOpen ? toLocal(this.eventPanel.el) : null;
    // 狭い画面では順位表が横一列（上部）、PC版でも上バー右に統合されているため左は全幅使える。
    const narrow = window.matchMedia('(max-width: 899px)').matches;
    const rankingOnSide = !narrow && ranking && this.rankingHost.parentElement !== this.pcRankingSlot;
    let left = rankingOnSide ? Math.max(6, ranking.right - rect.left + 10) : 6;
    let right = rect.width - 6;
    let top = Math.max(6, topbar ? topbar.bottom - rect.top + 8 : 6);
    if (narrow && ranking) top = Math.max(top, ranking.bottom - rect.top + 8);
    let bottom = Math.min(rect.height - 6, bottomBar ? bottomBar.top - rect.top - 8 : rect.height - 6);
    if (event) right = Math.min(right, event.left - rect.left - 10);
    if (right - left < 120 || bottom - top < 120) return null;
    return { left, top, right, bottom };
  }

  /** 矢印を避けたい HUD 矩形（canvas ローカル座標）。 */
  private destArrowBlockers(rect: DOMRect): Array<{ left: number; top: number; right: number; bottom: number }> {
    const out: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    const add = (el: HTMLElement | null | undefined, visible = true): void => {
      if (!el || !visible || !this.isLayoutVisible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      out.push({ left: r.left - rect.left, top: r.top - rect.top, right: r.right - rect.left, bottom: r.bottom - rect.top });
    };
    add(this.portraitHost);
    add(this.moneyHost, !this.moneyHost.hidden);
    add(this.miniMapCanvas);
    if (this.rankingHost.parentElement !== this.pcRankingSlot) add(this.rankingHost);
    add(this.pcCommFab);
    add(this.pcCommDrawer, !this.pcCommDrawer.hidden);
    add(this.recenterButton, !this.recenterButton.hidden);
    return out;
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

  /** 「マスの種類」+ 継続中の都市効果の一覧。都市を選ぶと地図がその都市へ寄る。 */
  private openCityLegend(): void {
    openSquareLegendDialog(this.app.modal, {
      cityMods: this.state?.cityMods,
      onLocateCity: (cityId) => {
        this.app.modal.closeAll();
        this.manualView = false;
        this.viewRealm = 'world';
        this.map?.setView?.('world');
        void this.map?.focusNode(cityNodeId(cityId), { zoom: 1.4, ms: 620 }).then(() => this.syncOverviewUi());
      },
    });
  }

  private openOtherMenu(): void {
    let handle: ModalHandle | null = null;
    const item = (icon: string, label: string, desc: string, action: () => void): HTMLElement =>
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
        h(
          'span',
          { class: 'game-menu-label' },
          label,
          h('span', { class: 'game-menu-desc', text: desc }),
        ),
        h('span', { class: 'game-menu-arrow', text: '▶', attrs: { 'aria-hidden': 'true' } }),
      );
    const body = h(
      'div',
      { class: 'game-menu' },
      item('property', '持ち物', '所有している物件の一覧', () => this.openOwned()),
      item('skill', '固有技', 'キャラクター固有技（1 年 1 回）', () => this.openSkill()),
      item('chart', '情報', '業種の相場・ニュース・行動ログ', () => this.openInfo()),
      item('flag', 'マスの種類', '全 8 種類のアイコンと効果・異世界倍率', () => this.openCityLegend()),
      item('globe', '全体マップ', '地上のマップを引いて見る', () => {
        this.manualView = true;
        this.viewRealm = 'world';
        this.applyMapView();
        this.renderHud();
        this.focusWorld();
      }),
      item('gear', '設定', '演出速度・チャット表示・ミュート', () => this.app.openSettings()),
      item('help', '遊び方', 'ルールと操作の説明', () => this.app.openHelp()),
      item('trophy', 'クレジット', 'キャラクターと素材の出典', () => this.app.openCredits()),
    );
    handle = this.app.modal.open(body, { title: 'その他', subtitle: '持ち物・情報・マスの種類・設定' });
  }

  /** HUD・キーボード 6・その他メニューから開く固有技パネル。 */
  private openSkill(): void {
    const state = this.state;
    if (!state) return;
    const actor = actorOf(state);
    const mine = actor !== null && this.myPlayerIds().includes(actor);
    const viewer = state.players.find((player) => this.myPlayerIds().includes(player.id)) ?? state.players[state.current];
    const canAct = mine && this.interactiveNow() && !this.actionPending;
    let handle: ModalHandle | null = null;
    handle = openSkillCommand({
      modal: this.app.modal,
      state,
      playerId: mine ? (actor as number) : (viewer?.id ?? state.current),
      canAct,
      waitingForTarget: mine && state.phase.t === 'skill_target',
      onUse: () => {
        handle?.close();
        this.sendAction({ t: 'use_skill' });
      },
    });
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
    const targetEl = this.isLayoutVisible(this.moneyHost) ? this.moneyHost : this.playerPlate;
    const wallet = targetEl.getBoundingClientRect();
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
    const destName = city ? city.nameJa : cityId;
    const announceDestination = async (): Promise<void> => {
      if (control.skipped || this.destroyed) return;
      if (this.transientMsgPending) {
        this.transientMsgPending = false;
        this.msgWindow.skipLine();
      }
      const narrationText = destinationNarration(destName);
      const speed = control.speed;
      const autoAdvance = uiSettings().autoAdvance;
      const waitForVoice = autoAdvance && speed < 4 && control.backlog === 0;
      let voiceStarted = false;
      const voicePromise =
        control.backlog > 0
          ? Promise.resolve()
          : Audio.playVoice('narrator', narrationText, {
              rate: speed,
              onStart: () => {
                voiceStarted = true;
              },
            });
      const boundedVoice = waitForVoice
        ? raceWithTimeout(
            voicePromise,
            voiceBudgetMs(0, narrationText, voicePlaybackRate(speed)) + 3000,
          )
        : undefined;
      const shown = this.msgWindow.show({
        speaker: 'narrator',
        name: 'ナレーター',
        text: `次の目的地は ${destName}！`,
        color: '#ffd23f',
        speed,
        autoAdvance,
        ...(boundedVoice ? { voiceDone: boundedVoice, voiceStarted: () => voiceStarted } : {}),
      });
      control.onSkip(() => {
        Audio.stopVoice();
        this.msgWindow.skipLine();
      });
      if (!autoAdvance) control.setManualWait(true);
      try {
        await shown;
      } finally {
        if (!autoAdvance) control.setManualWait(false);
      }
    };

    if (!city || motionReduced()) {
      if (city) {
        this.rouletteName.replaceChildren(rubyName(city.nameJa, city.nameKana));
        this.rouletteCountry.textContent = city.countryJa;
      }
      if (this.playerRealm === 'world') this.map?.focusNode(cityNodeId(cityId), { zoom: 0.8, ms: 700 });
      this.lastDestinationBannerAt = Date.now();
      await announceDestination();
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
      this.rouletteName.replaceChildren(rubyName(candidate.nameJa, candidate.nameKana));
      fitTextOneLine(this.rouletteName, { minPx: 16 });
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
      if (skipped) Audio.stopVoice();
      resolve();
    };
    this.rouletteFinish = finish;
    control.onSkip(() => finish(true));
    const spinMs = Math.max(160, Math.round(1050 / control.speed));
    this.rouletteTimer = window.setTimeout(() => finish(false), spinMs);
    await promise;
    this.lastDestinationBannerAt = Date.now();
    if (this.playerRealm === 'world') this.map?.focusNode(cityNodeId(cityId), { zoom: 0.8, ms: 700 });
    if (control.skipped || this.destroyed) {
      this.rouletteOverlay.hidden = true;
      this.rouletteOverlay.classList.remove('is-result');
      this.rouletteFinish = null;
      return;
    }
    // Start voice + caption together as soon as the roulette locks onto the city; dismiss the
    // roulette panel after its short reveal hold while keeping the caption alive until voice ends.
    const announcement = announceDestination();
    const holdMs = Math.max(80, Math.round(500 / control.speed));
    const hideTimer = window.setTimeout(() => {
      this.rouletteOverlay.hidden = true;
      this.rouletteOverlay.classList.remove('is-result');
    }, holdMs);
    try {
      await announcement;
    } finally {
      window.clearTimeout(hideTimer);
      this.rouletteOverlay.hidden = true;
      this.rouletteOverlay.classList.remove('is-result');
      this.rouletteFinish = null;
    }
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
      canUseCard: (cardId) => cardId !== 'underdog' || canUseUnderdog(GAME_DATA, state, seat),
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

  private focusDestination(showToast = true): void {
    const state = this.state;
    if (!state) return;
    const inRealm = this.playerRealm !== 'world';
    const nodeId = inRealm ? portalNodeFor(this.playerRealm) : cityNodeId(state.destination);
    if (nodeId) this.map?.focusNode(nodeId, { zoom: 0.95, ms: 500 });
    if (showToast && nodeId) {
      const seat = actorOf(state) ?? this.displaySeat() ?? 0;
      const player = state.players[seat];
      const steps = player ? distance(GAME_DATA, player.nodeId, nodeId) : Number.NaN;
      const stepsText = Number.isFinite(steps) ? `（あと ${steps} マス）` : '';
      const dest = !inRealm ? citiesById.get(state.destination) : undefined;
      const name = inRealm ? '出口' : dest ? dest.nameJa : state.destination;
      this.app.toasts.show(`🎯 目的地：${name}${stepsText}`, 'info', 2600);
    }
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
      this.focusDestination(false);
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
    if (performance.now() < this.suppressMapTapUntil) return;
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
    const item = (icon: string, label: string, desc: string, action: () => void, danger = false): HTMLElement =>
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
        h(
          'span',
          { class: 'game-menu-label' },
          label,
          desc ? h('span', { class: 'game-menu-desc', text: desc }) : null,
        ),
        h('span', { class: 'game-menu-arrow', text: '▶', attrs: { 'aria-hidden': 'true' } }),
      );
    body.append(
      h('p', {
        class: 'game-menu-room',
        text: `モード: ${this.session.mode === 'local' ? 'ローカル' : 'オンライン'} ・ ルーム ${this.session.roomId}`,
      }),
      item('property', '持ち物', '所有している物件の一覧と収益見込み', () => this.openOwned()),
      item('chart', '情報', '業種倍率・目的地・経済ニュース・行動ログ', () => this.openInfo()),
      item('flag', 'マスの種類', '全 8 種類のアイコンと効果・異世界倍率', () => this.openCityLegend()),
      item('gear', '設定', '音量・演出速度・チャット表示・ミュート', () => this.app.openSettings()),
      item('help', '遊び方', 'ルール・マスの種類・キーボード操作', () => this.app.openHelp()),
      item('trophy', 'クレジット', 'キャラクターと素材の出典', () => this.app.openCredits()),
      item('menu', this.session.mode === 'online' ? '退出してタイトルへ' : 'タイトルへ', '', () => this.confirmLeave(), true),
    );
    if (state?.phase.t === 'game_over') {
      body.append(item('trophy', '結果画面を表示', '最終順位と決算サマリー', () => this.showResult(state)));
    }
    handle = this.app.modal.open(body, { title: '☰ メニュー', subtitle: '持ち物・情報・マスの種類・設定' });
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
    this.eventPanel.setState(state, this.interactiveNow(), {
      fxPlaying: this.fxBusy,
      isMine: this.isActorMine(state),
    });
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
    this.shop?.close();
    this.shop = null;
    this.app.modal.closeAll();
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
    // The message window outlives its own fx: it stays up for its bounded read time while
    // the next step (dice, movement, popups) plays, so lines do not blink out instantly.
    switch (fx.t) {
      case 'turn': {
        this.manualView = false;
        this.syncTurnPresentation(fx.playerId, pending);
        this.map?.follow(fx.playerId);
        this.addLog(`▶ ${this.actorLabel(fx.playerId)} の番`);
        let handoff = false;
        if (this.session.mode === 'local' && this.myPlayerIds().length > 1 && this.myPlayerIds().includes(fx.playerId)) {
          if (this.lastHumanTurn !== null && this.lastHumanTurn !== fx.playerId) {
            handoff = true;
          }
          this.lastHumanTurn = fx.playerId;
        }
        if (handoff) {
          await this.awaitHandoff(fx.playerId, pending, control);
        } else {
          this.showTurnBanner(fx.playerId, pending);
          await control.wait(FX_MS.turn);
        }
        return;
      }
      case 'dice': {
        Audio.sfx('dice_roll');
        // Cancel() from a resync resolves this show; the extra race also bounds a lost rAF.
        const ms = FX_MS.dice / control.speed;
        const diceMs = ms + 6000;
        if (fx.values.length > 1) {
          const vehicle = vehicleForDice(fx.values.length);
          this.showGameBanner(`${vehicle.emoji} ${vehicle.label}で出発！`);
        }
        let cancelled = false;
        control.onSkip(() => {
          cancelled = true;
          this.dice.skip();
        });
        await raceWithTimeout(this.dice.show(fx.values, ms), diceMs);
        if (!cancelled && !control.skipped && !this.destroyed) Audio.sfx('dice_land');
        return;
      }
      case 'move': {
        Audio.sfx('step');
        control.onSkip(() => this.map?.cancelAnimations(true));
        const move = this.map?.animateMove(fx.playerId, fx.path, FX_MS.moveStep / control.speed, { dice: fx.dice ?? 1 });
        this.startStepsCounter();
        await move;
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
        control.onSkip(() => this.map?.cancelAnimations(true));
        await this.map?.warp(fx.playerId, fx.nodeId, via, control.speed);
        return;
      }
      case 'cash': {
        const player = pending.players[fx.playerId];
        // The `goal` fx already floats the same 「+N億」 over the destination node; repeating
        // it from the cash bookkeeping looked like the bonus was paid twice (Sol playtest
        // fx-025 / fx-081). The goal popup keeps the number.
        if (player && fx.reason !== '目的地ボーナス') {
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
      case 'skill': {
        const character = charsById.get(fx.characterId);
        const target = fx.targetId !== undefined ? pending.players[fx.targetId] : undefined;
        const targetCharacter = target ? charsById.get(target.characterId) : undefined;
        Audio.sfx('goal_fanfare');
        this.portraitMood('joy', fx.playerId);
        this.portraitMotion('jump');
        this.map?.setMood(fx.playerId, 'joy', 6000);
        this.map?.celebrate(fx.playerId, 'goal');
        this.confetti(10);
        this.addLog(`✨ ${this.playerName(fx.playerId)} が固有技「${fx.name}」を発動！`);
        if (character) {
          await this.skillCutin.play(
            fx,
            {
              character,
              targetName: target ? `${target.name}（${targetCharacter?.nameJa ?? ''}）` : undefined,
              targetColor: targetCharacter?.color,
            },
            control,
          );
        } else {
          this.showGameBanner(`✨ ${fx.name}`);
          await control.wait(FX_MS.skill);
        }
        return;
      }
      case 'say': {
        await this.playSay(fx, pending, control);
        return;
      }
      case 'event_open': {
        this.updateStatusChip(pending, actorOf(pending));
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
        this.addLog(`🎯 目的地が ${city?.nameJa ?? fx.cityId} に決定`);
        await this.showDestinationRoulette(fx.cityId, control);
        return;
      }
      case 'piper': {
        Audio.sfx('piper');
        const piperSpeaker = `npc:piper${Math.min(3, Math.max(1, fx.level))}`;
        if (fx.holder !== null) {
          this.portraitMood('sad', fx.holder);
          this.portraitMotion('shake');
          this.map?.setMood(fx.holder, 'sad', 7000);
          this.map?.shake(0.45);
        }
        this.transientMsgPending = true;
        void this.msgWindow.show({
          speaker: piperSpeaker,
          name: PIPER_FORMS[Math.min(3, Math.max(1, fx.level)) - 1].nameJa,
          text: fx.message,
          sprite: speakerSprite(piperSpeaker),
          color: '#ff8a8a',
          speed: control.speed,
        }).then(() => { this.transientMsgPending = false; });
        this.addLog(`🎺 ${fx.message}`);
        await control.wait(FX_MS.piper);
        return;
      }
      case 'piper_roulette': {
        Audio.sfx(fx.to > fx.from ? 'roulette_stop' : 'roulette_tick');
        if (fx.to === 3) {
          this.map?.shake(0.6);
          this.portraitMood('sad', fx.holder);
        }
        this.addLog(`🎺 取り立て屋ルーレット: Lv${fx.from} → Lv${fx.to}`);
        await this.piperShow.playRoulette(fx, control);
        return;
      }
      case 'piper_disaster': {
        Audio.sfx('bad');
        this.map?.shake(1.1);
        this.portraitMood('sad', fx.holder);
        this.portraitMotion('shake');
        this.map?.setMood(fx.holder, 'sad', 7000);
        this.portraitMood('sad', fx.holder);
        const victim = pending.players[fx.holder];
        const victimCharacter = victim ? charsById.get(victim.characterId) : undefined;
        this.addLog(
          `👑 ${fx.title}（${this.playerName(fx.holder)} ▲${formatOkuShort(fx.amount)}）`,
        );
        await this.piperShow.playDisaster(
          fx,
          {
            name: victim ? displayPlayerName(victim) : this.playerName(fx.holder),
            sprite: victimCharacter ? characterSprite(victimCharacter) : undefined,
          },
          control,
        );
        return;
      }
      case 'piper_gift': {
        Audio.sfx('coin_gain');
        this.map?.celebrate(fx.holder, 'buy');
        this.map?.setMood(fx.holder, 'joy', 6000);
        this.portraitMood('joy', fx.holder);
        this.portraitMotion('jump');
        this.addLog(`🎁 ${fx.title}（${this.playerName(fx.holder)} +${formatOkuShort(fx.amount)}）`);
        await this.piperShow.playGift(fx, control);
        return;
      }
      case 'industry': {
        Audio.sfx('event');
        this.showGameBanner(`${fx.label}: 収益 ×${fx.mult.toFixed(2)}`);
        this.addLog(`📈 ${fx.label} 収益 ×${fx.mult.toFixed(2)}`);
        await control.wait(FX_MS.industry);
        return;
      }
      case 'city_mod': {
        const city = citiesById.get(fx.cityId);
        const name = city?.nameJa ?? fx.cityId;
        const up = fx.kind === 'bubble' || fx.kind === 'boom';
        const icon = up ? (fx.kind === 'bubble' ? '📈' : '✨') : fx.kind === 'blockade' ? '🚧' : '💥';
        Audio.sfx(up ? 'event' : 'bad');
        this.showGameBanner(`${icon} ${name}に${fx.label}（${up ? '▲' : '▼'}×${fx.mult.toFixed(2)}・${fx.years}年）`);
        this.map?.focusNode(cityNodeId(fx.cityId), { zoom: 1.35, ms: 620 });
        this.map?.cityModBurst(fx.cityId);
        this.map?.floatText(
          cityNodeId(fx.cityId),
          `×${fx.mult.toFixed(2)}`,
          up ? '#ffd23f' : '#ff8a8a',
        );
        if (!up) this.map?.shake(0.35);
        this.addLog(`${icon} ${name}の物件価格・収益 ×${fx.mult.toFixed(2)}（${fx.years}年）`);
        await control.wait(FX_MS.city_mod);
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
        this.app.toasts.el.replaceChildren();
        this.yearChip.textContent = `${fx.year}年目 ${fx.month}月`;
        this.showMonthFlip(fx.year, fx.month);
        await control.wait(FX_MS.month);
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
      case 'final_year': {
        Audio.sfx('goal_fanfare');
        this.finalYearBanner?.close();
        this.finalYearBanner = showFinalYearBanner({
          host: document.body,
          title: pending.config.years <= 1 ? '最終盤' : '最終年',
          year: fx.year,
          rules: fx.rules,
          narration: finalYearNarration(pending),
        });
        this.app.toasts.show('🔥 最終年！目的地ボーナス×2', 'good', 4200);
        this.addLog(`🔥 最終年（第 ${fx.year} 年）: ${fx.rules.join(' / ')}`);
        await control.wait(FX_MS.final_year);
        return;
      }
      case 'buyout': {
        // 買収の掛け合いを見せるため、いったん街のシートを閉じる（演出後に最新状態で開き直る）。
        this.closeCitySheet();
        const ref = propertiesById.get(fx.propertyId);
        Audio.sfx('buy');
        Audio.sfx('coin_loss');
        this.portraitMood('joy', fx.playerId);
        this.portraitMood('sad', fx.fromId);
        this.portraitMotion('shake');
        this.map?.setMood(fx.playerId, 'joy', 6000);
        this.map?.setMood(fx.fromId, 'sad', 6000);
        this.map?.shake(fx.brokeMonopoly ? 0.7 : 0.4);
        if (ref) {
          const nodeId = cityNodeId(ref.city.id);
          this.map?.focusNode(nodeId, { zoom: 1.05, ms: 500 });
          this.map?.floatText(nodeId, `買収 ${formatOkuShort(fx.amount)}`, '#ffd23f');
        }
        this.showGameBanner(`🤝 ${this.playerName(fx.playerId)} が ${this.playerName(fx.fromId)} の物件を買収！`);
        this.app.toasts.show(
          `🤝 ${ref?.property.name ?? fx.propertyId} を ${formatOku(fx.amount)} で買収`,
          'good',
          3600,
        );
        if (fx.brokeMonopoly) {
          this.app.toasts.show('👑 都市独占が崩れた！', 'warn', 3800);
          this.confetti(12);
        }
        this.addLog(
          `🤝 ${this.playerName(fx.playerId)} が ${this.playerName(fx.fromId)} の ${ref?.property.name ?? fx.propertyId} を ${formatOku(fx.amount)} で買収${fx.brokeMonopoly ? '（独占崩壊）' : ''}`,
        );
        await control.wait(FX_MS.buyout);
        return;
      }
      case 'toast': {
        // The destination banner already announces this; a second floating toast covers it.
        if (fx.text.startsWith('新しい目的地は') && Date.now() - this.lastDestinationBannerAt < 6000) {
          this.addLog(fx.text);
          await control.wait(FX_MS.toast);
          return;
        }
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
        ? displayPlayerName(state.players[speakerSeat ?? state.current])
        : speakerName(speaker);
    const label = speaker === 'self' ? `${displayName}` : speakerName(speaker);
    // Clear any lingering fire-and-forget banner line (destination/piper) so this spoken line
    // appears immediately instead of queueing behind it.
    if (this.transientMsgPending) {
      this.transientMsgPending = false;
      this.msgWindow.skipLine();
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
    const speed = control.speed;
    const autoAdvance = uiSettings().autoAdvance;
    // A CPU's routine quips are scenery. Play their clip only as colour; never block the turn
    // on it, otherwise the ×3 CPU pacing waits on 1.2x voice for every line.
    const routineCpu = isRoutineCpuSay(fx, state);
    // Voice playback rate is intentionally capped at 1.2x for intelligibility; at 4x/8x or while
    // catching up on queued updates, do not block message advancement on 1.2x audio playback.
    const waitForVoice = autoAdvance && speed < 4 && control.backlog === 0 && !routineCpu;
    let voiceStarted = false;
    const voicePromise =
      muted || routineCpu || control.backlog > 0
        ? Promise.resolve()
        : Audio.playVoice(voiceKey, fx.text, {
            rate: speed,
            onStart: () => {
              voiceStarted = true;
            },
          });
    const boundedVoice = waitForVoice
      ? raceWithTimeout(
          voicePromise,
          voiceBudgetMs(0, fx.text, voicePlaybackRate(speed)) + 3000,
        )
      : undefined;
    // One message window for every spoken line; the event panel no longer carries a
    // duplicate narrator card. At 1x/2x without backlog the window waits until voice finishes,
    // while fast-forward (4x/8x) and backlog catch-up advance on the speed-scaled reading timer.
    const windowLine = {
      ...this.messageLineFor(speaker, label, fx.text, state, speakerSeat),
      speed,
      autoAdvance,
      ...(boundedVoice ? { voiceDone: boundedVoice, voiceStarted: () => voiceStarted } : {}),
    };
    const shown = this.msgWindow.show(windowLine);
    control.onSkip(() => {
      Audio.stopVoice();
      this.msgWindow.skipLine();
    });
    if (!autoAdvance) control.setManualWait(true);
    try {
      await shown;
    } finally {
      if (!autoAdvance) control.setManualWait(false);
    }
  }

  /** Speaker portrait / name / accent for the single message window. */
  private messageLineFor(
    speaker: SpeakerRef,
    label: string,
    text: string,
    state: PublicState,
    speakerSeat: number | null,
  ): { speaker: string; name: string; text: string; sprite?: string; color?: string } {
    const seatCharacter =
      speaker === 'self'
        ? charsById.get(state.players[speakerSeat ?? state.current]?.characterId ?? '')
        : speaker.startsWith('char:')
          ? charsById.get(speaker.slice(5))
          : undefined;
    const sprite = seatCharacter ? characterSprite(seatCharacter) : speakerSprite(speaker);
    return {
      speaker,
      name: label,
      text,
      sprite,
      color: seatCharacter?.color ?? (speaker === 'narrator' ? '#ffd23f' : undefined),
    };
  }

  private speakerSeat(speaker: SpeakerRef, playerId: number | undefined, state: PublicState): number | null {
    if (speaker === 'self') return playerId ?? state.current;
    if (speaker.startsWith('char:')) {
      const characterId = speaker.slice(5);
      return state.players.find((player) => player.characterId === characterId)?.id ?? null;
    }
    return null;
  }

  private setPortraitFor(playerId: number, state: PublicState): void {
    if (this.portraitHost.dataset.seat !== String(playerId)) {
      this.portraitImage.classList.remove('is-mood');
    }
    this.renderPortrait(state, playerId);
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

  private showGameBanner(text: string | Node): void {
    this.gameBanner.replaceChildren(text);
    this.gameBanner.hidden = false;
    this.gameBanner.classList.add('is-visible');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.gameBanner.hidden = true;
      this.gameBanner.classList.remove('is-visible');
    }, 4200);
  }

  private hideGameBanner(): void {
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.gameBanner.hidden = true;
    this.gameBanner.classList.remove('is-visible');
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

  private startStepsCounter(): void {
    this.stopStepsCounter();
    this.stepsCounter.hidden = false;
    this.el.classList.add('is-moving');
    const render = (remaining: number): void => {
      this.stepsCounter.innerHTML = `<span class="steps-label">移動 あと</span><strong class="steps-value">${remaining}</strong><span class="steps-unit">マス</span>`;
    };
    render(this.map?.getMoveProgress()?.remaining ?? 0);
    const tick = (): void => {
      const progress = this.map?.getMoveProgress();
      if (!progress) {
        this.stepsTimer = 0;
        return;
      }
      render(progress.remaining);
      this.stepsTimer = requestAnimationFrame(tick);
    };
    this.stepsTimer = requestAnimationFrame(tick);
  }

  private stopStepsCounter(): void {
    if (this.stepsTimer) cancelAnimationFrame(this.stepsTimer);
    this.stepsTimer = 0;
    this.stepsCounter.hidden = true;
    this.el.classList.remove('is-moving');
  }

  private resolveHandoff(): void {
    window.clearTimeout(this.handoffTimer);
    this.handoffTimer = 0;
    this.handoffBackdrop.hidden = true;
    const resolve = this.handoffResolve;
    this.handoffResolve = null;
    resolve?.();
  }

  private async awaitHandoff(
    playerId: number,
    state: PublicState,
    control: PlaybackControl,
  ): Promise<void> {
    const player = state.players[playerId];
    const character = player ? charsById.get(player.characterId) : undefined;
    if (!player || !character) return;
    const name = displayPlayerName(player);
    this.handoffName.textContent = `${name} さんの番です`;
    this.handoffStartBtn.textContent = `▶ ${name} の番をはじめる`;
    this.handoffAvatar.replaceChildren(
      h('img', { attrs: { src: characterSprite(character), alt: '', draggable: 'false' } }),
    );
    this.handoffBackdrop.hidden = false;
    requestAnimationFrame(() => this.handoffStartBtn.focus({ preventScroll: true }));

    const { promise, resolve } = Promise.withResolvers<void>();
    this.handoffResolve = resolve;
    control.setManualWait(true);
    try {
      await promise;
    } finally {
      this.handoffBackdrop.hidden = true;
      if (this.handoffResolve === resolve) this.handoffResolve = null;
      control.setManualWait(false);
    }
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
        if (target.closest('button, a, input, textarea, select, .modal-panel, .chat-panel, .emote-palette, .comm-fab, .msgwin, .handoff-backdrop')) return;
        event.stopPropagation();
        this.suppressMapTapUntil = performance.now() + 300;
        if (this.eventPanel.isOpen) {
          this.skipEventIntro();
          return;
        }
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
        if (!this.squareInspectCard.hidden) {
          this.hideSquareInspect();
          event.preventDefault();
          return;
        }
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
      if (this.handoffResolve && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        this.resolveHandoff();
        return;
      }
      if (this.msgWindow.isManualWaiting && (event.key === ' ' || event.key === 'Enter')) {
        if (this.msgWindow.handleKey(event)) return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('button, a, [role="button"], input, textarea, select, .modal-panel, .chat-panel, .emote-palette')) return;
      if (this.app.modal.isOpen()) return;
      if (this.fxBusy && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        // Finish the window reveal / page first; the next press skips the cutscene.
        if (this.msgWindow.handleKey(event)) return;
        if (this.eventPanel.isOpen) {
          this.skipEventIntro();
          return;
        }
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
      if (!this.eventPanel.isOpen && !this.fxBusy && !this.bottomBar.classList.contains('is-waiting-turn') && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        switch (event.key) {
          case '1':
            if (!this.primary.disabled) this.primary.click();
            break;
          case '2':
            this.openHand();
            break;
          case '3':
            this.openCatalog();
            break;
          case '4':
            this.openDestination();
            break;
          case '5':
            this.openMapViewDialog();
            break;
          case '6':
            this.openSkill();
            break;
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
