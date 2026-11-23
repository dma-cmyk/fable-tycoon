# グローバル寓話大富豪 〜世界童話経済すごろく〜

世界中の童話キャラクターが現実の世界地図を旅し、物件を買い漁り、政治・経済・歴史の風刺ニュースに振り回されながら世界一の大富豪を目指す、ブラックコメディ経済すごろく。PC・スマートフォンのブラウザで遊べます。

- **プレイ**: https://dma-cmyk.github.io/fable-tycoon/
- **モード**: CPU 対戦 / 同じ端末で交代するローカル対戦 / オンライン対戦（最大 4 人、CPU 混在、招待 URL）
- **内容**: 実在の 340 都市・約 900 マスの世界地図（デフォルメ変形・季節表現）、天国・地獄・宇宙の異世界マップ、48 人の童話キャラクター（喜怒の表情差分つき）、出典付きの風刺ニュース・歴史・季節イベント 74 件、電車・船・飛行機・ロケットの乗り物演出、VOICEVOX によるフルボイス（約 3,800 台詞）、チャット・エモート・ちょっかいアクション

## オンライン対戦のしくみ

専用サーバーを持ちません。ルームを作った人のブラウザがゲームの進行役（ホスト）になり、公開 MQTT ブローカー経由で合流したあと、WebRTC で端末同士を直結します。通信内容はルーム ID から作った鍵で暗号化されます。ホストが切断した場合は、残った参加者の 1 人が自動的に進行役を引き継ぎます。詳細は [docs/DESIGN.md](docs/DESIGN.md) §1.1。

## 開発

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm test           # ルール・ルーム・通信のテスト
npm run e2e:online # 4 ブラウザ実機 E2E（Chromium / WebKit / Firefox、約 5〜10 分）
npm run build      # dist/ に静的ファイルを出力
```

| コマンド | 内容 |
|---|---|
| `npm run board` | `src/data/cities.json` から盤面 `board.json` と地図 `land.json` を生成 |
| `npm run validate` | 全データ（都市・盤面・キャラ・イベント・カード・エモート）の検証 |
| `npm run e2e:online` | 4 つの別ブラウザでオンライン対戦を最後まで実プレイ（`tests/e2e/README.md`） |
| `npm run voice` | VOICEVOX（`127.0.0.1:50021`）で未生成の台詞音声を生成 |

都市・キャラクター・イベント・エモートの追加手順は [docs/CONTENT.md](docs/CONTENT.md)。

## ドキュメント

- [docs/DESIGN.md](docs/DESIGN.md) ルールと設計
- [docs/UI.md](docs/UI.md) 画面と描画・音声 API
- [docs/CONTENT.md](docs/CONTENT.md) コンテンツ追加ガイド
- [docs/voicevox-licensing.md](docs/voicevox-licensing.md) VOICEVOX 話者の規約調査
- [docs/events-research.md](docs/events-research.md) イベントの出典
- [docs/CREDITS.md](docs/CREDITS.md) クレジット

## 素材とクレジット

- キャラクター・ランドマーク・イベント挿絵: Codex（画像生成）で制作したオリジナル。
- 音声: VOICEVOX（話者ごとのクレジットは [docs/CREDITS.md](docs/CREDITS.md)）。
- BGM: Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0。
- 地図: Natural Earth（パブリックドメイン）由来の world-atlas。

本作の風刺は創作です。実在の人物・団体を名指しせず、役割の戯画として描いています。各イベントの事実部分と創作部分はゲーム内の「元ネタ」から確認できます。
