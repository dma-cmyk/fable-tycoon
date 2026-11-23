import { Audio } from '../audio/audio';
import type { LocalSetup } from '../net/local-session';
import { clearLocalSave, createLocal, hasLocalSave, resumeLocal } from '../net/local-session';
import {
  createOnlineRoom,
  joinOnlineRoom,
  resumeOnline,
  roomExists,
  transportInfo,
} from '../net/online-session';
import type { Session } from '../net/session-types';
import { h, ModalHost, ToastHost } from './dom';
import { effectiveFxSpeed } from './settings';
import { applyMotionPreference } from './motion';
import { TitleScreen } from './screens/title';
import { SetupScreen } from './screens/setup';
import { OnlineEntryScreen } from './screens/online-entry';
import { LobbyScreen } from './screens/lobby';
import { GameScreen } from './screens/game';
import { openSettingsDialog } from './components/settingsDialog';
import { openHelpDialog } from './components/helpDialog';
import { openCreditsDialog } from './components/creditsDialog';
import type { ScreenHandle, SetupMode } from './screens/types';
import type { TransportInfo } from './screens/lobby';

export class App {
  readonly root: HTMLElement;
  readonly modal: ModalHost;
  readonly toasts: ToastHost;
  private readonly screenHost: HTMLElement;
  private screen: ScreenHandle | null = null;
  private session: Session | null = null;
  private lastLocalSetup: LocalSetup | null = null;
  private booted = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add('app-root');
    this.root.replaceChildren();
    this.screenHost = h('div', { class: 'screen-host' });
    this.modal = new ModalHost();
    this.toasts = new ToastHost();
    root.append(this.screenHost, this.modal.el, this.toasts.el);
    applyMotionPreference();
    this.installGlobalHandlers();
  }

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    const params = new URLSearchParams(location.search);
    const inviteroom = params.get('room');
    if (inviteroom) {
      this.showOnlineEntry(normalizeRoomId(inviteroom));
      return;
    }
    try {
      const resumed = resumeOnline();
      if (resumed) {
        this.adoptSession(resumed);
        this.showLobby(resumed);
        return;
      }
    } catch {
      // no resumable online room; continue to the title
    }
    this.showTitle();
  }

  // ---------------------------------------------------------------- screens

  showTitle(): void {
    this.closeSession();
    const title = new TitleScreen({
      hasResume: hasLocalSave(),
      onSolo: () => this.showSetup('solo'),
      onHotseat: () => this.showSetup('hotseat'),
      onOnline: () => this.showOnlineEntry(),
      onResume: () => this.resumeLocalGame(),
      onHelp: () => this.openHelp(),
      onSettings: () => this.openSettings(),
      onCredits: () => this.openCredits(),
    });
    this.showScreen(title);
  }

  goTitle(): void {
    this.showTitle();
  }

  showSetup(mode: SetupMode): void {
    this.closeSession();
    const setup = new SetupScreen({
      mode,
      modal: this.modal,
      onBack: () => this.showTitle(),
      onStart: (config) => this.startLocal(config),
    });
    this.showScreen(setup);
  }

  showOnlineEntry(initialRoom?: string): void {
    this.closeSession();
    const entry = new OnlineEntryScreen({
      initialRoom,
      onBack: () => this.showTitle(),
      onCreate: async (name) => {
        const session = await this.createOnline(name);
        if (!session) return false;
        this.adoptSession(session);
        this.showLobby(session);
        return true;
      },
      onJoin: async (roomId, name) => {
        const session = await this.joinOnline(roomId, name);
        if (!session) return false;
        this.adoptSession(session);
        this.showLobby(session);
        return true;
      },
    });
    this.showScreen(entry);
  }

  showLobby(session: Session): void {
    this.adoptSession(session);
    let lobby: LobbyScreen;
    lobby = new LobbyScreen({
      session,
      modal: this.modal,
      toast: this.toasts,
      transportInfo: (): TransportInfo => transportInfo(session),
      onLeave: () => this.showTitle(),
      onGameStart: () => {
        if (this.session === session && this.screen === lobby) this.showGame(session);
      },
    });
    this.showScreen(lobby);
  }

  showGame(session: Session): void {
    this.adoptSession(session);
    const game = new GameScreen({ app: this, session });
    this.showScreen(game);
    void game.init();
  }

  startLocal(setup: LocalSetup): void {
    try {
      this.closeSession();
      clearLocalSave();
      const session = createLocal({ ...setup, speed: effectiveFxSpeed() });
      this.lastLocalSetup = setup;
      this.session = session;
      this.showGame(session);
    } catch (error) {
      this.toasts.show(error instanceof Error ? error.message : 'ローカル対戦を開始できませんでした', 'bad', 4000);
    }
  }

  resumeLocalGame(): void {
    try {
      const session = resumeLocal();
      if (!session) {
        this.toasts.show('保存されたゲームが見つかりませんでした', 'bad');
        return;
      }
      this.session = session;
      this.showGame(session);
    } catch {
      this.toasts.show('保存されたゲームを再開できませんでした', 'bad');
    }
  }

  rematch(): void {
    const wasLocal = this.session?.mode === 'local';
    if (wasLocal && this.lastLocalSetup) {
      this.startLocal(this.lastLocalSetup);
      return;
    }
    if (wasLocal) {
      this.showSetup('solo');
      return;
    }
    this.showOnlineEntry();
  }

  // ---------------------------------------------------------------- online helpers

  private async createOnline(name: string): Promise<Session | null> {
    try {
      return await createOnlineRoom(name);
    } catch (error) {
      this.toasts.show(
        error instanceof Error ? `ルームを作成できませんでした: ${error.message}` : 'ルームを作成できませんでした',
        'bad',
        4200,
      );
      return null;
    }
  }

  private async joinOnline(roomId: string, name: string): Promise<Session | null> {
    try {
      const exists = await roomExists(roomId);
      if (!exists) {
        this.toasts.show('そのルームは見つかりませんでした。あいことばを確認してください。', 'bad', 3600);
        return null;
      }
      return joinOnlineRoom(roomId, name);
    } catch (error) {
      this.toasts.show(
        error instanceof Error ? `参加できませんでした: ${error.message}` : 'ルームに参加できませんでした',
        'bad',
        4200,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------- dialogs

  openSettings(): void {
    openSettingsDialog(this.modal, this.session);
  }

  openHelp(): void {
    openHelpDialog(this.modal);
  }

  openCredits(): void {
    openCreditsDialog(this.modal);
  }

  // ---------------------------------------------------------------- internals

  private showScreen(screen: ScreenHandle): void {
    this.screen?.destroy();
    this.modal.closeAll();
    this.screenHost.replaceChildren(screen.el);
    this.screen = screen;
  }

  private adoptSession(session: Session): void {
    if (this.session && this.session !== session) this.session.close();
    this.session = session;
  }

  private closeSession(): void {
    if (!this.session) return;
    this.session.close();
    this.session = null;
  }

  private installGlobalHandlers(): void {
    const unlock = (): void => {
      Audio.unlock();
      document.dispatchEvent(new CustomEvent('fable:audio-unlocked'));
    };
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('keydown', unlock, { once: true, capture: true });

    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionMedia = (): void => applyMotionPreference();
    motionMedia.addEventListener?.('change', onMotionMedia);

    this.root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      if (!(target instanceof HTMLButtonElement) || target.disabled) return;
      if (target.dataset.nosound !== undefined) return;
      Audio.sfx('click');
    });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        if (this.modal.closeTop()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }
}

function normalizeRoomId(roomId: string): string {
  return roomId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 11);
}