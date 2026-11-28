// イベント本編のナレーション（2026-11-28 フルボイス化）。
//
// 画面上の title / fact / 選択肢 / 結果は、そのままでは読み上げに向かない
// （長い・英字や数字を含む・効果の説明は耳で追えない）。ここに「耳で追える 1〜2 文」の
// 読み上げ版だけを持ち、画面の字幕と音声が同じ文字列になるようにする。
//
// このファイルは純粋なデータと純粋関数だけを置く。`tools/gen-voice.mjs` が Node から直接
// import して音声の登録漏れを検出するため、実行時 import（他モジュールへの依存）を置かない。
// 数値は漢数字で書き、英字は使わない（VOICEVOX が読み上げられる文字だけにする）。

import type { Effect, Fx, GameEventDef } from './types';

/** 賭けの結果トースト。applyEffect と eventResultSpeech が同じ文字列を使う（ずれ防止）。 */
export const GAMBLE_WIN_TOAST = '賭けに勝った！';
export const GAMBLE_LOSE_TOAST = '賭けに負けた……';

/** 画面のラベルを読み上げ用に言い換える（英字を含むラベルだけ）。 */
const CHOICE_LABEL_SPEECH: Record<string, string> = {
  'BTCでピザを買う': 'ビットコインでピザを買う',
  'BTCを保管する': 'ビットコインを保管する',
  'AIスーツを買う': 'エーアイのスーツを買う',
  'AAAを買う': '最上級の格付けを買う',
};

/** 見出しの読み上げ。英字・数字を含むタイトルだけ上書きする。 */
const TITLE_SPEECH: Record<string, string> = {
  'ai-bubble-again': 'エーアイバブル再来',
  'bitcoin-pizza': '一万ビットコインのピザ',
  'zimbabwe-hyperinflation': '百兆ドル札でバスに乗る',
};

/**
 * fact を持つイベントの読み上げ版（事実だけで、風刺は言わない）。
 * 画面の fact は 1〜2 文へ要約し、数値は漢数字で読める形にしたもの。
 */
const FACT_SPEECH: Record<string, string> = {
  'ai-bubble-again': '二千二十五年、半導体や人工知能の株が急騰し、市場全体が大きくふくらみました。',
  'ever-given-stuck': '二千二十一年三月、全長四百メートルのコンテナ船がスエズ運河で座礁し、運河が六日間閉鎖されました。',
  'meme-stock-squeeze': '二千二十一年一月、個人投資家の買いが空売り筋の買い戻しを誘い、米国のゲーム販売店の株が一時、月初の約三十倍に上がりました。',
  'crypto-exchange-collapse': '二千二十二年十一月、大手の暗号資産取引所が経営破綻し、顧客資産の穴は約八十億ドル、百万人超に影響しました。',
  'bank-run-2023': '二千二十三年三月、米国の地方銀行が取り付け騒ぎで破綻し、一日で約四百二十億ドルが引き出されました。',
  'tariff-war': '米中は二千十八年から関税の応酬を続け、二千二十五年には米国が六十以上の国と地域へ大規模な追加関税を発動しました。',
  'inflation-surge': '二千二十一年半ばから、供給網の混乱やエネルギー高で、世界各地の物価が数十年ぶりに大きく上がりました。',
  shrinkflation: '価格を据え置いたまま内容量や品質を減らすシュリンクフレーションが、二千二十二年以降の物価高で広がりました。',
  'chip-shortage': '二千二十年から二十三年にかけて半導体が世界的に不足し、自動車や家電など百七十近い産業に影響しました。',
  'egg-price-spike': '二千二十二年、鳥インフルエンザで米国の採卵鶏が大量に失われ、卵の価格は十一月に前年同月比で四十九パーセント上がりました。',
  'negative-rates-end': '二千二十四年三月、日本銀行が八年続いたマイナス金利政策を終え、十七年ぶりの利上げに踏み切りました。',
  'metaverse-collapse': '二千二十年代初頭に注目を集めた仮想空間は利用者が定着せず、二千二十二年から二十三年にかけて関連事業の縮小が相次ぎました。',
  'rare-earth-controls': '二千二十五年十月、中国がレアアースの輸出管理を広げ、世界の分離精製の約九割を握る供給網のリスクが問われました。',
  'rate-hike-bear': '二千二十二年、インフレを抑える急激な利上げで世界の株価が広く下落し、債券市場も大打撃を受けました。',
  'tulip-mania': '十七世紀のオランダでチューリップの球根が投機的に急騰し、千六百三十七年二月に暴落しました。',
  'south-sea-bubble': '千七百十一年に設立された英国の南海会社は、千七百二十年に株価が急騰したあと暴落し、多くの投資家が破産しました。',
  'mississippi-bubble': 'ジョン・ローが千七百十七年に立てたミシシッピ会社は、紙幣と株が急騰したあと千七百二十年に暴落しました。',
  'gold-rush-shovels': '千八百四十八年、カリフォルニアで金が見つかり約三十万人が押し寄せましたが、安定して儲けたのは道具や食料を売る商人でした。',
  'weimar-hyperinflation': '第一次大戦後のドイツでは賠償金の支払いと紙幣の増刷で物価が暴走し、千九百二十三年には紙幣が壁紙や燃料になりました。',
  'crash-1929': '千九百二十九年十月、ニューヨークの株価が大暴落し、十月二十九日には約千六百四十万株が取引されました。',
  'black-monday-1987': '千九百八十七年十月十九日、世界の株が同時に暴落し、米国のダウ平均は一日で約二十二パーセント下げました。',
  'japan-bubble-burst': '日本では千九百八十年代に株と地価が大きくふくらみ、千九百九十年代初頭の崩壊のあと、失われた十年が始まりました。',
  'dotcom-bubble': 'インターネット企業の株が五年間で約六倍に上がり、二千二年までにピークから約八割下落して、ドットコムバブルが崩壊しました。',
  'too-big-to-fail': '二千八年九月、リーマン・ブラザーズの破綻で金融危機が激しくなり、各国が大手金融機関に公的資金を注入しました。',
  'dutch-east-india-company': '千六百二年に設立されたオランダ東インド会社は、市民が出資して株を売買する世界最初期の株式会社とされます。',
  'bitcoin-pizza': '二千十年五月、開発者が一万ビットコインと引き換えにピザ二枚を注文しました。当時の価値は約四十一ドルでした。',
  'price-revolution': '十六世紀後半、スペインが持ち込んだ大量の銀で西欧の物価は約百五十年で六倍になり、価格革命と呼ばれました。',
  'zimbabwe-hyperinflation': 'ジンバブエでは二千八年に物価上昇率が約五千億パーセントに達し、百兆ドル札でもバスの運賃を払えませんでした。',
  'season-black-friday': '米国では感謝祭の翌金曜日をブラックフライデーと呼び、小売店が大幅な値引きをして年末商戦が始まります。',
  'season-valentine-chocolate': '二月十四日のバレンタインデーはチョコレートを贈る習慣が広がり、百貨店や製菓会社の大切な商戦になっています。',
  'season-hanami': '日本では三月下旬から五月上旬に桜が咲き、花見の行楽で街がにぎわいます。開花予想は民間の気象事業者が出しています。',
  'season-heatwave': '夏の猛暑日が増えると冷房の需要で電力が逼迫し、電力会社が需給の調整や節電のお願いをすることがあります。',
  'world-space-lottery': '民間事業者による宇宙旅行が商業化されつつあり、旅行者は地球の眺めや無重力を目的にしています。',
  'world-space-debris-business': '地球の軌道には使われた衛星やロケットの部品が多数漂い、運用中の宇宙機への衝突リスクになっています。',
  'space-moon-land': '月の土地を売る業者はいますが、千九百六十七年の宇宙条約が国家による天体の領有を禁じており、所有権は認められていません。',
  'space-mars-reservation': 'オランダの民間団体が二千十二年発表した火星への片道移住計画は資金不足で頓挫し、二千十九年に破産しました。',
  'space-debris': '地球の軌道の宇宙ゴミは衛星や宇宙ステーションへの衝突リスクとなり、民間企業による除去技術の実証も進んでいます。',
  'red-sea-reroute': '二千二十三年十一月から商船への攻撃で海運各社が喜望峰回りに切り替え、スエズを通るコンテナ船のトン数は八割以上減りました。',
  'panama-canal-drought': 'エルニーニョによる少雨でパナマ運河の湖の水位が下がり、二千二十三年十月から一日あたりの通航枠が段階的に減らされました。',
  'cocoa-record-rally': '西アフリカの天候不順でココアが六十年ぶりの供給不足となり、ニューヨークの先物は一トンあたり約一万二千ドルと史上最高値を付けました。',
  'coffee-price-jolt': 'ブラジルの干ばつとベトナムの減産でアラビカコーヒーの先物が二千二十四年に約七割上がり、五十年ぶりの高値になりました。',
  'olive-oil-liquid-gold': '地中海の干ばつでオリーブの収穫が落ち、スペインのオリーブオイルは二千二十四年一月に一トンあたり約九千ユーロまで上がりました。',
  'japan-rice-shock': '二千二十四年、日本の米が品薄になり、農林水産省は二千二十五年二月に備蓄米二十一万トンの放出を決めました。',
  'glp1-boom-denmark': 'デンマークの製薬大手が肥満症の薬で急成長し、二千二十五年の同国の経済成長を医薬品産業が押し上げました。',
  'gold-4000-breakout': '金の先物は二千二十五年十月に初めて一オンス四千ドルを超え、中央銀行の購入が価格を支えました。',
  'labubu-blind-box-craze': '中国の玩具大手が売る中身の見えないブラインドボックスのぬいぐるみが世界で流行し、二千二十四年の売上は前年の約二倍になりました。',
  'venice-daytripper-fee': 'ベネチアは二千二十四年、日帰り観光客に入市料を課す世界初の都市になり、二千二十五年は対象を五十四日に広げました。',
  'crowdstrike-global-outage': '二千二十四年七月、セキュリティ更新の不具合で世界の約八百五十万台の端末が起動不能になり、航空便や病院に障害が出ました。',
  'china-ev-price-war': '中国では二千二十三年以降、電気自動車の値下げ競争が続き、平均の車両価格は二年間で約十九パーセント下がりました。',
  'boeing-door-plug-crisis': '二千二十四年一月、米国の航空機が離陸直後に非常口の蓋を失って緊急着陸し、工場のボルトの付け忘れが原因とされました。',
  'song-jiaozi-paper-money': '十一世紀の北宋、四川の成都で鉄銭の代わりに商人が発行した約束手形が交子と呼ばれ、千二十四年に官の紙幣になりました。',
  'yap-rai-stones': 'ミクロネシアのヤップ島では、動かせない大きな石の円盤が貨幣として扱われ、所有者の移転が口伝で記録されました。',
  'dojima-rice-futures': '大坂の堂島では千七百三十年に公認の米会所が開かれ、米を後日受け渡す先物取引が世界に先駆けて始まりました。',
  'potosi-silver-mountain': '千五百四十五年、現在のボリビアでセロ・リコ銀山が見つかり、ポトシはスペイン帝国最大の銀の供給地になりました。',
  'mansa-musa-cairo-gold': 'マリ帝国の王マンサ・ムーサは千三百二十四年のメッカ巡礼でカイロに金を配り、エジプトの金の価値を揺るがしたと伝わります。',
  'kuwait-souk-al-manakh': 'クウェートの非公式な株式市場は先日付の小切手で膨らみ、千九百八十二年八月の不渡りで崩壊しました。',
  'railway-mania-1846': '千八百四十年代の英国で鉄道株への投機が過熱し、認可された路線の約三分の一は建設されませんでした。',
  'darien-scheme': '千六百九十年代、スコットランド会社がパナマ地峡に築いた植民地は、疫病と補給の失敗で放棄されました。',
  'panic-of-1907': '千九百七年十月、米国で銅会社株の買い占めが失敗して取り付け騒ぎが広がり、モルガンが私財を投じて収束させました。',
  'nixon-shock-1971': '千九百七十一年八月十五日、ニクソン大統領がドルと金の交換を止め、戦後の固定相場制は事実上終わりました。',
  'oil-shock-1973': '千九百七十三年、第四次中東戦争を機に原油の輸出が削られ、価格は約四倍になって先進国をインフレと不況に陥れました。',
  'plaza-accord-1985': '千九百八十五年九月、五か国がプラザ合意でドル高の是正に合意し、ドルは大幅に下落しました。',
  'asian-financial-crisis-1997': '千九百九十七年七月、タイがバーツの固定相場をやめて変動相場制に移り、通貨危機がアジア各地に広がりました。',
  'albanian-pyramid-schemes': '千九百九十年代のアルバニアで超高利回りの投資話が国民の資金を集め、千九百九十七年の破綻で損失は約十二億ドルに達しました。',
  'season-chunyun': '中国では春節の前後四十日間に帰省の移動が集中し、二千二十四年は延べ約九十億人回が見込まれました。',
  'season-ramadan-eid': 'ラマダンはイスラム暦の第九月で約三十日続き、日没後の食事や贈り物に向けて食品や衣料の需要が増えます。',
  'season-hajj-pilgrimage': 'メッカへの巡礼ハッジはイスラム教徒が生涯に一度行うもので、二千二十四年は百八十三万人が訪れました。',
  'season-oktoberfest': 'ミュンヘンのオクトーバーフェストは世界最大級の祭りで、二千二十四年は約六百七十万人が来て、ビールが約七百万杯飲まれました。',
  'season-christmas-market': 'ドイツのクリスマスマーケットは十一月から十二月に開かれ、二千二十四年の来場は約一億七千万回、売上は約四十一億ユーロでした。',
  'season-super-bowl-ads': '米国のスーパーボウルは視聴者の多い中継で、二千二十五年の三十秒広告は平均で約八百万ドルと報じられました。',
  'season-songkran': 'タイの旧正月ソンクラーンは四月十三日から十五日まで水をかけ合う祭りで、二千二十五年の観光収入は二百六十五億バーツを超えました。',
  'season-tomatina': 'スペインのブニョルで八月の最終水曜日に行われるトマティーナは、二千二十五年に約二万二千人が参加し、約百二十トンのトマトが使われました。',
  'season-diwali-gold': 'ヒンドゥー教の祭りディワリでは初日に金を買う習慣があり、二千二十六年のインドの金需要は金額で前年より一割から二割半増えました。',
  'season-singles-day': '中国の十一月十一日は独身の日と呼ばれ、電子商取引の各社が大規模な割引販売を行います。',
  'city-olympics-boom': '千九百六十四年の東京五輪に向けて高速道路や新幹線が整備され、開催都市では地価と消費が大きく伸びました。',
  'city-factory-closure': 'デトロイトは二十世紀後半に自動車工場の閉鎖と人口流出が続き、二千十三年に連邦破産法の適用を申請しました。',
  'city-gold-strike': '千八百九十年代、西オーストラリアで金鉱が相次いで見つかり、パースなどの都市に人口と資本が集まりました。',
  'city-port-strike': '二千二十四年十月、米国の港湾労働者が大規模なストライキを行い、東海岸とメキシコ湾岸の主要港が止まりました。',
  'city-casino-resort': '大阪は二千二十三年、カジノを含む統合型リゾートの計画で国の認定を受け、二千三十年ごろの開業を目指しています。',
  'city-water-crisis': 'メキシコシティは地下水への依存と地盤沈下で水不足が慢性化し、給水制限が繰り返されています。',
};

/**
 * 結果の読み上げ（固定文）。数値は画面にだけ出し、声は「何が起きたか」の種類だけを読む。
 * イベントの効果からこの中の 1 文を選ぶ（eventResultSpeech）。
 */
export const EVENT_RESULT_LINES = {
  choicePrompt: 'さあ、どうする？',
  autoApplied: '効果が自動で適用されます。',
  gambleWin: '賭けは成功しました。',
  gambleLose: '賭けは失敗しました。',
  cashGain: 'お金が入りました。',
  cashLoss: 'お金が出ていきました。',
  allGain: '全員にお金が入りました。',
  allPay: '全員が支払いました。',
  otherMoney: '誰かの懐が動きました。',
  industryUp: '業界全体の風向きが変わりました。',
  industryDown: '業界全体に冷たい風が吹きました。',
  cityUp: '街の景気が上向きました。',
  cityDamage: '街が打撃を受けました。',
  cityBlockade: '街が封鎖されました。',
  sold: '物件が手放されました。',
  piperMoved: '取り立て屋が移りました。',
  skipTurn: '一回休みです。',
  forcedMove: '強制的に移動させられました。',
  cardGain: 'カードを手に入れました。',
  priceUp: '物件の値段が上がりました。',
  priceDown: '物件の値段が下がりました。',
} as const;

/** 半角の ! ? を全角にそろえる（VOICEVOX が読みやすい形にする）。 */
function spokenTitle(title: string): string {
  return title.replace(/[!?]/g, (mark) => (mark === '!' ? '！' : '？'));
}

/** 見出しの頭に置く「種類の紹介」。パネルのリボン／バッジ（KIND_JA）と同じ言葉で読む。 */
const KIND_PREFIX: Record<GameEventDef['kind'], string> = {
  news: '世界ニュース！',
  history: '歴史の真実！',
  fable: '創作寓話！',
};

/**
 * 冒頭でナレーターが読む行: 見出し → 事実の読み上げ。
 * `factSpeech` はデータ読み込み時に付く（src/data/index.ts）。テスト用の少量データでも
 * 同じ関数で動くよう、付いていないときは id の表から引く。
 */
export function eventOpeningSpeech(event: GameEventDef): string[] {
  const title = TITLE_SPEECH[event.id] ?? spokenTitle(event.title);
  const prefix = event.monthly === true ? '月替わりイベント！' : KIND_PREFIX[event.kind];
  const lines = [`${prefix}${title}`];
  const fact = event.factSpeech ?? FACT_SPEECH[event.id];
  if (fact) lines.push(fact);
  return lines;
}

/**
 * データ読み込み時に fact の読み上げ文を付ける（events.json には書かない）。
 * 音声の出典はこのモジュール 1 か所なので、字幕（factSpeech）と音声がずれない。
 */
export function withFactSpeech(event: GameEventDef): GameEventDef {
  const factSpeech = FACT_SPEECH[event.id];
  return factSpeech ? { ...event, factSpeech } : event;
}

/** 掛け合いのあとに置く 1 行（選択イベントは問いかけ、自動適用は予告）。 */
export function eventOpeningTail(event: GameEventDef): string {
  return (event.choices?.length ?? 0) > 0
    ? EVENT_RESULT_LINES.choicePrompt
    : EVENT_RESULT_LINES.autoApplied;
}

/** 選んだ選択肢の読み上げ。名前を出さないので CPU の選択でもそのまま使える。 */
export function choiceMadeSpeech(label: string): string {
  return `『${CHOICE_LABEL_SPEECH[label] ?? label}』を選びました。`;
}

/** 効果がプラスか（cash / cash_pct / per_property だけを見る）。 */
function isGain(effect: Effect): boolean {
  if (effect.op === 'cash') return effect.amount >= 0;
  if (effect.op === 'cash_pct') return effect.pct >= 0;
  if (effect.op === 'per_property') return effect.perProperty >= 0;
  return true;
}

/** 適用済みの fx から賭けの勝敗を読む（applyEffect が押すトーストと同じ文字列）。 */
export function gambleOutcomeOf(emitted: readonly Fx[]): 'win' | 'lose' | null {
  for (const fx of emitted) {
    if (fx.t !== 'toast') continue;
    if (fx.text === GAMBLE_WIN_TOAST) return 'win';
    if (fx.text === GAMBLE_LOSE_TOAST) return 'lose';
  }
  return null;
}

/** 効果の種類から結果の 1 文を選ぶ（優先度の高いものだけを読む）。未知の op は無言。 */
function effectResultSpeech(effects: readonly Effect[]): string | null {
  const L = EVENT_RESULT_LINES;
  const pick = <T extends Effect['op']>(op: T): Extract<Effect, { op: T }> | undefined =>
    effects.find((effect): effect is Extract<Effect, { op: T }> => effect.op === op);

  if (pick('sell')) return L.sold;
  if (pick('piper')) return L.piperMoved;
  if (pick('skip')) return L.skipTurn;
  if (pick('realm') || pick('move')) return L.forcedMove;
  const city = pick('city_mod');
  if (city) {
    if (city.kind === 'damage') return L.cityDamage;
    if (city.kind === 'blockade') return L.cityBlockade;
    return L.cityUp;
  }
  const industry = pick('industry_mod');
  if (industry) return industry.mult > 1 ? L.industryUp : L.industryDown;
  const price = pick('price_mod');
  if (price) return price.mult > 1 ? L.priceUp : L.priceDown;
  if (pick('card')) return L.cardGain;
  const money = pick('cash') ?? pick('cash_pct') ?? pick('per_property');
  if (money) {
    const gain = isGain(money);
    if (money.who === 'all') return gain ? L.allGain : L.allPay;
    if (money.who === 'self') return gain ? L.cashGain : L.cashLoss;
    return L.otherMoney;
  }
  return null;
}

/**
 * 1 イベントを解決したあとの結果ナレーション。数値は画面に任せ、声は種類だけ。
 * `emitted` は applyEffects が今回押した fx（賭けの勝敗をトーストから読む）。
 * 効果が無ければ何も読まない（null）。
 */
export function eventResultSpeech(
  effects: readonly Effect[] | undefined,
  emitted: readonly Fx[],
): string | null {
  const outcome = gambleOutcomeOf(emitted);
  if (outcome === 'win') return EVENT_RESULT_LINES.gambleWin;
  if (outcome === 'lose') return EVENT_RESULT_LINES.gambleLose;
  const list = effects ?? [];
  if (list.length === 0) return null;
  return effectResultSpeech(list);
}

/**
 * gen-voice 用: イベント本編で再生しうる全ナレーション（narrator の声で生成する）。
 * 見出し・事実・問いかけ／予告・選択・結果を 1 か所から列挙するので、字幕と音声がずれない。
 */
export function allEventSpeechTexts(events: readonly GameEventDef[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    // weight 0 は取り立て屋の示談などコード定義の専用イベント。本編の say 経路を通らない
    // （engine が id で先に解決する）ので、ナレーションも生成しない。
    if (event.weight <= 0) continue;
    texts.push(...eventOpeningSpeech(event));
    texts.push(eventOpeningTail(event));
    for (const choice of event.choices ?? []) texts.push(choiceMadeSpeech(choice.label));
  }
  texts.push(...Object.values(EVENT_RESULT_LINES));
  return texts;
}

/** データ検証用: 読み上げ表のキー（イベント id → 読み上げ文）。 */
export const EVENT_SPEECH_TABLES = {
  title: TITLE_SPEECH,
  fact: FACT_SPEECH,
  choice: CHOICE_LABEL_SPEECH,
} as const;