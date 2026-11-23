import { Audio, voiceKeyOf } from '../../audio/audio';
import { GAME_DATA } from '../../data/index';
import type { Character } from '../../core/types';
import { h, type ModalHost } from '../dom';
import { characterSprite, ROLE_JA } from '../format';
import { perkInfo } from '../perks';

export interface CharacterPickerOptions {
  modal: ModalHost;
  title?: string;
  subtitle?: string;
  exclude?: ReadonlySet<string>;
  current?: string | null;
  onPick: (characterId: string) => void;
}

/** Full 48-character grid with sprite, origin, personality and perk text. */
export function openCharacterPicker(options: CharacterPickerOptions): void {
  const exclude = options.exclude ?? new Set<string>();
  let query = '';

  const grid = h('div', { class: 'char-grid' });
  const count = h('span', { class: 'char-count muted' });
  const search = h('input', {
    class: 'input char-search',
    attrs: {
      type: 'search',
      placeholder: '名前・出典・地域・性格で検索',
      'aria-label': 'キャラクターを検索',
      autocomplete: 'off',
    },
    on: {
      input: (event) => {
        query = (event.target as HTMLInputElement).value.trim();
        renderGrid();
      },
    },
  });

  const renderGrid = (): void => {
    const q = query.toLowerCase();
    const filtered = GAME_DATA.characters.filter((c) => {
      if (!q) return true;
      return `${c.nameJa} ${c.origin} ${c.originRegion} ${c.personality} ${perkInfo(c.perk).label}`
        .toLowerCase()
        .includes(q);
    });
    grid.replaceChildren();
    for (const character of filtered) {
      grid.append(characterCard(character, exclude.has(character.id), options.current === character.id, () => {
        if (exclude.has(character.id)) return;
        Audio.sfx('stamp');
        void Audio.playVoice(voiceKeyOf(`char:${character.id}`), character.lines.select);
        handle.close();
        options.onPick(character.id);
      }));
    }
    count.textContent = `${filtered.length} / ${GAME_DATA.characters.length} 人`;
    if (filtered.length === 0) {
      grid.append(h('p', { class: 'empty-note', text: '見つかりませんでした。別のことばで探してみてください。' }));
    }
  };

  const body = h(
    'div',
    { class: 'char-picker' },
    h(
      'div',
      { class: 'char-picker-toolbar' },
      search,
      count,
    ),
    h('p', {
      class: 'char-picker-hint muted',
      text: 'キャラクターごとに特性がひとつ。出典・性格・特性を見くらべて選ぼう。',
    }),
    grid,
  );

  renderGrid();

  const handle = options.modal.open(body, {
    title: options.title ?? 'キャラクターを選ぶ',
    subtitle: options.subtitle ?? '48 人の中から 1 人。特性は控えめだが、効くときは効く。',
    className: 'modal-wide char-picker-modal',
  });
}

function characterCard(
  character: Character,
  taken: boolean,
  current: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const perk = perkInfo(character.perk);
  return h(
    'button',
    {
      class: `char-card ${taken ? 'is-taken' : ''} ${current ? 'is-current' : ''}`.trim(),
      attrs: {
        type: 'button',
        'aria-label': `${character.nameJa}${taken ? '（選択中）' : ''}`,
        disabled: taken,
      },
      on: { click: onClick },
    },
    h(
      'span',
      { class: 'char-card-art', attrs: { style: `--char-color:${character.color}` } },
      h('img', {
        attrs: {
          src: characterSprite(character),
          alt: character.nameJa,
          loading: 'lazy',
          draggable: 'false',
        },
      }),
      h('span', { class: 'char-card-role', text: ROLE_JA[character.role] }),
      taken ? h('span', { class: 'char-card-taken', text: '選択中' }) : null,
      current ? h('span', { class: 'char-card-current', text: '✓ いまの相棒' }) : null,
    ),
    h('span', { class: 'char-card-name', text: character.nameJa }),
    h('span', {
      class: 'char-card-origin',
      text: `${character.origin} ・ ${character.originRegion}`,
    }),
    h('span', { class: 'char-card-personality', text: character.personality }),
    h(
      'span',
      { class: 'char-card-perk' },
      h('span', { class: 'char-card-perk-label', text: `${perk.icon} ${perk.label}` }),
      h('span', { class: 'char-card-perk-desc', text: perk.desc }),
    ),
  );
}