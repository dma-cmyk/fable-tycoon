import { Audio, type VolumeKind } from '../../audio/audio';
import { h, type ModalHost } from '../dom';
import { saveUiSettings, uiSettings, type FxSpeed } from '../settings';
import { applyMotionPreference } from '../motion';

const VOLUME_ROWS: { kind: VolumeKind; label: string; icon: string }[] = [
  { kind: 'master', label: 'マスター', icon: '🔊' },
  { kind: 'voice', label: '声', icon: '🗣️' },
  { kind: 'bgm', label: 'BGM', icon: '🎵' },
  { kind: 'sfx', label: '効果音', icon: '✨' },
];

export function openSettingsDialog(modal: ModalHost): void {
  const volumeBlock = h('div', { class: 'settings-block' });
  for (const row of VOLUME_ROWS) {
    const value = Math.round(Audio.getVolume(row.kind) * 100);
    const valueLabel = h('span', { class: 'slider-value', text: `${value}%` });
    const slider = h('input', {
      class: 'range',
      attrs: {
        type: 'range',
        min: '0',
        max: '100',
        step: '5',
        value: String(value),
        'aria-label': `${row.label}の音量`,
      },
      on: {
        input: () => {
          const next = Number(slider.value);
          Audio.setVolume(row.kind, next / 100);
          valueLabel.textContent = `${next}%`;
        },
      },
    });
    volumeBlock.append(
      h(
        'div',
        { class: 'slider-row' },
        h('span', { class: 'slider-icon', text: row.icon, attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'slider-label', text: row.label }),
        slider,
        valueLabel,
      ),
    );
  }

  const speedSeg = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': '演出速度' } });
  for (const speed of [1, 2, 4] as const) {
    speedSeg.append(
      h('button', {
        class: 'seg-btn',
        text: `${speed}x`,
        attrs: { type: 'button', 'aria-pressed': String(uiSettings().fxSpeed === speed) },
        on: {
          click: () => {
            saveUiSettings({ fxSpeed: speed as FxSpeed });
            speedSeg.querySelectorAll('button').forEach((btn) => {
              btn.setAttribute('aria-pressed', String(btn.textContent === `${speed}x`));
            });
          },
        },
      }),
    );
  }

  const autoToggle = toggleButton(uiSettings().autoAdvance, (next) => saveUiSettings({ autoAdvance: next }));
  const chatToggle = toggleButton(uiSettings().showChat, (next) => saveUiSettings({ showChat: next }));
  const motionToggle = toggleButton(uiSettings().reducedMotion, (next) => {
    saveUiSettings({ reducedMotion: next });
    applyMotionPreference();
  });

  const body = h(
    'div',
    { class: 'settings-dialog' },
    h('h3', { class: 'settings-heading', text: '音量' }),
    volumeBlock,
    h('div', { class: 'divider' }),
    h('h3', { class: 'settings-heading', text: '演出' }),
    h(
      'div',
      { class: 'settings-row' },
      h(
        'div',
        { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title', text: '演出速度' }),
        h('span', { class: 'settings-row-desc', text: 'サイコロ・移動・台詞のテンポ。待ちがたまったら自動で 2 倍速。' }),
      ),
      speedSeg,
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h(
        'div',
        { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title', text: '台詞の自動送り' }),
        h('span', { class: 'settings-row-desc', text: 'オフにすると、タップするまで次の演出へ進みません。' }),
      ),
      autoToggle,
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h(
        'div',
        { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title', text: '演出を控えめにする' }),
        h('span', { class: 'settings-row-desc', text: 'キャラクター・通貨・紙吹雪の動きを抑えます。OS の「視差効果を減らす」も尊重します。' }),
      ),
      motionToggle,
    ),
    h('div', { class: 'divider' }),
    h('h3', { class: 'settings-heading', text: 'コミュニケーション' }),
    h(
      'div',
      { class: 'toggle-row' },
      h(
        'div',
        { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title', text: 'チャットを表示' }),
        h('span', { class: 'settings-row-desc', text: '受信したチャットの吹き出しとログを表示します。' }),
      ),
      chatToggle,
    ),
    h('p', {
      class: 'settings-note',
      text: '音声は最初のタップで有効になります。設定はこの端末に保存されます。',
    }),
  );

  modal.open(body, { title: '設定', subtitle: '音・演出・コミュニケーションの表示' });
}

function toggleButton(initial: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const btn = h('button', {
    class: 'toggle',
    attrs: { type: 'button', role: 'switch', 'aria-pressed': String(initial) },
    on: {
      click: () => {
        const next = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(next));
        onChange(next);
      },
    },
  });
  return btn;
}