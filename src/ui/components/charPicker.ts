import { Audio, voiceKeyOf } from '../../audio/audio';
import { GAME_DATA } from '../../data/index';
import type { Character, CharacterRole } from '../../core/types';
import { h, type ModalHandle, type ModalHost } from '../dom';
import { characterSprite, ROLE_JA } from '../format';
import { motionReduced } from '../motion';
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
import { pickRandom, randomIndex } from '../randomPick';

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

const SHUFFLE_TICKS = 9;
const SHUFFLE_STEP_MS = 62;

let rememberedFilters: CharacterFilterState = { ...DEFAULT_FILTERS };

/** 48-character picker with filters, preview-only cards and an explicit confirm. */
export function openCharacterPicker(options: CharacterPickerOptions): void {
  const exclude = options.exclude ?? new Set<string>();
  let filters: CharacterFilterState = { ...rememberedFilters };
  let previewId: string | null = options.current && !exclude.has(options.current) ? options.current : null;
  let handle: ModalHandle | null = null;
  let pendingFocusKey: string | null = null;
  let filterDrawerOpen = false;
  let shuffling = false;
  let shuffleTimer = 0;

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
  const randomButton = h('button', {
    class: 'btn btn-ghost char-random',
    text: '🎲 ランダム',
    attrs: { type: 'button', 'aria-label': '条件に合うキャラクターからランダムに選ぶ' },
    on: { click: () => shuffleRandom() },
  });
  const confirmButton = h('button', {
    class: 'btn btn-gold char-confirm',
    text: 'キャラをえらんでください',
    attrs: { type: 'button', disabled: true },
    on: {
      click: () => {
        if (!previewId || shuffling) return;
        const picked = previewId;
        handle?.close();
        options.onPick(picked);
      },
    },
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
    attrs: { type: 'button', 'aria-label': '空いているキャラだけ', 'aria-pressed': String(filters.availableOnly) },
    on: {
      click: () => {
        filters = { ...filters, availableOnly: !filters.availableOnly };
        remember();
        render();
      },
    },
  });

  const filterToggle = h('button', {
    class: 'chip chip-small char-filter-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': '絞り込み条件を開く' },
    on: { click: () => setFilterDrawer(!filterDrawerOpen) },
  });

  const setFilterDrawer = (open: boolean): void => {
    filterDrawerOpen = open;
    filterHost.classList.toggle('is-open', open);
    filterToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // The two mobile drawers must never stack: opening filters returns to the grid.
      detail.classList.remove('is-open');
      detail.querySelector<HTMLElement>('.char-detail-compact')?.setAttribute('aria-expanded', 'false');
      const arrow = detail.querySelector<HTMLElement>('.char-detail-compact-arrow');
      if (arrow) arrow.textContent = '詳細';
      requestAnimationFrame(() => filterHost.querySelector<HTMLElement>('.char-filters-close')?.focus({ preventScroll: true }));
    } else {
      filterToggle.focus({ preventScroll: true });
    }
  };

  const chipsFor = <T extends string>(
    rowKey: string,
    allLabel: string,
    optionsList: ReadonlyArray<{ id: T; label: string; count: number }>,
    selected: T | 'all',
    onSelect: (value: T | 'all') => void,
  ): HTMLElement[] => {
    const total = optionsList.reduce((sum, option) => sum + option.count, 0);
    const make = (id: T | 'all', label: string, valueCount: number): HTMLElement =>
      h(
        'button',
        {
          class: 'chip chip-small char-filter-chip',
          attrs: { type: 'button', 'data-filter-key': `${rowKey}:${id}`, 'aria-pressed': String(selected === id) },
          on: {
            click: (event) => {
              pendingFocusKey = (event.currentTarget as HTMLElement).dataset.filterKey ?? null;
              onSelect(id);
            },
          },
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

  const activeFilterCount = (): number => {
    let total = 0;
    if (filters.query.trim()) total += 1;
    if (filters.region !== 'all') total += 1;
    if (filters.role !== 'all') total += 1;
    if (filters.perkGroup !== 'all') total += 1;
    if (filters.availableOnly) total += 1;
    return total;
  };

  const renderFilters = (filteredCount: number): void => {
    available.setAttribute('aria-pressed', String(filters.availableOnly));
    available.className = `chip chip-small char-available-toggle ${filters.availableOnly ? 'is-selected' : ''}`.trim();
    available.replaceChildren(h('span', { text: '空いているキャラだけ' }));
    reset.hidden = !hasActiveFilters(filters);

    const active = activeFilterCount();
    filterToggle.className = `chip chip-small char-filter-toggle ${active > 0 ? 'is-selected' : ''}`.trim();
    filterToggle.replaceChildren(
      h('span', { text: active > 0 ? `絞り込み ${active}` : '絞り込み' }),
    );
    filterToggle.setAttribute('aria-expanded', String(filterDrawerOpen));
    filterHost.classList.toggle('is-open', filterDrawerOpen);

    filterHost.replaceChildren(
      h(
        'div',
        { class: 'char-filters-head' },
        h('span', { class: 'char-filters-title', text: '絞り込み' }),
        h('button', {
          class: 'btn btn-ghost btn-small char-filters-close',
          text: '閉じる',
          attrs: { type: 'button' },
          on: { click: () => setFilterDrawer(false) },
        }),
      ),
      h(
        'div',
        { class: 'char-filters-list' },
        filterRow(
          '地域',
          chipsFor('region', 'すべて', regionOptions, filters.region, (region) => {
            filters = { ...filters, region };
            remember();
            render();
          }),
        ),
        filterRow(
          'タイプ',
          chipsFor('role', 'すべて', roleOptions, filters.role, (role) => {
            filters = { ...filters, role };
            remember();
            render();
          }),
        ),
        filterRow(
          '特性',
          chipsFor('perk', 'すべて', perkOptions, filters.perkGroup, (perkGroup) => {
            filters = { ...filters, perkGroup };
            remember();
            render();
          }),
        ),
      ),
      h('button', {
        class: 'btn btn-gold char-filters-done',
        text: `${filteredCount} 人を見る`,
        attrs: { type: 'button' },
        on: { click: () => setFilterDrawer(false) },
      }),
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

  const toggleDetail = (): void => {
    const open = !detail.classList.contains('is-open');
    detail.classList.toggle('is-open', open);
    detail.querySelector<HTMLElement>('.char-detail-compact')?.setAttribute('aria-expanded', String(open));
    const arrow = detail.querySelector<HTMLElement>('.char-detail-compact-arrow');
    if (arrow) arrow.textContent = open ? '閉じる' : '詳細';
    if (open) detail.scrollTop = 0;
  };

  const renderDetail = (): void => {
    const character = previewId ? GAME_DATA.characters.find((candidate) => candidate.id === previewId) : null;
    detail.replaceChildren();
    if (!character) {
      detail.append(
        h(
          'div',
          { class: 'char-detail-empty' },
          h('span', { class: 'char-detail-empty-icon', text: '👤', attrs: { 'aria-hidden': 'true' } }),
          h('p', { text: 'キャラクターをえらぶと、紹介文と特性を確認できます。' }),
        ),
      );
      confirmButton.disabled = true;
      confirmButton.textContent = 'キャラをえらんでください';
      return;
    }
    const perk = perkInfo(character.perk);
    const body = h(
      'div',
      { class: 'char-detail-body' },
      h(
        'div',
        { class: 'char-detail-art-wrap' },
        h('img', {
          class: 'char-detail-art',
          attrs: { src: characterSprite(character), alt: character.nameJa, draggable: 'false' },
        }),
        h('span', { class: 'char-card-role char-detail-role', text: ROLE_JA[character.role] }),
      ),
      h(
        'div',
        { class: 'char-detail-name-row' },
        h('h3', { class: 'char-detail-name', text: character.nameJa }),
        options.current === character.id ? h('span', { class: 'badge badge-gold', text: '✓ いまの相棒' }) : null,
      ),
      h('p', { class: 'char-detail-origin', text: `${character.origin} ・ ${character.originRegion}` }),
      h('p', { class: 'char-detail-personality', text: character.personality }),
      h(
        'details',
        { class: 'char-detail-profile' },
        h('summary', { text: 'プロフィール' }),
        h('p', { text: character.personality }),
      ),
      h(
        'div',
        { class: 'char-detail-perk' },
        h('span', { class: 'char-detail-perk-label', text: `${perk.icon} ${perk.label}` }),
        h('p', { class: 'char-detail-perk-desc', text: perk.desc }),
      ),
      h(
        'div',
        { class: 'char-detail-perk char-detail-skill' },
        h('span', { class: 'char-detail-perk-label', text: `✨ 固有技 ${character.skill.name}` }),
        h('p', { class: 'char-detail-perk-desc', text: `${character.skill.desc}（1 年 1 回）` }),
      ),
    );
    const compact = h(
      'button',
      {
        class: 'char-detail-compact',
        attrs: { type: 'button', 'aria-expanded': String(detail.classList.contains('is-open')) },
        on: { click: () => toggleDetail() },
      },
      h('img', {
        class: 'char-detail-compact-art',
        attrs: { src: characterSprite(character), alt: '', draggable: 'false' },
      }),
      h(
        'span',
        { class: 'char-detail-compact-info' },
        h('span', { class: 'char-detail-compact-name', text: character.nameJa }),
        h('span', {
          class: 'char-detail-compact-meta',
          text: `${perk.icon} ${perk.label} ・ ✨ ${character.skill.name}`,
        }),
      ),
      h('span', {
        class: 'char-detail-compact-arrow',
        text: detail.classList.contains('is-open') ? '閉じる' : '詳細',
        attrs: { 'aria-hidden': 'true' },
      }),
    );
    detail.append(compact, body);
    confirmButton.disabled = shuffling;
    confirmButton.textContent = 'このキャラにする';
  };

  const render = (): void => {
    const filtered = filterCharacters(GAME_DATA.characters, filters, exclude);
    grid.replaceChildren();
    for (const character of filtered) {
      const taken = exclude.has(character.id);
      grid.append(
        characterCard(character, taken, options.current === character.id, previewId === character.id, () => {
          if (taken || shuffling) return;
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
    randomButton.disabled = filtered.every((character) => exclude.has(character.id)) || shuffling;
    renderFilters(filtered.length);
    if (pendingFocusKey) {
      const key = pendingFocusKey;
      pendingFocusKey = null;
      filterHost.querySelector<HTMLElement>(`[data-filter-key="${key}"]`)?.focus({ preventScroll: true });
    }
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

  const finishShuffle = (id: string): void => {
    window.clearTimeout(shuffleTimer);
    shuffling = false;
    grid.classList.remove('is-shuffling');
    grid.querySelectorAll<HTMLElement>('.char-card.is-shuffle-hit').forEach((card) => card.classList.remove('is-shuffle-hit'));
    randomButton.disabled = false;
    previewId = id;
    Audio.sfx('stamp');
    syncPreview();
    grid.querySelector<HTMLElement>(`.char-card[data-character="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const randomPool = (): Character[] =>
    filterCharacters(GAME_DATA.characters, filters).filter((character) => !exclude.has(character.id));

  const shuffleRandom = (): void => {
    if (shuffling) return;
    const pool = randomPool();
    const target = pickRandom(pool);
    if (!target) return;
    if (motionReduced()) {
      previewId = target.id;
      Audio.sfx('stamp');
      syncPreview();
      return;
    }
    shuffling = true;
    grid.classList.add('is-shuffling');
    randomButton.disabled = true;
    confirmButton.disabled = true;
    let tickCount = 0;
    const tick = (): void => {
      if (!grid.isConnected || tickCount >= SHUFFLE_TICKS) {
        finishShuffle(target.id);
        return;
      }
      tickCount += 1;
      const candidate = pool[randomIndex(pool.length)] ?? target;
      grid.querySelectorAll<HTMLElement>('.char-card.is-shuffle-hit').forEach((card) => card.classList.remove('is-shuffle-hit'));
      const card = grid.querySelector<HTMLElement>(`.char-card[data-character="${candidate.id}"]`);
      card?.classList.add('is-shuffle-hit');
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      shuffleTimer = window.setTimeout(tick, SHUFFLE_STEP_MS);
    };
    tick();
  };

  const toolbar = h(
    'div',
    { class: 'char-picker-toolbar' },
    search,
    available,
    filterToggle,
    reset,
    count,
  );

  const content = h(
    'div',
    { class: 'char-picker-content' },
    filterHost,
    h('div', { class: 'char-picker-main' }, h('div', { class: 'char-results' }, grid, empty), detail),
  );

  const footer = h('div', { class: 'char-picker-footer' }, randomButton, confirmButton);

  const body = h('div', { class: 'char-picker' }, toolbar, content, footer);

  handle = options.modal.open(body, {
    title: options.title ?? 'キャラクターを選ぶ',
    subtitle: options.subtitle ?? '48 人の中から 1 人。まずは候補を絞り、紹介文を読んで決めよう。',
    className: 'modal-wide char-picker-modal',
    onClose: () => window.clearTimeout(shuffleTimer),
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
    h('span', { class: 'char-card-skill', text: `✨ ${character.skill.name}` }),
  );
}