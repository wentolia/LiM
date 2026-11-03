# LiM

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
| `apps/web` | Web アプリ（Vite + React + CodeMirror 6）。一覧（ギャラリー／表）とページ編集 |

## 開発

Node.js 22 以上。

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # core と web のテスト
npm run build      # 型チェック + 本番ビルド（apps/web/dist）
```

現在の保存先はブラウザの localStorage（初回はサンプルページ入り）。Google ドライブ連携は `Store` I/F の実装を追加して差し替える予定。
