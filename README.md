# portfolio

Kota0004 の制作実績とデモ作品を載せる、静的な Web サイトです。
GitHub Pages で公開します（Pages を有効にしたあとの URL: https://kota0004.github.io/portfolio/ ）。

- 制作実績: 防災アプリ「みずみち」、空き教室検索「RoomRadar」（大学非公式・テスト運用中）
- デモ作品: 予約フォーム、CSV 集計ツール（どちらも架空のデータで動き、入力したデータは外部に送られません）
- できること: 小さな Web ツール、表計算の作業の自動化、サークル・学生団体の出欠・予約ページ

外部のスクリプト・CDN・Web フォント・アクセス解析は使いません。すべてこのリポジトリのファイルだけで動きます。

## 構成

```
site/                     ← 公開されるのはここだけ
  index.html              実績紹介ページ
  assets/
    base.css              全ページ共通の見た目（色の変数、ヘッダー、カード、ボタン、フォームなど）
    site.css              実績紹介ページだけで使うスタイル
  demos/
    reservation/          予約フォームのデモ
    csv/                  CSV 集計ツールのデモ
tests/
  unit/*.test.js          単体テスト（node:test、依存なし）
  e2e/*.e2e.js            ブラウザのテスト（Playwright の Chromium を使う）
.github/workflows/
  pages.yml               site/ を GitHub Pages に公開する
  tests.yml               push と pull request のたびにテストを走らせる
drafts/                   下書き置き場（サイトには載らない）
```

### ページを作るときの約束

- どのページも同じヘッダーとフッターを使う（`site/index.html` の `<header>` と `<footer>` をそのまま写し、
  リンクの先頭 `./` を、`demos/xxx/` のページでは `../../` にする）。
- 色は `base.css` の変数（`--bg` `--surface` `--text` `--muted` `--line` `--accent` など）だけで指定する。
  こうしておくと、端末の設定に合わせたライト/ダークの切り替えが自動で効く。
- 外部のファイルを読み込まない（`<script src="https://...">`、Web フォント、解析タグなどは使わない）。
- 幅 375px のスマホで横スクロールが出ないこと。押す場所は高さ 44px 以上。キーボードだけで操作できること。
- 計算などのロジックは DOM から切り離した JS ファイル（例: `xxx-core.js`）に書き、単体テストで確かめる。

## 手元での確認

リポジトリの一番上で:

```sh
python3 -m http.server 8000 -d site
```

ブラウザで http://localhost:8000/ を開きます。

## テストの実行

単体テスト（Node.js 20 以上。追加のインストールは不要）:

```sh
node --test tests/unit/*.test.js
```

ブラウザのテスト（Playwright と Chromium が必要）:

```sh
npm install --no-save --no-package-lock playwright   # 初回だけ
npx playwright install chromium                       # 初回だけ

python3 -m http.server 8000 -d site &                 # サーバを立てておく
for f in tests/e2e/*.e2e.js; do node "$f" || echo "失敗: $f"; done
```

- 開く先は環境変数 `BASE_URL` で変えられます（既定は `http://localhost:8000`）。
- 各テストは確認項目ごとに `OK` / `NG` を出し、最後に「合計: N 件成功 / M 件失敗」を出します。失敗があると終了コードが 1 になります。
- 外部への通信（localhost 以外へのリクエスト）とコンソールのエラーが無いことも確かめています。
- `tests/e2e/site.e2e.js` は、環境変数 `SCREENSHOT_DIR` を指定すると、幅 375px と 1280px のライト・ダークのスクリーンショットをそこに保存します。
- `tests/e2e/site.e2e.js` は、環境変数 `PORTFOLIO_FORBIDDEN_WORDS`（カンマ区切り）に入れた語（実名など）がページに無いことも確かめます。
  語はこのリポジトリに書かず、手元では環境変数で、GitHub では **Settings → Secrets and variables → Actions** の
  `PORTFOLIO_FORBIDDEN_WORDS` に入れます。未設定なら、この確認だけ省略されます。

GitHub 上では `.github/workflows/tests.yml` が、push と pull request のたびに同じテストを自動で走らせます。

## 公開のしかた

1. 変更を main にマージする。`site/` の中が変わると `.github/workflows/pages.yml` が動き、
   単体テストが通ったら `site/` の中身だけを GitHub Pages に公開します（テストが落ちたら公開しません）。
2. はじめての公開のときだけ、リポジトリの **Settings → Pages → Build and deployment → Source** を
   **GitHub Actions** にしてから、Actions の画面でこのワークフローを再実行してください。
   設定する前に動いた場合は、ワークフローの画面（Summary）に手順を書いて、公開せずに正常終了します。
3. Actions の画面から手動で公開しなおすこともできます（workflow_dispatch）。

## drafts/ について

`drafts/` は下書き置き場です。Pages に公開するのは `site/` だけなので、サイトには載りません。
ただし、**このリポジトリ自体は公開されているので、`drafts/` の中も誰でも読めます。** 人に見られて困ることは書かないでください。

## 置かないもの

- 依頼主の情報（名前、連絡先、やりとり、受け取ったデータなど）は、このリポジトリのどこにも置かない。非公開の場所で管理する。
- 実名・メールアドレスなどの個人の連絡先も置かない。サイト上の表示名は「Kota0004」だけにする。
