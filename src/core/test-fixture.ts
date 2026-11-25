// Hand-written GameData fixture for engine tests. Deliberately independent of src/data/*.json
// (produced concurrently by other workers).
//
// Board: a 48-node rail ring (12 cities, 3 filler squares between each) plus one dead-end spur
// and three sea edges. Opposite cities are 20–24 steps apart, so the 20-step destination rule
// is testable.

import type {
  Board,
  BoardEdge,
  BoardNode,
  CardDef,
  Character,
  City,
  GameData,
  GameEventDef,
  LineKey,
  NpcDef,
  SquareKind,
} from './types';

const property = (
  id: string,
  name: string,
  industry: City['properties'][number]['industry'],
  price: number,
  yieldPct: number,
): City['properties'][number] => ({ id, name, industry, price, yieldPct });

export const CITIES: City[] = [
  {
    id: 'tokyo',
    nameJa: '東京',
    nameEn: 'Tokyo',
    country: 'JP',
    countryJa: '日本',
    region: 'east_asia',
    lat: 35.68,
    lon: 139.69,
    tier: 1,
    port: true,
    airport: true,
    blurb: '再開発の鶴の一声で景色が変わる街。',
    properties: [
      property('tokyo-tower', '東京タワー再保険', 'tourism', 40, 5),
      property('tokyo-bank', 'メガバンク本店', 'finance', 60, 4),
    ],
  },
  {
    id: 'osaka',
    nameJa: '大阪',
    nameEn: 'Osaka',
    country: 'JP',
    countryJa: '日本',
    region: 'east_asia',
    lat: 34.69,
    lon: 135.5,
    tier: 1,
    port: true,
    airport: true,
    blurb: '値切りこそ正義。',
    properties: [
      property('osaka-dotonbori', '道頓堀たこ焼き帝国', 'food', 25, 6),
      property('osaka-factory', '町工場ロボット部門', 'industry', 30, 5),
    ],
  },
  {
    id: 'shanghai',
    nameJa: '上海',
    nameEn: 'Shanghai',
    country: 'CN',
    countryJa: '中国',
    region: 'east_asia',
    lat: 31.23,
    lon: 121.47,
    tier: 1,
    port: true,
    airport: true,
    blurb: '港湾と高層ビルが同じ速さで伸びる。',
    properties: [
      property('shanghai-port', '世界コンテナ埠頭', 'shipping', 35, 5),
      property('shanghai-tech', '自動化AI工場', 'tech', 45, 6),
    ],
  },
  {
    id: 'singapore',
    nameJa: 'シンガポール',
    nameEn: 'Singapore',
    country: 'SG',
    countryJa: 'シンガポール',
    region: 'southeast_asia',
    lat: 1.29,
    lon: 103.85,
    tier: 1,
    port: true,
    airport: true,
    blurb: '罰金と共に繁栄する清潔都市。',
    properties: [
      property('singapore-fund', '海峡ソブリンファンド', 'finance', 50, 5),
      property('singapore-port', '自動運転港', 'shipping', 30, 6),
    ],
  },
  {
    id: 'sydney',
    nameJa: 'シドニー',
    nameEn: 'Sydney',
    country: 'AU',
    countryJa: 'オーストラリア',
    region: 'oceania',
    lat: -33.87,
    lon: 151.21,
    tier: 2,
    port: true,
    airport: true,
    blurb: '観光客と不動産価格が永遠に増える。',
    properties: [
      property('sydney-opera', 'オペラハウス興行権', 'tourism', 30, 6),
      property('sydney-harbor', 'ハーバー物流', 'shipping', 20, 6),
    ],
  },
  {
    id: 'mumbai',
    nameJa: 'ムンバイ',
    nameEn: 'Mumbai',
    country: 'IN',
    countryJa: 'インド',
    region: 'south_asia',
    lat: 19.08,
    lon: 72.88,
    tier: 2,
    port: false,
    airport: true,
    blurb: '映画と金融が同じ路地に住む。',
    properties: [
      property('mumbai-studio', '世界最大の映画スタジオ', 'media', 20, 7),
      property('mumbai-food', '屋台フード配達網', 'food', 15, 8),
    ],
  },
  {
    id: 'cairo',
    nameJa: 'カイロ',
    nameEn: 'Cairo',
    country: 'EG',
    countryJa: 'エジプト',
    region: 'africa',
    lat: 30.04,
    lon: 31.24,
    tier: 2,
    port: false,
    airport: true,
    blurb: 'ピラミッドは昔から景観資産。',
    properties: [
      property('cairo-pyramid', 'ピラミッド観光公社', 'tourism', 25, 6),
      property('cairo-agri', 'ナイル灌漑事業', 'agri', 18, 6),
    ],
  },
  {
    id: 'istanbul',
    nameJa: 'イスタンブール',
    nameEn: 'Istanbul',
    country: 'TR',
    countryJa: 'トルコ',
    region: 'middle_east',
    lat: 41.01,
    lon: 28.98,
    tier: 2,
    port: false,
    airport: true,
    blurb: '二つの大陸の間で値段が二倍になる。',
    properties: [
      property('istanbul-bazaar', 'グランドバザール商店街', 'tourism', 20, 7),
      property('istanbul-bank', '新興国銀行', 'finance', 40, 4),
    ],
  },
  {
    id: 'london',
    nameJa: 'ロンドン',
    nameEn: 'London',
    country: 'GB',
    countryJa: 'イギリス',
    region: 'europe',
    lat: 51.5,
    lon: -0.13,
    tier: 1,
    port: true,
    airport: true,
    blurb: '古い建物に新しい金融商品を詰める。',
    properties: [
      property('london-insurance', 'ロイズ再保険', 'finance', 55, 5),
      property('london-pub', 'パブチェーン', 'food', 20, 7),
    ],
  },
  {
    id: 'newyork',
    nameJa: 'ニューヨーク',
    nameEn: 'New York',
    country: 'US',
    countryJa: 'アメリカ',
    region: 'north_america',
    lat: 40.71,
    lon: -74.01,
    tier: 1,
    port: true,
    airport: true,
    blurb: '世界の損失を吸い込む交易所。',
    properties: [
      property('newyork-exchange', '世界証券取引所', 'finance', 70, 5),
      property('newyork-media', '全天候ニュース網', 'media', 45, 6),
    ],
  },
  {
    id: 'sanfrancisco',
    nameJa: 'サンフランシスコ',
    nameEn: 'San Francisco',
    country: 'US',
    countryJa: 'アメリカ',
    region: 'north_america',
    lat: 37.77,
    lon: -122.42,
    tier: 1,
    port: true,
    airport: true,
    blurb: 'AIの夢と家賃が同時に膨らむ。',
    properties: [
      property('sf-ai', '基盤モデル研究所', 'tech', 65, 7),
      property('sf-energy', 'データセンター電力', 'energy', 35, 6),
    ],
  },
  {
    id: 'rio',
    nameJa: 'リオ',
    nameEn: 'Rio de Janeiro',
    country: 'BR',
    countryJa: 'ブラジル',
    region: 'south_america',
    lat: -22.91,
    lon: -43.17,
    tier: 2,
    port: true,
    airport: true,
    blurb: 'カーニバルの収益は誰のものか。',
    properties: [
      property('rio-carnival', 'カーニバル興行権', 'media', 30, 6),
      property('rio-agri', '熱帯プランテーション', 'agri', 15, 7),
    ],
  },
  {
    id: 'heaven-gate', nameJa: '天国の門', nameEn: 'Heaven Gate', country: 'XX', countryJa: '天国',
    region: 'oceania', lat: 0, lon: 0, tier: 3, port: false, airport: false,
    blurb: '雲の上の検問所。', realm: 'heaven',
    properties: [property('heaven-mansion', '雲の上の豪邸', 'tourism', 800, 10)],
  },
  {
    id: 'heaven-estate', nameJa: '天使の投資村', nameEn: 'Angel Estate', country: 'XX', countryJa: '天国',
    region: 'oceania', lat: 0, lon: 1, tier: 3, port: false, airport: false,
    blurb: '天使投資ファンドの本拠地。', realm: 'heaven',
    properties: [property('heaven-fund', '天使投資ファンド', 'finance', 600, 12)],
  },
  {
    id: 'hell-gate', nameJa: '地獄の門', nameEn: 'Hell Gate', country: 'XX', countryJa: '地獄',
    region: 'africa', lat: 0, lon: 0, tier: 3, port: false, airport: false,
    blurb: 'ここから先は自己責任。', realm: 'hell',
    properties: [property('hell-onsen', '地獄の釜ゆで温泉', 'tourism', 20, 40)],
  },
  {
    id: 'hell-tax', nameJa: '閻魔の税務署', nameEn: 'Hell Tax Office', country: 'XX', countryJa: '地獄',
    region: 'africa', lat: 0, lon: 1, tier: 3, port: false, airport: false,
    blurb: '申告漏れは釜ゆで。', realm: 'hell',
    properties: [property('hell-ski', '針の山スキー場', 'tourism', 15, 50)],
  },
  {
    id: 'space-gate', nameJa: '宇宙港', nameEn: 'Space Port', country: 'XX', countryJa: '宇宙',
    region: 'east_asia', lat: 0, lon: 0, tier: 3, port: false, airport: true,
    blurb: '打ち上げ待ちの列。', realm: 'space',
    properties: [property('space-moonbase', '月面基地', 'tech', 300, 15)],
  },
  {
    id: 'space-moon', nameJa: '火星の分譲地', nameEn: 'Mars Plots', country: 'XX', countryJa: '宇宙',
    region: 'east_asia', lat: 0, lon: 1, tier: 3, port: false, airport: false,
    blurb: '眺めは最高、空気は別売り。', realm: 'space',
    properties: [property('space-asteroid', '小惑星採掘権', 'energy', 200, 20)],
  },
];

export const CITY_IDS: readonly string[] = CITIES.map((c) => c.id);

export const BOARD_NODE_IDS: readonly string[] = CITIES.map((c) => `c:${c.id}`);

const FILLER_KINDS: readonly SquareKind[] = ['blue', 'red', 'yellow', 'news'];

function buildBoard(): Board {
  const nodes: BoardNode[] = [];
  const edges: BoardEdge[] = [];
  const ring: string[] = [];
  const worldCities = CITIES.filter((c) => c.realm === undefined);
  for (let i = 0; i < worldCities.length; i += 1) {
    const city = worldCities[i];
    const cityNodeId = `c:${city.id}`;
    ring.push(cityNodeId);
    nodes.push({
      id: cityNodeId,
      kind: 'city',
      cityId: city.id,
      x: i * 300,
      y: 200 + (i % 3) * 80,
    });
    for (let j = 0; j < 3; j += 1) {
      const id = `s:${i}-${j}`;
      ring.push(id);
      nodes.push({
        id,
        kind: FILLER_KINDS[(i * 3 + j) % FILLER_KINDS.length],
        x: i * 300 + 80 * (j + 1),
        y: 260 + (i % 4) * 30,
      });
    }
  }
  for (let i = 0; i < ring.length; i += 1) {
    edges.push({ a: ring[i], b: ring[(i + 1) % ring.length], mode: 'rail' });
  }

  // Tiny disconnected loops for the three realms: two stations, blue/red/news squares, portal.
  const realmFillerKinds: readonly SquareKind[] = ['blue', 'red', 'news'];
  for (const realm of ['heaven', 'hell', 'space'] as const) {
    const realmRing: string[] = [];
    const realmCities = CITIES.filter((c) => c.realm === realm);
    realmCities.forEach((city, i) => {
      const id = `c:${city.id}`;
      realmRing.push(id);
      nodes.push({ id, kind: 'city', cityId: city.id, realm, x: 200 + i * 300, y: 200 });
    });
    for (let j = 0; j < realmFillerKinds.length; j += 1) {
      const id = `s:${realm}-${j}`;
      realmRing.push(id);
      nodes.push({ id, kind: realmFillerKinds[j], realm, x: 200 + j * 220, y: 500 });
    }
    const portalId = `s:${realm}-portal`;
    realmRing.push(portalId);
    nodes.push({ id: portalId, kind: 'portal', realm, x: 900, y: 800 });
    for (let i = 0; i < realmRing.length; i += 1) {
      edges.push({ a: realmRing[i], b: realmRing[(i + 1) % realmRing.length], mode: 'rail' });
    }
  }

  // Sea edges. These are parallel to existing rail links (a dock beside the station) so they
  // add rail/sea variety without collapsing the ring diameter needed by the 20-step rule.
  edges.push({ a: 'c:tokyo', b: 's:0-0', mode: 'sea' });
  edges.push({ a: 'c:cairo', b: 's:6-0', mode: 'sea' });
  edges.push({ a: 'c:london', b: 's:8-0', mode: 'sea' });

  // Dead-end spur off Rio, for the "dead ends may fold back" rule.
  nodes.push({ id: 's:dead', kind: 'blue', x: 3600, y: 900 });
  edges.push({ a: 'c:rio', b: 's:dead', mode: 'rail' });

  // Shop and tornado squares (spurs, so city distances are unchanged).
  nodes.push({ id: 's:shop', kind: 'shop', x: 900, y: 950 });
  edges.push({ a: 'c:osaka', b: 's:shop', mode: 'rail' });
  nodes.push({ id: 's:warp', kind: 'warp', x: 1200, y: 950 });
  edges.push({ a: 'c:shanghai', b: 's:warp', mode: 'rail' });

  return { nodes, edges };
}

export const BOARD: Board = buildBoard();

const ALL_LINE_KEYS: readonly LineKey[] = [
  'select',
  'turn',
  'buy',
  'monopoly',
  'goal',
  'blue',
  'red',
  'card',
  'piper_get',
  'piper_hit',
  'win',
  'lose',
  'skill',
];

function lines(text: Partial<Record<LineKey, string>>): Record<LineKey, string> {
  const out = {} as Record<LineKey, string>;
  for (const key of ALL_LINE_KEYS) out[key] = text[key] ?? `（${key}）`;
  return out;
}

export const CHARACTERS: Character[] = [
  {
    id: 'momotaro',
    nameJa: '桃太郎',
    origin: '桃太郎',
    originRegion: '日本',
    role: 'hero',
    sprite: 'assets/chars/momotaro.png',
    color: '#e25b5b',
    personality: 'きびだんごで人を動かすタイプの投資家。',
    perk: 'agri_boost',
    voice: { speaker: 10, speed: 1, pitch: 0, intonation: 1 },
    lines: lines({ turn: '出陣じゃ！', buy: 'この物件、もらった！', win: '桃の国は私のものだ！' }),
    skill: { name: 'きびだんご外交', desc: 'ほかの全員から5億円ずつ受け取る', effects: [{ op: 'cash', who: 'others', amount: -5 }, { op: 'cash', who: 'self', amount: 15 }], cpuHint: 'anytime' },
  },
  {
    id: 'sinbad',
    nameJa: 'シンドバッド',
    origin: '千夜一夜物語',
    originRegion: '中東',
    role: 'trickster',
    sprite: 'assets/chars/sinbad.png',
    color: '#2f8f83',
    personality: '航海のたびに保険金が入る。',
    perk: 'sailor',
    voice: { speaker: 11, speed: 1, pitch: 0, intonation: 1 },
    lines: lines({ turn: '船を出せ！', buy: 'この港はわしのもんじゃ！', blue: '宝を拾ったぞ！' }),
    skill: { name: '七つの航海', desc: '海運の収益 ×1.5（1年）', effects: [{ op: 'industry_mod', industry: 'shipping', mult: 1.5, years: 1, label: '七つの航海' }], cpuHint: 'early' },
  },
  {
    id: 'alice',
    nameJa: 'アリス',
    origin: '不思議の国のアリス',
    originRegion: 'イギリス',
    role: 'hero',
    sprite: 'assets/chars/alice.png',
    color: '#5b8fd9',
    personality: '手札が増えても平気な不思議な財布。',
    perk: 'card_shark',
    voice: { speaker: 12, speed: 1, pitch: 0, intonation: 1 },
    lines: lines({ turn: '行きましょう、白ウサギを追って。', card: 'このカード、使い道があるわ。' }),
    skill: { name: '白ウサギの近道', desc: '選んだ相手を1回休みにする', target: 'player', effects: [{ op: 'skip', who: 'target', turns: 1 }], cpuHint: 'ahead' },
  },
  {
    id: 'red_hood',
    nameJa: '赤ずきん',
    origin: '赤ずきん',
    originRegion: 'ドイツ',
    role: 'animal',
    sprite: 'assets/chars/red_hood.png',
    color: '#c94f7c',
    personality: 'オオカミの弁護士を常備している。',
    perk: 'piper_charm',
    voice: { speaker: 13, speed: 1, pitch: 0, intonation: 1 },
    lines: lines({ turn: 'おばあさまの家はこっちよ。', piper_hit: 'この程度の取り立て、想定内よ。' }),
    skill: { name: 'おばあさまの見舞い', desc: '自分の所持金 +20億円', effects: [{ op: 'cash', who: 'self', amount: 20 }], cpuHint: 'anytime' },
  },
];

export const CARDS: CardDef[] = [
  { id: 'express2', name: '急行列車きっぷ', desc: 'サイコロ2個', kind: 'move', weight: 10, price: 10 },
  { id: 'express3', name: '超特急きっぷ', desc: 'サイコロ3個', kind: 'move', weight: 8, price: 15 },
  { id: 'pegasus', name: '飛行機チケット', desc: '空港都市へワープ', kind: 'move', weight: 8, needsTarget: 'airport', price: 15 },
  { id: 'carpet', name: '魔法のじゅうたん', desc: '目的地から5〜10歩の都市へ', kind: 'move', weight: 8, needsTarget: 'city', price: 12 },
  { id: 'rocket', name: 'ロケット便', desc: '任意の都市へワープ', kind: 'move', weight: 3, needsTarget: 'city', price: 100 },
  { id: 'tariff', name: '関税カード', desc: '他の全員から5%徴収', kind: 'money', weight: 10, price: 45 },
  { id: 'subsidy', name: '謎の補助金', desc: '+40億×yearScale', kind: 'money', weight: 10, price: 50 },
  { id: 'bailout', name: '大きすぎて潰せませんカード', desc: '借金を全員で肩代わり', kind: 'money', weight: 5, price: 50 },
  { id: 'stop', name: '牛歩法案', desc: '相手を1回休み', kind: 'attack', weight: 8, needsTarget: 'player', price: 40 },
  { id: 'takeover', name: '敵対的買収', desc: '物件1件を1.5倍で強制購入', kind: 'attack', weight: 6, needsTarget: 'city', price: 70 },
  { id: 'piper_pass', name: '笛の押し付け', desc: '取り立て屋を押し付ける', kind: 'attack', weight: 6, needsTarget: 'player', price: 45 },
  { id: 'golden_egg', name: '金の卵', desc: '年間物件収益の30%', kind: 'money', weight: 8, price: 40 },
  { id: 'insider', name: '噂話カード', desc: '目的地を自分に近い都市へ再抽選', kind: 'special', weight: 8, price: 20 },
  { id: 'shield', name: '弁護士軍団', desc: '次の1回の被害を無効', kind: 'defense', weight: 6, price: 35 },
];

export const EVENTS: GameEventDef[] = [
  {
    id: 'ev-ai-bubble',
    title: 'AIバブル再来!?',
    kind: 'news',
    fact: 'AI関連投資が急増し、データセンターの電力需要が問題になっている。',
    sources: [{ title: '架空の経済ニュース', url: 'https://example.com/ai-bubble', date: '2026' }],
    satireNote: '架空のバブルを誇張した創作。登場人物・団体はすべて戯画。',
    weight: 6,
    lines: [
      { speaker: 'narrator', text: 'ニュース速報。世界のAI資本が再び熱狂している。' },
      { speaker: 'npc:owl_anchor', text: '今夜もAIで儲けた方に話を聞きます。' },
      { speaker: 'npc:tech_kid', text: '計算資源は有限です。でも私の株価は無限です。' },
    ],
    choices: [
      {
        label: '便乗する',
        detail: 'IT・AI収益+100%（2年）。50%で+50億、外れると-20億。',
        cpuWeight: 1.2,
        effects: [
          { op: 'industry_mod', industry: 'tech', mult: 2, years: 2, label: 'AIバブル' },
          {
            op: 'gamble',
            chance: 0.5,
            win: [{ op: 'cash', who: 'self', amount: 50 }],
            lose: [{ op: 'cash', who: 'self', amount: -20 }],
          },
        ],
        reply: [
          { speaker: 'npc:tech_kid', text: '私のGPUを見てください。光ります。' },
          { speaker: 'narrator', text: '光っているのは請求書かもしれない。' },
        ],
      },
      {
        label: '冷ややかに見る',
        detail: 'IT物件価格-20%。補助金カードを1枚。',
        cpuWeight: 0.6,
        effects: [
          { op: 'price_mod', industry: 'tech', mult: 0.8 },
          { op: 'card', who: 'self', card: 'subsidy', count: 1 },
        ],
        reply: [{ speaker: 'npc:owl_anchor', text: '冷静な投資家もいるものです。' }],
      },
    ],
  },
  {
    id: 'ev-tariff-history',
    title: '関税の歴史、繰り返す',
    kind: 'history',
    fact: '関税引き上げと報復関税の応酬は過去にも世界貿易を縮小させた。',
    sources: [{ title: '架空の経済史', url: 'https://example.com/tariff-history', date: '1930' }],
    satireNote: '歴史上の関税競争をモデルにした風刺。実在の人物・国を非難する意図はない。',
    weight: 5,
    lines: [
      { speaker: 'narrator', text: '歴史は繰り返す。関税も繰り返す。' },
      { speaker: 'npc:tariff_bulldog', text: 'ワシの関税は痛くない。お前の関税が痛いのだ。' },
    ],
    choices: [
      {
        label: '関税をかける',
        detail: '他の全員 -20億。観光物件1件につき+3億。',
        cpuWeight: 1,
        effects: [
          { op: 'cash', who: 'others', amount: -20, scale: false },
          { op: 'cash_pct', who: 'all', pct: -5 },
          { op: 'per_property', who: 'self', industry: 'tourism', perProperty: 3 },
          { op: 'card', who: 'self', card: 'shield' },
          { op: 'move', who: 'self', to: 'destination_near' },
        ],
        reply: [{ speaker: 'npc:tariff_bulldog', text: 'これでみんな仲良く貧しくなれる。' }],
      },
    ],
  },
  {
    id: 'ev-harvest-fable',
    title: '豊作の年に',
    kind: 'fable',
    fact: undefined,
    satireNote: '完全創作。農業補助金の循環を戯画化した。',
    weight: 4,
    lines: [
      { speaker: 'narrator', text: '今年は豊作。農家の倉庫が黄金色に輝く。' },
      { speaker: 'npc:banker_pig', text: '豊作でも価格は下がります。それが市場です。' },
    ],
    effects: [
      { op: 'per_property', who: 'self', industry: 'agri', perProperty: 5 },
      { op: 'cash', who: 'self', amount: 30 },
      { op: 'cash_pct', who: 'poorest', pct: 10 },
      { op: 'move', who: 'self', to: 'nearest_port' },
    ],
  },
  {
    id: 'ev-once-midas',
    title: 'ミダス王の指',
    kind: 'fable',
    fact: undefined,
    satireNote: '完全創作。資産が増えるほど現金が減る寓話。',
    weight: 3,
    minYear: 2,
    once: true,
    lines: [
      { speaker: 'npc:midas', text: '触れたものすべてが金になる。ただし手元の現金は別だ。' },
      { speaker: 'narrator', text: '富める者から物件が没収され、誰かが休まされる。' },
    ],
    effects: [
      { op: 'sell', who: 'richest', industry: 'any', count: 1, priceMult: 0.5 },
      { op: 'skip', who: 'random_other', turns: 1 },
      { op: 'piper', to: 'random_other' },
      { op: 'move', who: 'self', to: 'random_city' },
      { op: 'cash_pct', who: 'self', pct: 10 },
    ],
  },
  {
    id: 'ev-monthly-harvest',
    title: '月替わり豊作',
    kind: 'fable',
    fact: undefined,
    satireNote: '完全創作。月替わりの季節イベント用。',
    weight: 10,
    monthly: true,
    months: [4, 8],
    lines: [
      { speaker: 'narrator', text: '月が替わった。季節の風が世界経済を揺らす。' },
      { speaker: 'npc:banker_pig', text: '豊作でも豊作でなくても、手数料はいただきます。' },
    ],
    effects: [{ op: 'cash', who: 'self', amount: 5, scale: false }],
  },
];

export const NPCS: NpcDef[] = [
  { id: 'piper1', nameJa: 'ハーメルンの取り立て屋', sprite: 'assets/npcs/piper1.png', voice: { speaker: 20, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'piper2', nameJa: 'ブラック取り立て屋', sprite: 'assets/npcs/piper2.png', voice: { speaker: 21, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'piper3', nameJa: 'キング取り立て屋', sprite: 'assets/npcs/piper3.png', voice: { speaker: 22, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'owl_anchor', nameJa: 'フクロウキャスター', sprite: 'assets/npcs/owl_anchor.png', voice: { speaker: 23, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'tariff_bulldog', nameJa: '関税おじさん', sprite: 'assets/npcs/tariff_bulldog.png', voice: { speaker: 24, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'banker_pig', nameJa: '大きすぎて潰せない銀行ブタ', sprite: 'assets/npcs/banker_pig.png', voice: { speaker: 25, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'tech_kid', nameJa: 'AI長者の天才児', sprite: 'assets/npcs/tech_kid.png', voice: { speaker: 26, speed: 1, pitch: 0, intonation: 1 } },
  { id: 'midas', nameJa: 'ミダス王', sprite: 'assets/npcs/midas.png', voice: { speaker: 27, speed: 1, pitch: 0, intonation: 1 } },
];

export const fixtureData: GameData = {
  cities: CITIES,
  board: BOARD,
  characters: CHARACTERS,
  events: EVENTS,
  cards: CARDS,
  npcs: NPCS,
  emotes: [],
};