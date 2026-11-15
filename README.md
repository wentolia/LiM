# SABAKAN

> 旧称 LiM（Less is More）。

Cosense の書きやすさと Google ドキュメントの整える力を、**オープンな形式**（Markdown + frontmatter + `[[リンク]]`）の上で実現するノート / データベースアプリ。

## コンセプト：Less is More

コアは Page・Type・Command・Query・View の 5 要素（決定と理由は [docs/decisions/0001](docs/decisions/0001-設計思想とデータの決まり.md)、開発の決まりは [CLAUDE.md](CLAUDE.md)）。下は今ある 3 要素。Type（型の台帳）と Command（書き込みの関所）はこれから作る。

| 要素 | 定義 |
| --- | --- |
| **Page** | 1 Markdown ファイル。本文 + プロパティ（frontmatter）+ リンク |
| **Query** | Page 集合の絞り込み（今は `where` / `sort` / `group` / `view` の 4 語。集計は今後 Query に足す） |
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

## パッケージ（依存は上から下への一方向）

| パス | 役割 | 依存してよいもの |
| --- | --- | --- |
| `packages/core` | エンジン（純粋 TS）：Page の解析・書き出し、リンクグラフ、Query、Store I/F、DriveStore、3-way マージ、ページの Y.Doc の形と書き込み操作（`ydoc.ts`） | なし |
| `packages/client` | 画面を持たない接続部：Workspace（ページの箱・同期）、サーバー API、共同編集の部屋への接続、ルート、React フック | core |
| `packages/ui` | 見た目：デザイントークン（`tokens.css`）、部品の CSS、ヘッダー・タイル・一覧・ログイン、エディタ | core |
| `apps/web` | 画面の組み立て（ログイン → プロジェクト → ページ）。client と ui をつなぐだけ | core / client / ui |
| `apps/api` | サーバー（Cloudflare Worker）：ログイン、プロジェクト・メンバー（D1）、ドライブ、共同編集の部屋（Durable Object） | core |

見た目を変えるときは `packages/ui`（まず `tokens.css`）だけを触る。ui は client を知らないので、データの取り方を気にせず作り直せる。

## 開発

Node.js 22 以上。

```sh
npm install
npm run dev        # http://localhost:5173（/api は :8787 へ中継）
npx wrangler dev   # API（ローカル D1）。.dev.vars に GOOGLE_CLIENT_SECRET=... と DRIVE_TOKEN_KEY=... を書く
npm test           # core / web / api のテスト
npm run build      # 型チェック + 本番ビルド（apps/web/dist）
```

## プロジェクトと保存先

- **プロジェクト** = 管理者のマイドライブ/SABAKAN/<プロジェクト名>/ フォルダ（中に `pages/*.md`）
- メンバーは Google で本人確認だけ行う。読み書きはサーバーが管理者の代わりに行う（管理者の refresh token を D1 に保存。`DRIVE_TOKEN_KEY` を登録すると暗号化する。決定 0002）
- 招待はメールアドレスを登録するだけ。その Google アカウントでログインすると一覧に出る
- 役割：管理者（招待・外す）／メンバー（ページの読み書き）
- 管理者が最初にドライブを接続したとき、以前の SABAKAN/pages があれば「マイページ」プロジェクトとして取り込む
- スコープは `drive.file`（SABAKAN が作ったファイルだけ）。削除はドライブのゴミ箱へ
- 「このブラウザだけで使う」を選ぶと localStorage に保存（ログイン不要）。**廃止予定**（決定 0001 の I）
- 画像：貼り付け・ドロップで `assets/<日時>.<拡張子>` に保存し、ページには `![](../assets/…)` と書く（プロジェクトのみ）
- 他の人の変更：10 秒ごと／画面に戻ったときに取り込む。編集中でなければ開いているページにも反映
- リアルタイム共同編集（プロジェクト）：ページを開くと、そのファイルの「部屋」（Durable Object `PageRoom`）に WebSocket でつながる。Yjs で文字単位に合成し、相手のカーソルと名前を表示。部屋は 3 秒おき・最後の人が抜けたときにドライブへ書き出す
  - ドライブ側が別に書き換えられていたら、行単位の 3-way マージで合わせてから書き出す。改名・削除されたファイルの部屋は閉じる
- このブラウザだけのモードは従来どおり自分で保存（楽観ロック＋3-way マージ）

## 今後の機能を載せる土台

| 土台 | 使い方 |
|---|---|
| ログイン・プロジェクト・メンバー（`apps/api/src/app.ts`, D1） | 新しい機能も「プロジェクト内のファイル」を読み書きするだけで、権限はそのまま効く |
| ファイル API（`/api/projects/:id/file`, `files`） | 今の作成・改名・削除・画像の経路。Command ができたら画像以外は閉じる。フォルダを増やすのは構造の変更（CLAUDE.md） |
| 共同編集の部屋（`apps/api/src/room.ts`） | 1 ファイル = 1 部屋。今は Markdown（`markdownCodec`）だけ。新しい形式・`Codec` は構造の変更（CLAUDE.md） |
| クライアント（`packages/client/src/collab.ts`） | `joinRoom(cfg, path)` で Y.Doc を受け取る。表・ボードも Page と Query・View で表す（Y.Doc の型を足すのは構造の変更） |

### 設定

| 場所 | 項目 |
|---|---|
| Google Cloud：OAuth クライアント | 承認済みのリダイレクト URI：`https://sabakan.hakuwentolia.workers.dev/api/auth/callback`（ローカルは `http://localhost:8787/api/auth/callback`） |
| Google Cloud：OAuth 同意画面 | スコープ `drive.file`。公開ステータスを「本番環境」にする（テスト中だと管理者の接続が 7 日で切れる） |
| Cloudflare：変数とシークレット | `GOOGLE_CLIENT_SECRET`（シークレット）、`DRIVE_TOKEN_KEY`（シークレット。ドライブの鍵を暗号化する。作り方：ブラウザの開発者ツールで `btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))`。未登録の間は暗号化せずに動き、形が違えば 503 になる。なくしたら管理者がドライブを接続し直す。決定 0002） |
| wrangler.jsonc | `GOOGLE_CLIENT_ID`（公開値）、D1 `sabakan`（初回デプロイで自動作成） |
