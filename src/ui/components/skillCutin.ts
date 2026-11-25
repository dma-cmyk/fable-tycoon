// 固有技のカットイン (2026-11 fun overhaul).
//
// 画面を斜めに切る帯 + 大きな立ち絵 + 技名。`fx.skill` を受けて再生する。
// 台詞は engine が別途 `say`（lineKey: 'skill'）で送るので、ここでは声も文字も出さない。
// 予算は FX_MS.skill / fxSpeed。`control.onSkip` で必ず後片付けする。

import type { Character, Fx } from '../../core/types';
import type { PublicState } from '../../core/engine';
import { FX_MS } from '../../net/session-types';
import { avatar, h, type ModalHandle, type ModalHost } from '../dom';
import { characterSprite, charsById, formatOku } from '../format';
import { motionReduced } from '../motion';
import '../../styles/skill.css';

export type SkillFx = Extract<Fx, { t: 'skill' }>;

export interface SkillCutinControl {
  readonly speed: number;
  readonly skipped: boolean;
  wait(ms: number): Promise<void>;
  onSkip(callback: () => void): () => void;
}

export interface SkillCutinOptions {
  character: Character;
  targetName?: string;
  targetColor?: string;
}

/** 「かぐや姫 の 五つの難題」のような見出しを組み立てる（テスト用に export）。 */
export function skillCutinHeadline(characterName: string, skillName: string): string {
  return `${characterName}の${skillName}`;
}

export class SkillCutin {
  readonly el: HTMLElement;
  private readonly band: HTMLElement;
  private readonly art: HTMLImageElement;
  private readonly artWrap: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly name: HTMLElement;
  private readonly owner: HTMLElement;
  private readonly target: HTMLElement;
  private readonly flash: HTMLElement;

  constructor() {
    this.flash = h('div', { class: 'skill-cutin-flash', attrs: { 'aria-hidden': 'true' } });
    this.band = h('div', { class: 'skill-cutin-band', attrs: { 'aria-hidden': 'true' } });
    this.art = h('img', {
      class: 'skill-cutin-art',
      attrs: { alt: '', draggable: 'false' },
    });
    this.artWrap = h('div', { class: 'skill-cutin-art-wrap' }, this.art);
    this.kicker = h('span', { class: 'skill-cutin-kicker', text: '固有技' });
    this.name = h('strong', { class: 'skill-cutin-name' });
    this.owner = h('span', { class: 'skill-cutin-owner' });
    this.target = h('span', { class: 'skill-cutin-target', attrs: { hidden: 'hidden' } });
    this.el = h(
      'div',
      { class: 'skill-cutin', attrs: { hidden: 'hidden', 'aria-live': 'polite' } },
      this.flash,
      this.band,
      this.artWrap,
      h('div', { class: 'skill-cutin-text' }, this.kicker, this.owner, this.name, this.target),
    );
  }

  async play(fx: SkillFx, options: SkillCutinOptions, control: SkillCutinControl): Promise<void> {
    const { character } = options;
    const reduced = motionReduced();
    this.el.hidden = false;
    this.el.classList.remove('is-in', 'is-out', 'is-targeted');
    this.el.style.setProperty('--skill-color', character.color);
    this.el.style.setProperty('--skill-ink', readableInk(character.color));
    this.art.src = characterSprite(character);
    this.art.className = `skill-cutin-art ${character.role === 'royal' || character.role === 'villain' ? 'is-grand' : ''}`.trim();
    this.kicker.textContent = '固有技';
    this.name.textContent = fx.name;
    this.owner.textContent = `${character.nameJa} の固有技`;
    if (options.targetName) {
      this.target.hidden = false;
      this.target.textContent = `▶ ${options.targetName}`;
      this.target.style.setProperty('--target-color', options.targetColor ?? '#ffd23f');
      this.el.classList.add('is-targeted');
    } else {
      this.target.hidden = true;
    }
    const budget = FX_MS.skill / Math.max(1, control.speed);
    this.el.style.setProperty('--skill-in', `${reduced ? 1 : Math.max(90, Math.round(budget * 0.16))}ms`);
    this.el.style.setProperty('--skill-hold', `${Math.max(120, Math.round(budget * 0.6))}ms`);

    void this.el.offsetWidth;
    this.el.classList.add('is-in');
    const timer = globalThis.setTimeout(() => {
      if (!this.el.hidden) this.el.classList.add('is-out');
    }, Math.max(0, budget * (reduced ? 0.2 : 0.72)));

    control.onSkip(() => this.hide());
    try {
      await control.wait(FX_MS.skill);
    } finally {
      globalThis.clearTimeout(timer);
      this.hide();
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.el.classList.remove('is-in', 'is-out', 'is-targeted');
  }
}

/** 帯の上に置く文字色。明度で白/黒を選ぶ。 */
export function readableInk(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  if (!Number.isFinite(r + g + b)) return '#ffffff';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#1b1408' : '#ffffff';
}

// ---------------------------------------------------------------- command panel / target picker

export interface SkillCommandOptions {
  modal: ModalHost;
  state: PublicState;
  playerId: number;
  canAct: boolean;
  /** skill_target フェーズ中なら対象選択の案内を出す。 */
  waitingForTarget?: boolean;
  onUse: () => void;
}

/** HUD の「固有技」ボタンから開く説明パネル。 */
export function openSkillCommand(options: SkillCommandOptions): ModalHandle {
  const player = options.state.players[options.playerId];
  const character = player ? charsById.get(player.characterId) : undefined;
  const skill = character?.skill;
  const usedThisYear = player?.skillUsedYear === options.state.year;
  const phase = options.state.phase;
  const atTurnStart = phase.t === 'turn_start';
  const ready = options.canAct && atTurnStart && !usedThisYear && !!skill && !options.waitingForTarget;
  const body = h('div', { class: 'skill-command' });
  if (!character || !skill) {
    body.append(h('p', { class: 'muted', text: 'このキャラクターには固有技がありません。' }));
    return options.modal.open(body, { title: '✨ 固有技', className: 'modal-narrow' });
  }

  const stateLabel = usedThisYear
    ? { cls: 'is-used', text: '❌ 今年はもう使った（来年また使える）' }
    : !atTurnStart
      ? { cls: 'is-waiting', text: '⌛ 手番開始のときだけ使える' }
      : options.waitingForTarget
        ? { cls: 'is-waiting', text: '🎯 対象を選んでください' }
        : ready
          ? { cls: 'is-ready', text: '✅ 今すぐ使える（この手番はまだサイコロをふれる）' }
          : { cls: 'is-waiting', text: '⌛ 自分の手番になると使える' };

  body.append(
    h(
      'div',
      { class: 'skill-command-head', attrs: { style: `--skill-color:${character.color}` } },
      h('span', { class: 'skill-command-icon', text: '✨' }),
      h(
        'span',
        { class: 'skill-command-main' },
        h('strong', { class: 'skill-command-name', text: skill.name }),
        h('span', { class: 'skill-command-owner', text: `${character.nameJa} の固有技` }),
      ),
    ),
    h('p', { class: 'skill-command-desc', text: skill.desc }),
    h('div', { class: `skill-command-state ${stateLabel.cls}` }, h('span', { text: stateLabel.text })),
    skill.target === 'player'
      ? h('p', { class: 'muted', text: '発動すると対象を選ぶ画面になります（キャンセルすれば使いません）。' })
      : h('p', { class: 'muted', text: '1 年 1 回だけ。使っても、この手番でサイコロをふれます。' }),
    h(
      'div',
      { class: 'target-footer' },
      h('span', { class: 'muted', text: 'キーボードの 6 でも開けます。' }),
      h('button', {
        class: 'btn btn-gold',
        text: usedThisYear ? '今年は使用済み' : 'この固有技を発動する',
        attrs: { type: 'button', disabled: !ready },
        on: {
          click: () => {
            if (!ready) return;
            options.onUse();
          },
        },
      }),
    ),
  );
  return options.modal.open(body, { title: `✨ ${skill.name}`, subtitle: 'キャラクター固有技（1 年 1 回）', className: 'modal-narrow' });
}

export interface SkillTargetOptions {
  modal: ModalHost;
  state: PublicState;
  options: string[];
  canAct: boolean;
  onTarget: (target: string) => void;
  onCancel: () => void;
}

/** 固有技の対象（プレイヤー）を選ぶ。カードの対象選択と同じ見た目を使う。 */
export function openSkillTargetDialog(options: SkillTargetOptions): ModalHandle {
  const actor = options.state.players[options.state.current];
  const body = h('div', { class: 'target-dialog' });
  body.append(
    h('p', {
      class: 'target-copy',
      text: '固有技の対象を選んでください。選ぶとすぐ発動します。キャンセルすると技は温存されます。',
    }),
  );
  const list = h('div', { class: 'target-list' });
  for (const target of options.options) {
    const player = options.state.players[Number(target)];
    const character = player ? charsById.get(player.characterId) : undefined;
    const button = h(
      'button',
      {
        class: 'target-item',
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (!options.canAct) return;
            button.disabled = true;
            button.classList.add('is-busy');
            options.onTarget(target);
          },
        },
      },
      player
        ? avatar(characterSprite(character), character?.color ?? '#8a6d3b', 46)
        : h('span', { class: 'target-icon', text: '👤' }),
      h(
        'span',
        { class: 'target-main' },
        h('span', { class: 'target-name', text: player?.name ?? `プレイヤー ${target}` }),
        h('span', {
          class: 'target-meta muted',
          text: player ? `${character?.nameJa ?? ''} ・ 所持金 ${formatOku(player.cash)}` : '',
        }),
      ),
      h('span', { class: 'target-go', text: '▶' }),
    );
    button.disabled = !options.canAct;
    list.append(button);
  }
  if (options.options.length === 0) list.append(h('p', { class: 'empty-state', text: '選べる相手がいません。' }));
  body.append(list);
  if (options.canAct) {
    body.append(
      h(
        'div',
        { class: 'target-footer' },
        h('span', { class: 'muted', text: 'キャンセルすると技は来年まで残ります。' }),
        h('button', {
          class: 'btn btn-ghost',
          text: 'キャンセル',
          attrs: { type: 'button' },
          on: {
            click: (event) => {
              (event.currentTarget as HTMLButtonElement).disabled = true;
              options.onCancel();
            },
          },
        }),
      ),
    );
  } else {
    body.append(h('p', { class: 'muted center', text: `${actor?.name ?? '手番の人'} が対象を選んでいます…` }));
  }
  return options.modal.open(body, {
    title: '✨ 固有技 — 対象を選ぶ',
    subtitle: '対象をえらぶと効果が発動します',
    className: 'target-modal',
    dismissible: !options.canAct,
  });
}
