/**
 * Credit data shown on the title screen. Mirrors docs/CREDITS.md and the VOICEVOX speaker list
 * in docs/voicevox-licensing.md. Keep in sync when audio sources change.
 */

export interface MusicCredit {
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  note?: string;
}

export const VOICE_CREDITS = {
  engineName: 'VOICEVOX',
  engineUrl: 'https://voicevox.hiroshiba.jp/',
  speakers: [
    'VOICEVOX:波音リツ',
    'VOICEVOX:WhiteCUL',
    'VOICEVOX:後鬼',
    'VOICEVOX:小夜/SAYO',
    'VOICEVOX:栗田まろん',
    'VOICEVOX:†聖騎士 紅桜†',
    'VOICEVOX:ユーレイちゃん(CV:神崎零)',
  ],
  note:
    '話者の選定と利用規約の確認は docs/voicevox-licensing.md に基づく。ユーレイちゃんの音声は非商用利用の許諾範囲で使用。本作を商用利用する場合は各権利者の規約に従い事前許諾を得ること。',
};

export const SFX_CREDIT = {
  text: '効果音は手続き生成（第三者の音源素材を含まない）。',
};

const KM = 'Kevin MacLeod (incompetech.com)';
const CC_BY = 'Creative Commons: By Attribution 4.0 License';
const CC_URL = 'http://creativecommons.org/licenses/by/4.0/';

export const MUSIC_CREDITS: MusicCredit[] = [
  {
    title: 'Fluffing a Duck',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100768',
  },
  {
    title: 'Life of Riley',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400054',
  },
  {
    title: 'Monkeys Spinning Monkeys',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400011',
  },
  {
    title: 'Pixel Peeker Polka - faster',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100833',
  },
  {
    title: 'Carefree',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037',
  },
  {
    title: 'Investigations',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100646',
  },
  {
    title: 'Teller of the Tales',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400020',
  },
  {
    title: 'Scheming Weasel (faster version)',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100085',
  },
  {
    title: 'Volatile Reaction',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400039',
  },
  {
    title: 'Sneaky Snitch',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100772',
  },
  {
    title: 'Local Forecast - Elevator',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1300012',
  },
  {
    title: 'Wallpaper',
    artist: KM,
    license: CC_BY,
    licenseUrl: CC_URL,
    sourceUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100843',
  },
];

export const CREDITS_NOTE =
  'BGM はゲーム内ループ用にトリミング・クロスフェード・ラウドネス調整（-22 LUFS 付近）を施しています。' +
  'ライセンス確認: incompetech.com のライセンスページ（2026-11-23 取得）。';