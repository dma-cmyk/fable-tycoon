import type { Character, CharacterRole, PerkId } from '../core/types';
import { PERKS } from './perks';

export type RegionGroup = 'japan' | 'europe' | 'asia_me_africa';
export type PerkGroup = 'property_income' | 'luck_defense' | 'movement_attack' | 'shopping_cards';
export type RegionFilter = RegionGroup | 'all';
export type RoleFilter = CharacterRole | 'all';
export type PerkGroupFilter = PerkGroup | 'all';

export interface CharacterFilterState {
  query: string;
  region: RegionFilter;
  role: RoleFilter;
  perkGroup: PerkGroupFilter;
  availableOnly: boolean;
}

export const REGION_GROUPS: ReadonlyArray<{ id: RegionGroup; label: string }> = [
  { id: 'japan', label: '日本' },
  { id: 'europe', label: 'ヨーロッパ' },
  { id: 'asia_me_africa', label: 'アジア・中東・アフリカ' },
];

export const PERK_GROUPS: ReadonlyArray<{ id: PerkGroup; label: string }> = [
  { id: 'property_income', label: '物件収益' },
  { id: 'luck_defense', label: '運と守り' },
  { id: 'movement_attack', label: '移動と妨害' },
  { id: 'shopping_cards', label: '買い物とカード' },
];

const EUROPE_REGIONS = new Set(['イギリス', 'イタリア', 'ギリシャ', 'デンマーク', 'ドイツ', 'フランス', 'ロシア']);

const PERK_GROUP_MAP: Partial<Record<PerkId, PerkGroup>> = {
  agri_boost: 'property_income',
  tech_boost: 'property_income',
  tourism_boost: 'property_income',
  finance_boost: 'property_income',
  lucky: 'luck_defense',
  tough: 'luck_defense',
  piper_charm: 'luck_defense',
  sailor: 'movement_attack',
  pickpocket: 'movement_attack',
  haggler: 'shopping_cards',
  card_shark: 'shopping_cards',
};

export function regionGroupOf(originRegion: string): RegionGroup {
  if (originRegion === '日本') return 'japan';
  if (EUROPE_REGIONS.has(originRegion)) return 'europe';
  return 'asia_me_africa';
}

export function perkGroupOf(perk: PerkId): PerkGroup | null {
  return PERK_GROUP_MAP[perk] ?? null;
}

export function hasActiveFilters(state: CharacterFilterState): boolean {
  return (
    state.query.trim().length > 0 ||
    state.region !== 'all' ||
    state.role !== 'all' ||
    state.perkGroup !== 'all' ||
    state.availableOnly
  );
}

const EMPTY_TAKEN: ReadonlySet<string> = new Set();

export function filterCharacters(
  characters: readonly Character[],
  filters: CharacterFilterState,
  taken: ReadonlySet<string> = EMPTY_TAKEN,
): Character[] {
  const query = filters.query.trim().toLowerCase();
  return characters.filter((character) => {
    if (filters.availableOnly && taken.has(character.id)) return false;
    if (filters.region !== 'all' && regionGroupOf(character.originRegion) !== filters.region) return false;
    if (filters.role !== 'all' && character.role !== filters.role) return false;
    if (filters.perkGroup !== 'all' && perkGroupOf(character.perk) !== filters.perkGroup) return false;
    if (query) {
      const haystack = `${character.nameJa} ${character.origin} ${character.originRegion} ${character.personality} ${PERKS[character.perk].label}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
