// 異世界マップ（天国・地獄・宇宙）の共有定数。ルールの正本は docs/DESIGN.md §10。
import type { RealmId } from './types';

/** 異世界ノードの座標系（背景画像 public/assets/realms/<id>.webp と同じ比率） */
export const REALM_W = 2400;
export const REALM_H = 1350;

export interface RealmInfo {
  id: RealmId;
  nameJa: string;
  /** マス効果の倍率（青・赤） */
  blueMult: number;
  redMult: number;
  /** portal を踏んだときの戻り先 */
  exit: 'near_destination' | 'random_city' | 'choose_airport';
  background: string; // public-relative
  bgm: string; // BgmName
}

export const REALMS: Record<RealmId, RealmInfo> = {
  heaven: {
    id: 'heaven', nameJa: '天下り天国', blueMult: 3, redMult: 0.5, exit: 'near_destination',
    background: 'assets/realms/heaven.webp', bgm: 'realm_heaven',
  },
  hell: {
    id: 'hell', nameJa: '借金地獄', blueMult: 0.5, redMult: 3, exit: 'random_city',
    background: 'assets/realms/hell.webp', bgm: 'realm_hell',
  },
  space: {
    id: 'space', nameJa: '宇宙ビジネス特区', blueMult: 1.5, redMult: 1.5, exit: 'choose_airport',
    background: 'assets/realms/space.webp', bgm: 'realm_space',
  },
};

export const realmOf = (node: { realm?: RealmId }): RealmId | 'world' => node.realm ?? 'world';
