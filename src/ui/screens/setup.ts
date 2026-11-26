import { Audio } from '../../audio/audio';
import { ALLOWED_YEARS } from '../../core/engine';
import type { PlayerSetup } from '../../core/types';
import type { LocalSetup } from '../../net/local-session';
import { GAME_DATA } from '../../data/index';
import { clear, h, iconButton, type ModalHost } from '../dom';
import { characterSprite, charsById } from '../format';
import { perkInfo } from '../perks';
import { readSavedName, saveName } from '../settings';
import { openCharacterPicker } from '../components/charPicker';
import { assignDistinctIds, pickRandom } from '../randomPick';
import { readSetupPrefs, saveSetupPrefs } from '../setupPrefs';
import type { ScreenHandle, SetupMode } from './types';

type SeatKind = 'human' | 'cpu' | 'none';

interface SeatDraft {
  kind: SeatKind;
  name: string;
  cpuLevel: 1 | 2 | 3;
  characterId: string;
}

const DEFAULT_CHARS = ['momotaro', 'red_hood', 'aladdin', 'kaguya'];
const YEAR_CHOICES = ALLOWED_YEARS;

export interface SetupScreenOptions {
  mode: SetupMode;
  modal: ModalHost;
  onBack: () => void;
  onStart: (setup: LocalSetup) => void;
}

export class SetupScreen implements ScreenHandle {
  readonly el: HTMLElement;
  private readonly modal: ModalHost;
  private readonly onStart: (setup: LocalSetup) => void;
  private readonly mode: SetupMode;
  private readonly seats: SeatDraft[] = [];
  private years = 3;
  private randomCpusOnStart = false;
  private readonly seatsHost: HTMLElement;
  private readonly footerHint: HTMLElement;
  private readonly startButton: HTMLButtonElement;

  constructor(options: SetupScreenOptions) {
    this.modal = options.modal;
    this.onStart = options.onStart;
    this.mode = options.mode;
    const savedName = readSavedName();
    this.randomCpusOnStart = readSetupPrefs().randomCpusOnStart;

    const seatIndexes = [0, 1, 2, 3];
    for (const index of seatIndexes) {
      const character = charsById.get(DEFAULT_CHARS[index]) ?? GAME_DATA.characters[index];
      const kind: SeatKind =
        options.mode === 'solo'
          ? index === 0
            ? 'human'
            : 'cpu'
          : index < 2
            ? 'human'
            : 'none';
      const name =
        kind === 'human'
          ? index === 0 && savedName
            ? savedName
            : options.mode === 'hotseat'
              ? `プレイヤー${index + 1}`
              : 'あなた'
          : '';
      this.seats.push({
        kind,
        name,
        cpuLevel: index === 0 ? 2 : (((index - 1) % 3) + 1) as 1 | 2 | 3,
        characterId: character?.id ?? GAME_DATA.characters[0].id,
      });
    }

    this.seatsHost = h('div', { class: 'setup-seats' });
    this.footerHint = h('p', { class: 'setup-hint muted' });
    this.startButton = h('button', {
      class: 'btn btn-gold setup-start',
      attrs: { type: 'button' },
      on: { click: () => this.startGame() },
    });
    this.mobileStart = h('button', {
      class: 'btn btn-gold setup-mobile-start',
      attrs: { type: 'button' },
      on: { click: () => this.startGame() },
    });

    const yearsHost = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'ゲーム年数' } });
    for (const years of YEAR_CHOICES) {
      const btn = h('button', {
        class: 'seg-btn',
        text: `${years}年`,
        attrs: { type: 'button', 'aria-pressed': String(this.years === years) },
        on: {
          click: () => {
            this.years = years;
            yearsHost.querySelectorAll('button').forEach((node) => {
              node.setAttribute('aria-pressed', String(node.textContent === `${years}年`));
            });
            this.refreshFooter();
          },
        },
      });
      yearsHost.append(btn);
    }

    const randomCpuButton = h('button', {
      class: 'btn btn-ghost btn-small setup-random-cpus',
      text: '🎲 CPUをランダムにする',
      attrs: { type: 'button' },
      on: { click: () => this.randomizeCpus() },
    });
    const startRandomToggle = h('button', {
      class: 'toggle',
      attrs: {
        type: 'button',
        role: 'switch',
        'aria-pressed': String(this.randomCpusOnStart),
        'aria-label': 'ゲーム開始時にCPUを毎回ランダムにする',
      },
      on: {
        click: () => {
          this.randomCpusOnStart = !this.randomCpusOnStart;
          startRandomToggle.setAttribute('aria-pressed', String(this.randomCpusOnStart));
          saveSetupPrefs({ randomCpusOnStart: this.randomCpusOnStart });
        },
      },
    });
    this.randomCpuButton = randomCpuButton;

    const content = h(
      'div',
      { class: 'setup-body' },
      h(
        'section',
        { class: 'panel setup-panel' },
        h(
          'div',
          { class: 'setup-panel-head' },
          h('h2', { class: 'section-title', text: 'プレイヤー席' }),
          h('span', {
            class: 'badge badge-gold',
            text: options.mode === 'solo' ? 'CPU 対戦' : 'ホットシート',
          }),
        ),
        this.seatsHost,
        h(
          'div',
          { class: 'setup-seat-tools' },
          randomCpuButton,
          h('span', { class: 'muted setup-tools-note', text: '各席の 🎲 で 1 人ずつ引き直せます。' }),
        ),
      ),
      h(
        'aside',
        { class: 'setup-side' },
        h(
          'section',
          { class: 'panel setup-panel setup-options' },
          h('h2', { class: 'section-title', text: 'ゲーム設定' }),
          h(
            'div',
            { class: 'setup-option-row' },
            h('span', { class: 'setup-option-label', text: '年数' }),
            yearsHost,
            h('span', { class: 'muted setup-option-note', text: '4月開始・3月決算' }),
          ),
          h(
            'div',
            { class: 'setup-option-row' },
            h('span', { class: 'setup-option-label', text: 'CPU' }),
            startRandomToggle,
            h('span', { class: 'muted setup-option-note', text: 'ゲーム開始時に毎回ランダム（CPU のキャラを引き直す）' }),
          ),
          h(
            'div',
            { class: 'setup-rule-note' },
            h('p', { text: '🎯 目的地一番乗りでボーナス。一番遠い人には取り立て屋が憑く。' }),
            h('p', { text: '🏙️ 都市の物件を買い、独占で収益 2 倍。総資産で勝負が決まる。' }),
            h('p', { text: '💬 手番外でもチャットとエモートで賑やかに。' }),
          ),
        ),
        h(
          'section',
          { class: 'panel setup-panel setup-summary' },
          h('h2', { class: 'section-title', text: '出発準備' }),
          h('p', { class: 'muted', text: '全員 100 億円と、性格の違う特性ひとつを持って世界へ。' }),
          this.footerHint,
          this.startButton,
        ),
      ),
    );

    this.el = h(
      'div',
      { class: 'screen setup-screen' },
      h(
        'header',
        { class: 'setup-header' },
        iconButton('‹', 'もどる', options.onBack, { class: 'setup-back', sound: true }),
        h(
          'div',
          { class: 'setup-title-wrap' },
          h('h1', { class: 'setup-title', text: options.mode === 'solo' ? 'ひとりで遊ぶ' : 'みんなで遊ぶ' }),
          h('p', {
            class: 'setup-subtitle',
            text:
              options.mode === 'solo'
                ? '1 人 + CPU で世界の富を争う'
                : '同じ端末を回して 2〜4 人で遊ぶ',
          }),
        ),
        h('span', { class: 'setup-header-mark', text: '🌍', attrs: { 'aria-hidden': 'true' } }),
      ),
      h('div', { class: 'setup-scroll scroll-y' }, content),
      this.mobileStart,
    );

    this.renderSeats();
    this.refreshFooter();

    const bgm = () => Audio.bgm('title');
    const onUnlocked = () => bgm();
    document.addEventListener('fable:audio-unlocked', onUnlocked);
    this.cleanupFns.push(() => document.removeEventListener('fable:audio-unlocked', onUnlocked), () => Audio.bgm(null));
    bgm();
  }

  private readonly mobileStart: HTMLButtonElement;
  private readonly randomCpuButton: HTMLButtonElement;
  private readonly cleanupFns: (() => void)[] = [];

  destroy(): void {
    for (const fn of this.cleanupFns) fn();
  }

  private characterNames(): Map<string, number> {
    const taken = new Map<string, number>();
    this.seats.forEach((seat, index) => {
      if (seat.kind !== 'none') taken.set(seat.characterId, index);
    });
    return taken;
  }

  private renderSeats(): void {
    clear(this.seatsHost);
    this.seats.forEach((seat, index) => {
      this.seatsHost.append(this.renderSeat(seat, index));
    });
  }

  private renderSeat(seat: SeatDraft, index: number): HTMLElement {
    const character = charsById.get(seat.characterId);
    const kinds: SeatKind[] =
      this.mode === 'solo' && index === 0 ? ['human'] : this.mode === 'solo' ? ['cpu', 'none'] : ['human', 'cpu', 'none'];
    const kindSeg =
      kinds.length === 1
        ? h('span', {
            class: 'seat-kind-static',
            text: kinds[0] === 'human' ? '人間' : kinds[0] === 'cpu' ? 'CPU' : 'なし',
          })
        : h('div', { class: 'seg seat-kind-seg', attrs: { role: 'group', 'aria-label': `${index + 1}席の種類` } });
    if (kinds.length > 1) {
      for (const kind of kinds) {
        kindSeg.append(
          h('button', {
            class: 'seg-btn',
            text: kind === 'human' ? '人間' : kind === 'cpu' ? 'CPU' : 'なし',
            attrs: { type: 'button', 'aria-pressed': String(seat.kind === kind) },
            on: {
              click: () => {
                seat.kind = kind;
                if (kind !== 'none') this.ensureUniqueCharacter(index);
                this.renderSeats();
                this.refreshFooter();
              },
            },
          }),
        );
      }
    }

    const nameInput =
      seat.kind === 'none'
        ? null
        : h('input', {
            class: 'input seat-name',
            attrs: {
              type: 'text',
              maxlength: '12',
              value: seat.name,
              placeholder: seat.kind === 'cpu' ? character?.nameJa ?? 'CPU' : `プレイヤー${index + 1}`,
              'aria-label': `${index + 1}席の名前`,
              autocomplete: 'off',
            },
            on: {
              input: (event) => {
                seat.name = (event.target as HTMLInputElement).value;
              },
            },
          });

    const cpuSeg =
      seat.kind === 'cpu'
        ? h(
            'div',
            { class: 'seg cpu-level-seg', attrs: { role: 'group', 'aria-label': 'CPU レベル' } },
            ...[1, 2, 3].map((level) =>
              h('button', {
                class: 'seg-btn',
                text: `Lv${level}`,
                attrs: { type: 'button', 'aria-pressed': String(seat.cpuLevel === level) },
                on: {
                  click: () => {
                    seat.cpuLevel = level as 1 | 2 | 3;
                    this.renderSeats();
                  },
                },
              }),
            ),
          )
        : null;

    const characterButton =
      seat.kind !== 'none'
        ? h(
            'div',
            { class: 'seat-char-row' },
            h(
              'button',
              {
                class: 'seat-char',
                attrs: { type: 'button', 'aria-label': `${index + 1}席のキャラクターを選ぶ` },
                on: {
                  click: () => {
                    openCharacterPicker({
                      modal: this.modal,
                      title: `${index + 1}席のキャラクター`,
                      exclude: this.takenByOthers(index),
                      current: seat.characterId,
                      onPick: (characterId) => {
                        seat.characterId = characterId;
                        this.renderSeats();
                      },
                    });
                  },
                },
              },
              h(
                'span',
                { class: 'seat-char-art', attrs: { style: `--char-color:${character?.color ?? '#9fb3d9'}` } },
                h('img', {
                  attrs: {
                    src: characterSprite(character),
                    alt: character?.nameJa ?? '',
                    // Matches .seat-char-art so a slow portrait cannot resize the seat row.
                    width: '58',
                    height: '62',
                    decoding: 'async',
                    draggable: 'false',
                    loading: 'lazy',
                  },
                }),
              ),
              h(
                'span',
                { class: 'seat-char-info' },
                h('span', { class: 'seat-char-name', text: character?.nameJa ?? '未選択' }),
                h('span', { class: 'seat-char-origin', text: character ? `${character.origin} ・ ${character.originRegion}` : '' }),
                character
                  ? h(
                      'span',
                      { class: 'seat-char-perk' },
                      h('span', { text: `${perkInfo(character.perk).icon} ${perkInfo(character.perk).label}` }),
                      h('span', { class: 'seat-char-perk-desc', text: perkInfo(character.perk).desc }),
                    )
                  : null,
              ),
              h('span', { class: 'seat-char-edit', text: '変更', attrs: { 'aria-hidden': 'true' } }),
            ),
            h(
              'button',
              {
                class: 'seat-char-random',
                attrs: {
                  type: 'button',
                  'aria-label': `${index + 1}席のキャラクターをランダムに選ぶ`,
                  title: 'ランダムに選ぶ',
                },
                on: { click: () => this.rerollSeat(index) },
              },
              h('span', { class: 'seat-char-random-icon', text: '🎲', attrs: { 'aria-hidden': 'true' } }),
              h('span', { class: 'seat-char-random-label', text: 'ランダム' }),
            ),
          )
        : h('div', { class: 'seat-empty' }, h('span', { text: 'この席はつかいません' }));

    return h(
      'article',
      { class: `seat-card ${seat.kind === 'none' ? 'seat-card-off' : ''}`.trim() },
      h(
        'div',
        { class: 'seat-card-top' },
        h(
          'span',
          { class: `seat-index seat-index-${index + 1}` },
          h('span', { text: `${index + 1}P` }),
        ),
        kindSeg,
        cpuSeg,
      ),
      nameInput,
      characterButton,
    );
  }

  private ensureUniqueCharacter(selfIndex: number): void {
    const seat = this.seats[selfIndex];
    if (seat.kind === 'none') return;
    const taken = this.characterNames();
    const duplicate = [...taken.entries()].find(
      ([characterId, index]) => characterId === seat.characterId && index !== selfIndex,
    );
    if (!duplicate) return;
    const free = GAME_DATA.characters.find((character) => !taken.has(character.id));
    if (free) seat.characterId = free.id;
  }

  /** Ids owned by every seat except `selfIndex`; used as picker exclusions. */
  private takenByOthers(selfIndex: number): Set<string> {
    const taken = new Set<string>();
    this.seats.forEach((other, otherIndex) => {
      if (otherIndex !== selfIndex && other.kind !== 'none') taken.add(other.characterId);
    });
    return taken;
  }

  /** Re-rolls one seat's character, avoiding every other occupied seat. */
  private rerollSeat(index: number, announce = true): void {
    const seat = this.seats[index];
    if (!seat || seat.kind === 'none') return;
    const taken = this.takenByOthers(index);
    const pool = GAME_DATA.characters.filter((character) => !taken.has(character.id)).map((character) => character.id);
    const picked = pickRandom(pool);
    if (!picked) return;
    seat.characterId = picked;
    this.renderSeats();
    if (announce) Audio.sfx('stamp');
  }

  /** Gives every CPU seat a distinct character, keeping the human picks untouched. */
  private randomizeCpus(announce = true): void {
    const humanIds = new Set(
      this.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.characterId),
    );
    const cpuIndexes = this.seats.map((seat, index) => ({ seat, index })).filter(({ seat }) => seat.kind === 'cpu');
    if (cpuIndexes.length === 0) return;
    const pool = GAME_DATA.characters.map((character) => character.id);
    const picked = assignDistinctIds(pool, cpuIndexes.length, humanIds);
    if (picked.length < cpuIndexes.length) return;
    cpuIndexes.forEach(({ seat }, order) => {
      seat.characterId = picked[order];
    });
    this.renderSeats();
    this.refreshFooter();
    if (announce) Audio.sfx('stamp');
  }

  private startGame(): void {
    if (this.randomCpusOnStart) this.randomizeCpus(false);
    const setup = this.buildSetup();
    if (!setup) return;
    saveName(this.seats.find((seat) => seat.kind === 'human')?.name.trim() ?? '');
    this.onStart(setup);
  }

  private buildSetup(): LocalSetup | null {
    const active = this.seats.filter((seat) => seat.kind !== 'none');
    if (active.length < 2) {
      this.modal.open(
        h('div', { class: 'modal-copy' }, h('p', { text: '2 人以上で開始してください。CPU を追加するか、人間の席を増やしてください。' })),
        { title: 'あと 1 人足りません' },
      );
      return null;
    }
    if (!active.some((seat) => seat.kind === 'human')) {
      this.modal.open(h('div', { class: 'modal-copy' }, h('p', { text: '人間のプレイヤーが 1 人以上必要です。' })), {
        title: '人間がいません',
      });
      return null;
    }
    const ids = new Set(active.map((seat) => seat.characterId));
    if (ids.size !== active.length) {
      this.modal.open(h('div', { class: 'modal-copy' }, h('p', { text: '同じキャラクターは選べません。別のキャラクターにしてください。' })), {
        title: 'キャラクターが重複',
      });
      return null;
    }
    const players: PlayerSetup[] = [];
    this.seats.forEach((seat, index) => {
      if (seat.kind === 'none') return;
      const character = charsById.get(seat.characterId);
      const fallback = seat.kind === 'human' ? `プレイヤー${index + 1}` : character?.nameJa ?? `CPU${index + 1}`;
      players.push({
        name: (seat.name.trim() || fallback).slice(0, 12),
        characterId: seat.characterId,
        isCpu: seat.kind === 'cpu',
        ...(seat.kind === 'cpu' ? { cpuLevel: seat.cpuLevel } : {}),
      });
    });
    return { players, years: this.years };
  }

  private refreshFooter(): void {
    const active = this.seats.filter((seat) => seat.kind !== 'none');
    const humans = active.filter((seat) => seat.kind === 'human').length;
    const cpus = active.length - humans;
    const valid = active.length >= 2 && humans >= 1;
    this.startButton.disabled = !valid;
    this.startButton.textContent = valid
      ? `▶ ${active.length}人で ${this.years}年 はじめる`
      : '2人以上で開始できます';
    this.mobileStart.disabled = !valid;
    this.mobileStart.textContent = valid ? `▶ ${active.length}人で ${this.years}年 はじめる` : '2人以上で開始できます';
    this.footerHint.textContent = valid
      ? `人間 ${humans} 人 + CPU ${cpus} 人 ・ ${this.years} 年 ・ 全員 100 億円スタート`
      : '「なし」の席を減らすか、CPU を追加してください。';
    this.randomCpuButton.disabled = cpus === 0;
  }
}