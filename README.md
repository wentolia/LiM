# SABAKAN

> 旧称 LiM（Less is More）。

Cosense の書きやすさと Google ドキュメントの整える力を、**オープンな形式**（Markdown + frontmatter + `[[リンク]]`）の上で実現するノート / データベースアプリ。

## コンセプト：Less is More

コアは 3 要素だけ。機能はすべてこの組み合わせで表現する。

| 要素 | 定義 |
| --- | --- |
| **Page** | 1 Markdown ファイル。本文 + プロパティ（frontmatter）+ リンク |
| **Query** | Page 集合の絞り込み（`where` / `sort` / `group` / `view` の 4 語） |
| **View** | 結果の描き方（document / cards / table / board / calendar …） |

| 機能 | 実体 |
| --- | --- |
| バックリンク・関連ページ | `where: links_to: this` → cards |
| Notion 的 DB | `where: type = book` → table / board |
| タグページ | `where: tag: 設計` → cards |
| 全文検索 | `where: text: "..."` → list |

## 構成（予定）

- 保存：Google ドライブ（`pages/*.md`, `assets/*`）— `Store` I/F で差し替え可能
- 処理：Cloudflare Pages / Workers / D1（索引）/ Durable Objects + Yjs（共同編集）

## パッケージ

| パス | 中身 |
| --- | --- |
| `packages/core` | Page の解析・書き出し、リンクグラフ（2hop）、Query エンジン、Store I/F |
| `apps/web` | Web アプリ（Vite + React + CodeMirror 6）。プロジェクト一覧、ページ一覧（ギャラリー／表）とページ編集、メンバー |
| `apps/api` | Cloudflare Worker（`/api/*`）。Google ログイン、プロジェクトとメンバー（D1）、管理者のドライブへの読み書き |

## 開発

Node.js 22 以上。

```sh
npm install
npm run dev        # http://localhost:5173（/api は :8787 へ中継）
npx wrangler dev   # API（ローカル D1）。.dev.vars に GOOGLE_CLIENT_SECRET=... を書く
npm test           # core / web / api のテスト
npm run build      # 型チェック + 本番ビルド（apps/web/dist）
```

## プロジェクトと保存先

- **プロジェクト** = 管理者のマイドライブ/SABAKAN/<プロジェクト名>/ フォルダ（中に `pages/*.md`）
- メンバーは Google で本人確認だけ行う。読み書きはサーバーが管理者の代わりに行う（管理者の refresh token を D1 に保存）
- 招待はメールアドレスを登録するだけ。その Google アカウントでログインすると一覧に出る
- 役割：管理者（招待・外す）／メンバー（ページの読み書き）
- 管理者が最初にドライブを接続したとき、以前の SABAKAN/pages があれば「マイページ」プロジェクトとして取り込む
- スコープは `drive.file`（SABAKAN が作ったファイルだけ）。削除はドライブのゴミ箱へ
- 「このブラウザだけで使う」を選ぶと localStorage に保存（ログイン不要）
- 画像：貼り付け・ドロップで `assets/<日時>.<拡張子>` に保存し、ページには `![](../assets/…)` と書く（プロジェクトのみ）
- 他の人の変更：10 秒ごと／画面に戻ったときに取り込む。編集中でなければ開いているページにも反映
- リアルタイム共同編集（プロジェクト）：ページを開くと、そのファイルの「部屋」（Durable Object `PageRoom`）に WebSocket でつながる。Yjs で文字単位に合成し、相手のカーソルと名前を表示。部屋は 3 秒おき・最後の人が抜けたときにドライブへ書き出す
  - ドライブ側が別に書き換えられていたら、行単位の 3-way マージで合わせてから書き出す。改名・削除されたファイルの部屋は閉じる
- このブラウザだけのモードは従来どおり自分で保存（楽観ロック＋3-way マージ）

## 今後の機能を載せる土台

| 土台 | 使い方 |
|---|---|
| ログイン・プロジェクト・メンバー（`apps/api/src/app.ts`, D1） | 新しい機能も「プロジェクト内のファイル」を読み書きするだけで、権限はそのまま効く |
| ファイル API（`/api/projects/:id/file`, `files`） | `pages/` `assets/` 以外のフォルダが要るときは `validPath` に足す |
| 共同編集の部屋（`apps/api/src/room.ts`） | 1 ファイル = 1 部屋。形式ごとに `Codec`（ファイル ⇔ Y.Doc）を足す。今は Markdown（`markdownCodec`） |
| クライアント（`apps/web/src/collab.ts`） | `joinRoom(cfg, path)` で Y.Doc を受け取り、表・ボードなどは Y.Map / Y.Array を使う |

### 設定

| 場所 | 項目 |
|---|---|
| Google Cloud：OAuth クライアント | 承認済みのリダイレクト URI：`https://sabakan.hakuwentolia.workers.dev/api/auth/callback`（ローカルは `http://localhost:8787/api/auth/callback`） |
| Google Cloud：OAuth 同意画面 | スコープ `drive.file`。公開ステータスを「本番環境」にする（テスト中だと管理者の接続が 7 日で切れる） |
| Cloudflare：変数とシークレット | `GOOGLE_CLIENT_SECRET`（シークレット） |
| wrangler.jsonc | `GOOGLE_CLIENT_ID`（公開値）、D1 `sabakan`（初回デプロイで自動作成） |
