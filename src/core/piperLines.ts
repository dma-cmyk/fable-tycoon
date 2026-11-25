// 取り立て屋の固定台詞と災害・善行の定義 (2026-11 fun overhaul).
//
// このファイルは純粋なデータだけを持つ。`tools/gen-voice.mjs` は Node から直接このモジュールを
// import して音声の登録漏れを検出するため、実行時 import（他モジュールへの依存）を置かない。
// 台詞は固定文字列のみ（プレイヤー名・数値を含めない）。音声化できるよう 45 文字以内・
// 英字と数字なしで書く。

import type { GameEventDef } from './types';

export interface PiperFormDef {
  level: 1 | 2 | 3;
  npcId: 'piper1' | 'piper2' | 'piper3';
  nameJa: string;
  shortJa: string;
}

/** 3 段階の姿。level は PiperState.level と一致する。 */
export const PIPER_FORMS: readonly PiperFormDef[] = [
  { level: 1, npcId: 'piper1', nameJa: 'ハーメルンの取り立て屋', shortJa: '笛吹き' },
  { level: 2, npcId: 'piper2', nameJa: 'ブラック取り立て屋', shortJa: 'ブラック' },
  { level: 3, npcId: 'piper3', nameJa: 'キング取り立て屋', shortJa: 'キング' },
];

export type PiperDisasterKind =
  | 'city_fire_sale'
  | 'charity_gala'
  | 'trophy_sale'
  | 'abduction'
  | 'card_confiscation'
  | 'king_tax'
  | 'hell_ride';

export interface PiperDisasterDef {
  kind: PiperDisasterKind;
  /** 画面に大きく出す風刺タイトル（音声化しない） */
  title: string;
  /** ナレーターの固定ナレーション（音声化する） */
  narration: string;
}

/** キングの災害ルーレット。5〜7 種類。 */
export const PIPER_DISASTERS: readonly PiperDisasterDef[] = [
  {
    kind: 'city_fire_sale',
    title: '一等地、二束三文セール',
    narration: '取り立て屋が街の物件を二束三文で売り払った！',
  },
  {
    kind: 'charity_gala',
    title: 'チャリティーガラで全額寄付',
    narration: '所持金の半分が謎のチャリティーに消えた！',
  },
  {
    kind: 'trophy_sale',
    title: '自慢の物件、叩き売り',
    narration: '一番高い物件が二割の値段で売られた！',
  },
  {
    kind: 'abduction',
    title: '強制バカンスで地球の裏側へ',
    narration: '取り立て屋に拉致され、遠い街へ飛ばされた！',
  },
  {
    kind: 'card_confiscation',
    title: 'カード目録、全部押収',
    narration: '手札が全部押収され、保管料まで取られた！',
  },
  {
    kind: 'king_tax',
    title: '全物件にキング税',
    narration: '持っている物件すべてに王様の税金がかかった！',
  },
];

/** キングの 10% 悪夢。災害ルーレットとは別枠で、いきなり地獄へ送る。 */
export const PIPER_HELL_DISASTER: PiperDisasterDef = {
  kind: 'hell_ride',
  title: '借金地獄へご招待',
  narration: 'キングの招待で、借金地獄へ落とされた！',
};

export type PiperGiftKind = 'debt_payoff' | 'free_property' | 'cash_gift';

export interface PiperGiftDef {
  kind: PiperGiftKind;
  /** 画面に出す風刺タイトル */
  title: string;
  /** ナレーターの固定ナレーション */
  narration: string;
}

/** 気まぐれな善行。借金返済 → 物件購入 → 現金の順に優先する。 */
export const PIPER_GIFTS: readonly PiperGiftDef[] = [
  {
    kind: 'debt_payoff',
    title: '借金、まさかの全額チャラ',
    narration: '取り立て屋が気まぐれに借金を払ってくれた！',
  },
  {
    kind: 'free_property',
    title: '身代わり投資、勝手に購入',
    narration: '取り立て屋が勝手に物件を買ってくれた！',
  },
  {
    kind: 'cash_gift',
    title: '路地裏で現金を拾った',
    narration: '取り立て屋が謎の現金を置いていった！',
  },
];

/** 変身ルーレットが止まったときに、その姿の声で喋る固定台詞。 */
export const PIPER_VOICE_LINES: Readonly<Record<1 | 2 | 3, readonly string[]>> = {
  1: ['笛の音色で、お金をいただきます。', '取り立てです。笑顔でお願いします。'],
  2: ['黒い笛ほど、よく響くのです。', 'ブラックです。分割払いは認めません。'],
  3: ['王の笛です。財布ごと持っていきます。', 'ひれ伏しなさい。王税の時間です。'],
};

// ---------------------------------------------------------------- 示談イベント

/** 「1回休み」の代わりに示談金を払う 2 択。engine の event フェーズをそのまま流用する。 */
export const PIPER_DEAL_EVENT_ID = 'piper_deal';

export const PIPER_DEAL_NARRATION = '取り立て屋が「休むか、示談か」を迫ってきた！';

export const PIPER_DEAL_EVENT: GameEventDef = {
  id: PIPER_DEAL_EVENT_ID,
  title: '取り立て屋の示談',
  kind: 'fable',
  satireNote:
    '取り立て屋が「1回休み」の代わりに示談金を要求する、という完全創作のやり取りです。',
  weight: 0, // ニュースマス抽選には出ない（取り立て屋のいたずらからのみ開く）
  lines: [],
  choices: [
    {
      label: '休む（1回休み）',
      detail: '財布は守れるが、この手番は終わり。',
      effects: [],
      cpuWeight: 1,
    },
    {
      label: '示談金を払って動く',
      detail: '純資産の約5%（ブラック取り立て屋は10%）を払って、そのまま手番を続ける。',
      effects: [],
      cpuWeight: 1,
    },
  ],
};

export interface PiperVoiceLine {
  speaker: `npc:${string}`;
  text: string;
}

/** gen-voice 用: 取り立て屋 NPC の全固定台詞。 */
export function piperVoiceLines(): PiperVoiceLine[] {
  const out: PiperVoiceLine[] = [];
  for (const form of PIPER_FORMS) {
    for (const text of PIPER_VOICE_LINES[form.level]) {
      out.push({ speaker: `npc:${form.npcId}`, text });
    }
  }
  return out;
}

/** gen-voice 用: 災害と善行のナレーション（narrator ボイスで生成する）。 */
export function piperNarrationTexts(): string[] {
  return [
    ...PIPER_DISASTERS.map((disaster) => disaster.narration),
    PIPER_HELL_DISASTER.narration,
    PIPER_DEAL_NARRATION,
    ...PIPER_GIFTS.map((gift) => gift.narration),
  ];
}

/** kind から災害定義を引く（hell_ride も含む）。 */
export function piperDisasterDef(kind: PiperDisasterKind): PiperDisasterDef {
  if (kind === 'hell_ride') return PIPER_HELL_DISASTER;
  return PIPER_DISASTERS.find((disaster) => disaster.kind === kind) ?? PIPER_DISASTERS[0];
}

/** kind から善行定義を引く。 */
export function piperGiftDef(kind: PiperGiftKind): PiperGiftDef {
  return PIPER_GIFTS.find((gift) => gift.kind === kind) ?? PIPER_GIFTS[0];
}