import { Audio, voiceKeyOf } from '../../audio/audio';
import { GAME_DATA } from '../../data/index';
import type { Character, CharacterRole } from '../../core/types';
import { h, type ModalHandle, type ModalHost } from '../dom';
import { characterSprite, ROLE_JA } from '../format';
import { perkInfo } from '../perks';
import {
  filterCharacters,
  hasActiveFilters,
  PERK_GROUPS,
  perkGroupOf,
  REGION_GROUPS,
  regionGroupOf,
  type CharacterFilterState,
} from '../charFilter';

export interface CharacterPickerOptions {
  modal: ModalHost;
  title?: string;
  subtitle?: string;
  exclude?: ReadonlySet<string>;
  current?: string | null;
  onPick: (characterId: string) => void;
}

const ROLES = Object.keys(ROLE_JA) as CharacterRole[];

const DEFAULT_FILTERS: CharacterFilterState = {
  query: '',
  region: 'all',
  role: 'all',
  perkGroup: 'all',
  availableOnly: false,
};

let rememberedFilters: CharacterFilterState = { ...DEFAULT_FILTERS };

/** 48-character picker with filters, preview-only cards and an explicit confirm. */
export function openCharacterPicker(options: CharacterPickerOptions): void {
  const exclude = options.exclude ?? new Set<string>();
  let filters: CharacterFilterState = { ...rememberedFilters };
  let previewId: string | null = options.current && !exclude.has(options.current) ? options.current : null;
  let handle: ModalHandle | null = null;

  const grid = h('div', { class: 'char-grid' });
  const empty = h('div', { class: 'char-empty', attrs: { hidden: 'hidden' } });
  const count = h('span', { class: 'char-count', attrs: { 'aria-live': 'polite' } });
  const filterHost = h('div', { class: 'char-filters' });
  const detail = h('aside', { class: 'char-detail', attrs: { 'aria-live': 'polite' } });
  const reset = h('button', {
    class: 'btn btn-ghost btn-small char-filter-reset',
    text: '条件をリセット',
    attrs: { type: 'button' },
    on: { click: () => resetFilters() },
  });

  const search = h('input', {
    class: 'input char-search',
    attrs: {
      type: 'search',
      placeholder: '名前・出典・地域・性格で検索',
      'aria-label': 'キャラクターを検索',
      autocomplete: 'off',
      value: filters.query,
    },
    on: {
      input: (event) => {
        filters = { ...filters, query: (event.target as HTMLInputElement).value };
        remember();
        render();
      },
    },
  });

  const available = h('button', {
    class: 'chip chip-small char-available-toggle',
    attrs: { type: 'button', 'aria-pressed': String(filters.availableOnly) },
    on: {
      click: () => {
        filters = { ...filters, availableOnly: !filters.availableOnly };
        remember();
        render();
      },
    },
  });

  const chipsFor = <T extends string>(
    allLabel: string,
    optionsList: ReadonlyArray<{ id: T; label: string; count: number }>,
    selected: T | 'all',
    onSelect: (value: T | 'all') => void,
  ): HTMLElement[] => {
    const total = optionsList.reduce((sum, option) => sum + option.count, 0);
    const make = (id: T | 'all', label: string, valueCount: number): HTMLElement =>
      h('button', {
        class: 'chip chip-small char-filter-chip',
        attrs: { type: 'button', 'aria-pressed': String(selected === id) },
        on: { click: () => onSelect(id) },
      },
        h('span', { text: label }),
        h('span', { class: 'char-filter-count', text: String(valueCount) }),
      );
    return [make('all', allLabel, total), ...optionsList.map((option) => make(option.id, option.label, option.count))];
  };

  const regionOptions = REGION_GROUPS.map((group) => ({
    ...group,
    count: GAME_DATA.characters.filter((character) => regionGroupOf(character.originRegion) === group.id).length,
  }));
  const roleOptions = ROLES.map((role) => ({
    id: role,
    label: ROLE_JA[role],
    count: GAME_DATA.characters.filter((character) => character.role === role).length,
  }));
  const perkOptions = PERK_GROUPS.map((group) => ({
    ...group,
    count: GAME_DATA.characters.filter((character) => perkGroupOf(character.perk) === group.id).length,
  }));

  const renderFilters = (): void => {
    available.setAttribute('aria-pressed', String(filters.availableOnly));
    available.className = `chip chip-small char-available-toggle ${filters.availableOnly ? 'is-selected' : ''}`.trim();
    available.replaceChildren(
      h('span', { text: '空いているキャラだけ', attrs: { 'aria-hidden': 'true' } }),
    );
    reset.hidden = !hasActiveFilters(filters);
    filterHost.replaceChildren(
      filterRow(
        '地域',
        chipsFor('すべて', regionOptions, filters.region, (region) => {
          filters = { ...filters, region };
          remember();
          render();
        }),
      ),
      filterRow(
        'タイプ',
        chipsFor('すべて', roleOptions, filters.role, (role) => {
          filters = { ...filters, role };
          remember();
          render();
        }),
      ),
      filterRow(
        '特性',
        chipsFor('すべて', perkOptions, filters.perkGroup, (perkGroup) => {
          filters = { ...filters, perkGroup };
          remember();
          render();
        }),
      ),
    );
  };

  const syncPreview = (): void => {
    grid.querySelectorAll<HTMLElement>('.char-card').forEach((card) => {
      const selected = card.dataset.character === previewId;
      card.classList.toggle('is-previewed', selected);
      card.setAttribute('aria-pressed', String(selected));
    });
    renderDetail();
  };

  const renderDetail = (): void => {
    const character = previewId ? GAME_DATA.characters.find((candidate) => candidate.id === previewId) : null;
    detail.replaceChildren();
    if (!character) {
      detail.append(
        h('div', { class: 'char-detail-empty' },
          h('span', { class: 'char-detail-empty-icon', text: '👤', attrs: { 'aria-hidden': 'true' } }),
          h('p', { text: 'キャラクターをえらぶと、紹介文と特性を確認できます。' }),
        ),
        h('button', {
          class: 'btn btn-gold char-confirm',
          text: 'キャラをえらんでください',
          attrs: { type: 'button', disabled: true },
        }),
      );
      return;
    }
    const perk = perkInfo(character.perk);
    const confirm = h('button', {
      class: 'btn btn-gold char-confirm',
      text: 'このキャラにする',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (!previewId) return;
          handle?.close();
          options.onPick(previewId);
        },
      },
    });
    detail.append(
      h('div', { class: 'char-detail-art-wrap' },
        h('img', {
          class: 'char-detail-art',
          attrs: { src: characterSprite(character), alt: character.nameJa, draggable: 'false' },
        }),
        h('span', { class: 'char-card-role char-detail-role', text: ROLE_JA[character.role] }),
      ),
      h('div', { class: 'char-detail-name-row' },
        h('h3', { class: 'char-detail-name', text: character.nameJa }),
        options.current === character.id ? h('span', { class: 'badge badge-gold', text: '✓ いまの相棒' }) : null,
      ),
      h('p', { class: 'char-detail-origin', text: `${character.origin} ・ ${character.originRegion}` }),
      h('p', { class: 'char-detail-personality', text: character.personality }),
      h('details', { class: 'char-detail-profile' },
        h('summary', { text: 'プロフィール' }),
        h('p', { text: character.personality }),
      ),
      h('div', { class: 'char-detail-perk' },
        h('span', { class: 'char-detail-perk-label', text: `${perk.icon} ${perk.label}` }),
        h('p', { class: 'char-detail-perk-desc', text: perk.desc }),
      ),
      confirm,
    );
  };

  const render = (): void => {
    const filtered = filterCharacters(GAME_DATA.characters, filters, exclude);
    grid.replaceChildren();
    for (const character of filtered) {
      const taken = exclude.has(character.id);
      grid.append(
        characterCard(character, taken, options.current === character.id, previewId === character.id, () => {
          if (taken) return;
          previewId = character.id;
          Audio.sfx('stamp');
          void Audio.playVoice(voiceKeyOf(`char:${character.id}`), character.lines.select);
          syncPreview();
        }),
      );
    }
    grid.hidden = filtered.length === 0;
    empty.hidden = filtered.length > 0;
    empty.replaceChildren(
      h('span', { class: 'char-empty-icon', text: '🔎', attrs: { 'aria-hidden': 'true' } }),
      h('p', { text: '条件に合うキャラクターがいません。条件を変えてみてください。' }),
      h('button', {
        class: 'btn btn-gold char-empty-reset',
        text: '条件をリセット',
        attrs: { type: 'button' },
        on: { click: () => resetFilters() },
      }),
    );
    count.textContent = `${filtered.length} / ${GAME_DATA.characters.length} 人`;
    count.hidden = false;
    renderFilters();
    renderDetail();
    syncPreview();
  };

  const resetFilters = (): void => {
    filters = { ...DEFAULT_FILTERS };
    search.value = '';
    remember();
    render();
  };

  const remember = (): void => {
    rememberedFilters = { ...filters };
  };

  const toolbar = h(
    'div',
    { class: 'char-picker-toolbar' },
    search,
    available,
    reset,
    count,
  );

  const body = h(
    'div',
    { class: 'char-picker' },
    toolbar,
    filterHost,
    h(
      'div',
      { class: 'char-picker-main' },
      h('div', { class: 'char-results' }, grid, empty),
      detail,
    ),
  );

  handle = options.modal.open(body, {
    title: options.title ?? 'キャラクターを選ぶ',
    subtitle: options.subtitle ?? '48 人の中から 1 人。まずは候補を絞り、紹介文を読んで決めよう。',
    className: 'modal-wide char-picker-modal',
  });
  render();
}

function filterRow(label: string, chips: HTMLElement[]): HTMLElement {
  return h(
    'div',
    { class: 'char-filter-row' },
    h('span', { class: 'char-filter-label', text: label }),
    h('div', { class: 'char-filter-chips' }, ...chips),
  );
}

function characterCard(
  character: Character,
  taken: boolean,
  current: boolean,
  previewed: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const perk = perkInfo(character.perk);
  return h(
    'button',
    {
      class: `char-card ${taken ? 'is-taken' : ''} ${current ? 'is-current' : ''} ${previewed ? 'is-previewed' : ''}`.trim(),
      attrs: {
        type: 'button',
        'aria-label': `${character.nameJa}${taken ? '（選択中）' : ''}。プレビュー`,
        'aria-pressed': String(previewed),
        disabled: taken,
      },
      dataset: { character: character.id },
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
      current ? h('span', { class: 'char-card-current', text: '✓' }) : null,
    ),
    h('span', { class: 'char-card-name', text: character.nameJa }),
    h('span', { class: 'char-card-origin', text: `${character.origin} ・ ${character.originRegion}` }),
    h('span', { class: 'char-card-perk-label', text: `${perk.icon} ${perk.label}` }),
  );
}
