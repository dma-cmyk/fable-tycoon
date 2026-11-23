# VOICEVOX 話者ライセンス調査（本作で使用する音声）

調査日: 2026-11-23
対象エンジン: VOICEVOX ENGINE 0.25.2（`http://127.0.0.1:50021`）
調査方法: 全話者の `GET /speaker_info?speaker_uuid=...` の `policy` を読み、各公式利用規約ページを取得して政治・宗教・特定思想に関する条項を確認した。取得日はすべて 2026-11-23。

## 0. 判定基準

本作「グローバル寓話大富豪」は、関税・補助金・買収・バブルなどを題材にした**政治・経済の風刺**を含む。実在の存命人物は登場させず、役割の戯画（関税おじさん等）で描くが、話者ライセンスの「政治的利用」該当性は保守的に判定する。

| 判定 | 意味 |
|---|---|
| **OK** | 規約上、政治・宗教・特定思想の表現を禁止していない。本作の風刺に使用可能。商用条件は別欄。 |
| **NG** | 政治活動・政治的発言・特定政党/政治家の称賛/批判・特定イデオロギーなどを明示的に禁止。またはゲーム利用が標準許諾の対象外。本作では**使用しない**。 |
| **UNCLEAR** | 「特定の思想・団体」等の曖昧な禁止がある、規約ページが取得できない、商用・ゲーム利用に個別相談が必要で、風刺利用の可否を判断できない。本作では**使用しない**。 |

「商用」欄は VOICEVOX 音源を用いた音声の利用条件。クレジット表記は全話者で必須（例外は個別に記載）。

## 0.1 VOICEVOX 本体

VOICEVOX 本体のソフトウェア利用規約（https://voicevox.hiroshiba.jp/term/）は商用・非商用利用を許諾し、生成音声の利用については各音声ライブラリの規約に従うことを求めている。本作は VOICEVOX で事前生成した固定音声のみを使用し、エンジン本体の再配布は行わない。

## 1. 全話者一覧（43 話者）

| # | 話者 | クレジット表記 | 商用利用 | 政治・宗教・風刺に関する制限 | 判定 | 根拠 URL（読んだページ） |
|---|---|---|---|---|---|---|
| 1 | 四国めたん | `VOICEVOX:四国めたん` | 可（クレジット必須） | 政治活動・宗教活動・それらにつながる行為、特定の個人・団体（国家含む）の非難/批判/応援を禁止 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 2 | ずんだもん | `VOICEVOX:ずんだもん` | 可（クレジット必須） | 同上（Zunko Project 共通規約） | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 3 | 春日部つむぎ | `VOICEVOX:春日部つむぎ` | 可（クレジット必須） | 「特定の思想・団体に関係するもの」を禁止。政治風刺への適用可否が不明 | UNCLEAR | https://tsumugi-official.studio.site/rule |
| 4 | 雨晴はう | `VOICEVOX:雨晴はう` | 可（クレジット必須） | 「特定の思想運動の勧誘・社会問題の特定の主張に当たる行為団体」を禁止。風刺ゲームへの適用可否が不明 | UNCLEAR | https://amehau.com/?page_id=225 |
| 5 | 波音リツ | `VOICEVOX:波音リツ` | 可（クレジット必須／公式は表記不要とも） | 「性的表現、暴力的表現、政治的表現、宗教的表現など基本的に一切禁止しません」と明記 | **OK** | https://www.canon-voice.com/terms |
| 6 | 玄野武宏 | `VOICEVOX:玄野武宏(CV:ガロ)` | 可（クレジット必須） | 特定の政治団体の宣伝・過度な称賛・毀損、特定の宗教の過度な称賛/毀損、特定の個人・集団・国家・民族・思想の毀損を禁止 | UNCLEAR | https://web.archive.org/web/20261008172306/https://www.virvoxproject.com/voicevox%E3%81%AE%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84 |
| 7 | 白上虎太郎 | `VOICEVOX:白上虎太郎` | 可（クレジット必須） | 同上（VirVox Project 共通） | UNCLEAR | 同上（VirVox 利用規約） |
| 8 | 青山龍星 | `VOICEVOX:青山龍星` | 可（個人）。企業・個人事業主・企業契約者は「ななはぴ」へ事前申請 | 同上（VirVox Project 共通） | UNCLEAR | 同上（VirVox 利用規約） |
| 9 | 冥鳴ひまり | `VOICEVOX:冥鳴ひまり` | 可（クレジット必須） | 「特定の思想・団体に当たる行為」を禁止。政治風刺への適用可否が不明 | UNCLEAR | https://meimeihimari.wixsite.com/himari/terms-of-use |
| 10 | 九州そら | `VOICEVOX:九州そら` | 可（クレジット必須） | Zunko Project 共通規約（政治的利用禁止） | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 11 | もち子さん | `VOICEVOX:もち子(cv 明日葉よもぎ)` | **ゲーム作品等は標準許諾の対象外**。音声作品・音声素材・ゲーム作品等を除く商用/非商用利用のみ可 | フィクションの域を超えた特定の政治・思想・宗教への勧誘・応援・非難・活動を禁止 | NG（本作はゲーム） | https://vtubermochio.wixsite.com/mochizora/%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84 |
| 12 | 剣崎雌雄 | `VOICEVOX:剣崎雌雄` | 可（クレジット必須） | 特定の思想・政治運動への勧誘、社会問題への特定の主張、それらを掲げる実在団体との関係を禁止 | UNCLEAR | https://frontier.creatia.cc/fanclubs/413/posts/4507 |
| 13 | WhiteCUL | `VOICEVOX:WhiteCUL` | 可（クレジット必須） | 政治・宗教・特定思想の禁止条項なし（公序良俗・誹謗中傷・権利侵害のみ） | **OK** | https://www.whitecul.com/guideline （アーカイブ: https://web.archive.org/web/20260712024913/https://www.whitecul.com/guideline） |
| 14 | 後鬼 | `VOICEVOX:後鬼` | 可（クレジット必須）。企業の商用利用はプロジェクトへ事前確認 | 政治・宗教の禁止条項なし。誹謗中傷、歴史修正主義、差別、犯罪助長を禁止 | **OK** | https://ついなちゃん.com/voicevox_terms/ （取得は https://xn--n8jychz0k1d.com/voicevox_terms/） |
| 15 | No.7 | `VOICEVOX:No.7` | 非商用は無料。商用は個別ライセンス。**ゲームでの利用は要相談（条件未確定）** | 政治・宗教の明示的な禁止条項なし | UNCLEAR | https://voiceseven.com/#j0200 |
| 16 | ちび式じい | `VOICEVOX:ちび式じい` | 可（クレジット必須） | 「政治・宗教に関わる攻撃や誹謗中傷や主張」を明示的に禁止 | NG | https://docs.google.com/presentation/d/1AcD8zXkfzKFf2ertHwWRwJuQXjNnijMxhz7AJzEkaI4 |
| 17 | 櫻歌ミコ | `VOICEVOX:櫻歌ミコ` | 可（クレジット必須） | 実在する特定の政治・宗教を支持または批判する内容、投資・金融取引の情報商材を禁止 | NG | https://voicevox35miko.studio.site/rule |
| 18 | 小夜/SAYO | `VOICEVOX:小夜/SAYO` | 可（クレジット必須） | 政治・宗教・特定思想の禁止条項なし（誹謗中傷・公序良俗のみ） | **OK** | https://316soramegu.wixsite.com/sayo-official/guideline |
| 19 | ナースロボ＿タイプＴ | `VOICEVOX:ナースロボ＿タイプＴ` | 可（クレジット必須） | 政治宣伝、特定の思想・イデオロギー・団体・宗教に関係する行為を禁止 | NG | https://www.krnr.top/rules |
| 20 | †聖騎士 紅桜† | `VOICEVOX:†聖騎士 紅桜†` | 可（クレジット必須） | 特定の思想・団体への支持・勧誘・宣伝を禁止。風刺・批判は禁止していない | **OK** | https://commons.nicovideo.jp/material/nc296132 |
| 21 | 雀松朱司 | `VOICEVOX:雀松朱司` | 可（クレジット必須） | VirVox 共通（特定政党・国家・思想の毀損を禁止） | UNCLEAR | 同上（VirVox 利用規約） |
| 22 | 麒ヶ島宗麟 | `VOICEVOX:麒ヶ島宗麟` | 可（クレジット必須） | VirVox 共通 | UNCLEAR | 同上（VirVox 利用規約） |
| 23 | 春歌ナナ | `VOICEVOX:春歌ナナ` | 可（クレジット必須） | 「特定の思想や団体に関係するもの」を禁止 | UNCLEAR | https://nanahira.jp/haruka_nana/guideline.html |
| 24 | 猫使アル | `VOICEVOX:猫使アル` | 可（クレジット必須） | 「政治的/宗教的用途」を明示的に禁止 | NG | https://nekotukarb.wixsite.com/nekonohako/%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84 |
| 25 | 猫使ビィ | `VOICEVOX:猫使ビィ` | 可（クレジット必須） | 同上 | NG | 同上（猫使 利用規約） |
| 26 | 中国うさぎ | `VOICEVOX:中国うさぎ` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 27 | 栗田まろん | `VOICEVOX:栗田まろん` | 可（クレジット必須） | 政治・宗教・特定思想の禁止条項なし | **OK** | https://aivoice.jp/character/maron/ |
| 28 | あいえるたん | `VOICEVOX:あいえるたん` | 可（クレジット必須） | 特定の思想・宗教・政治的発言、批判・侮辱を禁止 | NG | https://www.infiniteloop.co.jp/special/iltan/terms/ |
| 29 | 満別花丸 | `VOICEVOX:満別花丸` | 可（クレジット必須） | 特定の政党・政治家などを極端に賞賛または批判する内容を禁止 | NG | https://100hanamaru.wixsite.com/manbetsu-hanamaru/rule |
| 30 | 琴詠ニア | `VOICEVOX:琴詠ニア` | 可（クレジット必須） | 公開ライセンスは「ネット全般」のみで、政治条項の一次文書を確認できず | UNCLEAR | https://commons.nicovideo.jp/works/nc315435 |
| 31 | Voidoll | `VOICEVOX:Voidoll(CV:丹下桜)` | 個人は可。法人は個別問い合わせ | 特定の個人・集団・国家・民族・思想の毀損、特定の政治派閥・宗教の過度な称賛/毀損を禁止 | NG | https://blog.nicovideo.jp/niconews/224589.html |
| 32 | ぞん子 | `VOICEVOX:ぞん子` | 非営利は可。商用は個別問い合わせ | 特定の信条・宗教・政治的発言のための利用を禁止 | NG | https://zonko.zone-energy.jp/guideline |
| 33 | 中部つるぎ | `VOICEVOX:中部つるぎ` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 34 | 離途 | `VOICEVOX:離途` | 可（クレジット必須） | 公式の規約本文を取得できず（サイト内に該当ページが見つからない） | UNCLEAR | https://litmus9.com/#/voicebank#rules |
| 35 | 黒沢冴白 | `VOICEVOX:黒沢冴白` | 可（クレジット必須） | VirVox 共通 | UNCLEAR | 同上（VirVox 利用規約） |
| 36 | ユーレイちゃん | `VOICEVOX:ユーレイちゃん(CV:神崎零)` | 非商用は可（クレジット必須）。商用・法人利用はユーステラの事前許可 | 政治・宗教・特定思想の禁止条項なし（イメージ損傷・公式誤認のみ） | **OK** | https://u-stella.co.jp/voicevox-ure-chan-tucumo-terms-of-use/ |
| 37 | 東北ずん子 | `VOICEVOX:東北ずん子` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 38 | 東北きりたん | `VOICEVOX:東北きりたん` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 39 | 東北イタコ | `VOICEVOX:東北イタコ` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 40 | あんこもん | `VOICEVOX:あんこもん` | 可（クレジット必須） | Zunko Project 共通規約 | NG | https://zunko.jp/con_ongen_kiyaku.html |
| 41 | 夜語トバリ | `VOICEVOX:夜語トバリ` | 非商用のみ可。法人・商用は要問い合わせ | 「政治的利用」を明示的に禁止 | NG | https://yogataritobari.studio.site/#rules |
| 42 | 暁記ミタマ | `VOICEVOX:暁記ミタマ` | 非商用のみ可。法人・商用は要問い合わせ | 「政治的利用」を明示的に禁止 | NG | https://yogataritobari.studio.site/#rules |
| 43 | 里石ユカ | `VOICEVOX:里石ユカ（つぼみ）` | 非営利・同人は可。個人の大規模営利・法人利用は事前相談 | 実在する宗教・政治への勧誘、特定の個人・団体を非難する目的を禁止。AI 生成作品への利用も禁止 | UNCLEAR | https://satoishiyuka.wixsite.com/satoishi/kiyaku |

### 補足

- **Zunko Project 9 話者**（四国めたん、ずんだもん、九州そら、中国うさぎ、中部つるぎ、東北ずん子、東北きりたん、東北イタコ、あんこもん）は共通規約で「政治活動、宗教活動またはそれらにつながる行為での利用。特定の個人、団体（国家を含む）を非難・批判するまたは応援する目的での利用」を禁止している。本作は政治・経済風刺を含むため **NG** と判定した。
- **VirVox Project 6 話者**（玄野武宏、白上虎太郎、青山龍星、雀松朱司、麒ヶ島宗麟、黒沢冴白）は、特定政党・国家・民族・思想の毀損を禁止する条項があり、風刺が「毀損」と評価される可能性を排除できないため **UNCLEAR** とした。なお 2026-11-23 時点で公式サイトはメンテナンス表示のため、アーカイブ版で確認した。
- **WhiteCUL / 小夜/SAYO / 栗田まろん / 波音リツ / 後鬼 / †聖騎士 紅桜†** は、政治・宗教・特定思想の包括的禁止条項がない（または政治的表現を明示的に許容する）ため **OK**。
- **ユーレイちゃん** は政治条項がないため **OK** だが、標準許諾は非商用に限られる。本作を商用化する場合はユーステラへ事前許諾を取ること。
- 本作は実在の存命人物を名指しせず、特定の民族・宗教・国家を標的にしない。風刺の対象は制度・政策・金銭欲そのものに限定する。

## 2. 本作で使用する話者（OK のみ）

| 話者 | 使用スタイル ID | クレジット | 備考 |
|---|---|---|---|
| 波音リツ | 9（ノーマル）, 65（クイーン） | `VOICEVOX:波音リツ` | 政治的表現を明示的に許容 |
| WhiteCUL | 23（ノーマル）, 24（たのしい）, 25（かなしい）, 26（びえーん） | `VOICEVOX:WhiteCUL` | 商用可 |
| 後鬼 | 27（人間ver.）, 28（ぬいぐるみver.）, 87（人間（怒り）ver.）, 88（鬼ver.） | `VOICEVOX:後鬼` | 商用可。企業利用は事前確認 |
| 小夜/SAYO | 46（ノーマル） | `VOICEVOX:小夜/SAYO` | 商用可 |
| 栗田まろん | 67（ノーマル） | `VOICEVOX:栗田まろん` | 商用可 |
| †聖騎士 紅桜† | 51（ノーマル） | `VOICEVOX:†聖騎士 紅桜†` | 商用可。公式推奨表記は `VOICEVOX †聖騎士 紅桜†` |
| ユーレイちゃん | 103（甘々）, 104（哀しみ）, 105（ささやき）, 106（ツクモちゃん） | `VOICEVOX:ユーレイちゃん(CV:神崎零)` | 非商用のみ。商用化時は事前許諾 |

使用話者の全スタイル ID は VOICEVOX ENGINE 0.25.2 の `GET /speakers` に存在することを確認済み。

## 3. ゲーム内クレジット表示用テキスト

タイトル画面の「クレジット」および README に、以下をそのまま表示する。

```text
音声合成: VOICEVOX (https://voicevox.hiroshiba.jp/)

VOICEVOX:波音リツ
VOICEVOX:WhiteCUL
VOICEVOX:後鬼
VOICEVOX:小夜/SAYO
VOICEVOX:栗田まろん
VOICEVOX:†聖騎士 紅桜†
VOICEVOX:ユーレイちゃん(CV:神崎零)
```

補足表示（任意）:

```text
ユーレイちゃんの音声は非商用利用の許諾範囲で使用しています。
本作を商用利用する場合は、各権利者の規約に従い事前許諾を取得してください。
```

## 4. 再確認事項

- 本ドキュメントは法的助言ではない。判定に疑義がある場合や商用化する場合は、各権利者・公式窓口へ確認する。
- 公開前・商用化前に、各公式規約ページを再取得して最新の条文を確認する。
- 新しい話者を追加する場合は、この表に判定と根拠 URL を追記し、OK の話者のみを使用する。
- クレジット表記は「ユーザーが少し探せば分かる場所」に置く（タイトル画面クレジット + README）。
- 音声は VOICEVOX で事前生成した固定台詞のみ。リアルタイム合成や声質変換は行わない。