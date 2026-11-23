import type { PerkId } from '../core/types';

export interface PerkInfo {
  label: string;
  icon: string;
  desc: string;
}

/** Japanese player-facing text for every PerkId. */
export const PERKS: Record<PerkId, PerkInfo> = {
  none: { label: '特性なし', icon: '🎲', desc: '特別な補正はない。実力と運だけで立ち回る。' },
  agri_boost: {
    label: '大地の恵み',
    icon: '🌾',
    desc: '農林水産・食品の物件収益が +25%。',
  },
  tech_boost: {
    label: '未来の申し子',
    icon: '🤖',
    desc: 'IT・AI・娯楽メディアの物件収益が +25%。',
  },
  tourism_boost: {
    label: '観光の目利き',
    icon: '🧳',
    desc: '観光・ホテルの物件収益が +30%。',
  },
  finance_boost: {
    label: '資本の申し子',
    icon: '💰',
    desc: '金融・資源エネルギーの物件収益が +20%。',
  },
  sailor: {
    label: '海の男',
    icon: '⚓',
    desc: '海路を進むとき、サイコロの出目が +1。',
  },
  lucky: {
    label: '幸運の星',
    icon: '🍀',
    desc: '青マスでもらえるお金が +30%。',
  },
  tough: {
    label: '打たれ強い',
    icon: '🛡️',
    desc: '赤マスで失うお金が -40%。',
  },
  card_shark: {
    label: 'カードの虫',
    icon: '🃏',
    desc: '黄マスでカードを 2 枚引き、手札上限が +2。',
  },
  haggler: {
    label: '値切り上手',
    icon: '🏷️',
    desc: '物件の購入価格が -10%。',
  },
  pickpocket: {
    label: 'すれ違いスリ',
    icon: '🖐️',
    desc: '他プレイヤーを追い越すと、相手の所持金 2% を奪う。',
  },
  piper_charm: {
    label: '笛に強い',
    icon: '🎵',
    desc: 'ハーメルンの取り立て屋による被害が -50%。',
  },
};

export function perkInfo(perk: PerkId): PerkInfo {
  return PERKS[perk] ?? PERKS.none;
}