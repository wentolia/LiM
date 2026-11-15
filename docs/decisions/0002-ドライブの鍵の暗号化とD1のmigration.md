# 0002 ドライブの鍵の暗号化と D1 の migration

- 日付：2026-11-15
- 状態：決定（2026-11-15 ユーザー了承。鍵が未登録のときは移行期間だけ平文で動かす案を選択）
- 関係：[0001](0001-設計思想とデータの決まり.md)（D1 は運営データと索引だけ）、CLAUDE.md「データの決まり」の「予定：D1 の変更は番号付きの migration にする」

## 決めること

1. **ドライブの鍵を暗号化して D1 に置く。** `drive_tokens` の `refresh_token` と `access_token` を、Worker のシークレット `DRIVE_TOKEN_KEY` を鍵にした AES-GCM で暗号化する
2. **D1 の定義を番号付きの migration 1 か所にまとめる。** `apps/api/src/migrations.ts` に番号順の SQL を並べ、Worker が起動時に未適用の分だけ当てる。`apps/api/schema.sql` と `repo.ts` の `SCHEMA` は消す

どちらも「構造の変更」（D1 の表の扱い、権限や認証の仕組み）に当たる。

## 今の問題

| # | 問題 | 場所 |
| --- | --- | --- |
| 1 | 管理者の Google の `refresh_token` が平文で D1 にある。D1 を読める人（ダッシュボードの D1 コンソール、`wrangler d1 export` の書き出し、誤って出したログ）には、期限の無い管理者のドライブ（`drive.file` の範囲）の鍵がそのまま渡る | `apps/api/src/repo.ts` の `putDriveToken` / `getDriveToken` |
| 2 | 表の定義が 2 か所にあり、手で揃えている | `apps/api/schema.sql`、`apps/api/src/repo.ts` の `SCHEMA` |
| 3 | `CREATE TABLE IF NOT EXISTS` しかないので、列の追加・変更が書けない。次に来る索引（決定 A）や、`sessions` への列の追加（API トークンとの兼用を検討中）で列の変更が要る | 同上 |

## シンプルさと読みやすさ

- 利用者のデータ（ドライブの `pages/*.md`、フォルダ構成）は一切変えない。ここで扱うのは D1 の運営データだけ
- D1 の表の定義は `migrations.ts` の 1 ファイルに、素の SQL として番号順に並ぶ。人も AI もこの 1 ファイルを上から読めば今の表がわかる
- 新しく増えるのは、ファイル 2 つ（`migrations.ts`、`tokenCipher.ts`）、表 1 つ（`schema_migrations`）、シークレット 1 つ。フォルダは増やさない
- 暗号化した鍵は、わざと読めないようにする唯一の値。読めなくても困らない（なくしたら接続し直すだけ）

## 1. ドライブの鍵の暗号化

### 形

| 項目 | 決め |
| --- | --- |
| 方式 | AES-GCM（256 ビット）。Workers の WebCrypto（`crypto.subtle`）だけを使い、ライブラリは足さない |
| 鍵 | Worker のシークレット `DRIVE_TOKEN_KEY`（32 バイトの乱数を base64 にしたもの）。前後の空白を除いて復号し、ちょうど 32 バイトでなければ「鍵が無い」と同じ扱い。`extractable: false` で取り込み、isolate ごとに 1 回だけ `importKey` する |
| IV | 暗号化のたびに `crypto.getRandomValues` で 12 バイトを新しく作る。列ごとに別、使い回さない |
| 保存の形 | `v1.<IV の base64url>.<暗号文と認証タグの base64url>`。列の型は TEXT のままで、表の変更はない |
| 付加データ（AAD） | `drive_tokens:<user_id>:<列名>`。別の人の行や別の列へ暗号文を移し替えても復号できない |
| 対象 | `refresh_token` と `access_token`。`expires_at` は秘密ではないので平文のまま |
| 置き場 | `apps/api/src/tokenCipher.ts`（サーバー層）。`D1Repo` が書くときに暗号化、読むときに復号する。鍵は `D1Repo` のコンストラクタの引数にし、`index.ts` と `roomObject.ts` の両方で渡す（型で渡し忘れを防ぐ）。`Repo` の I/F・`DriveToken` の形・`MemoryRepo` は変えない |

### 読めないとき・鍵が無いとき

| 場面 | 動き |
| --- | --- |
| `refresh_token` を復号できない（鍵の取り違え・改ざん） | `getDriveToken` は `null`（未接続と同じ）を返す。行は消さず、ログには `user_id` と列名だけ出す（値は出さない）。`/api/me` は `driveConnected: false` になり、管理者は今の「ドライブを接続」から接続し直せる。他の人と部屋は今の 409「管理者のドライブが接続されていません」 |
| `access_token` だけ復号できない | `null` とみなし、`refresh_token` で更新する |
| `DRIVE_TOKEN_KEY` が無い（移行期間：PR 2〜PR 3 の間） | 今までどおり平文で読み書きし、警告をログに出す。順番を間違えても家族が止まらないようにするため |
| `DRIVE_TOKEN_KEY` が無い（PR 3 のあと） | `GOOGLE_CLIENT_SECRET` と同じく 503「サーバーの設定（DRIVE_TOKEN_KEY）がまだです」 |

### 既存の平文の行の移し方（管理者の接続を切らない）

SQL だけでは暗号化できないので、migration ではなくコードで移す。

1. 読んだ値が `v1.` で始まらなければ平文とみなす（Google の `refresh_token` は `1//`、`access_token` は `ya29.` で始まるので取り違えない）
2. 平文を読んだら、`refresh_token` を暗号化して書き戻し、`access_token` と `expires_at` は `NULL` にする（次の利用で 1 回更新が走るだけ）。書き戻しは `WHERE user_id = ? AND refresh_token = <読んだ平文>` の条件付きにし、同時の更新を上書きしない
3. 何度走っても結果は同じ（暗号化済みの行には何もしない）
4. 対象はドライブを接続した人の行だけ（本番では 1〜数行）。その人のプロジェクトが次に使われたときに移る
5. 確かめ方：D1 コンソールで
   `SELECT user_id FROM drive_tokens WHERE refresh_token NOT LIKE 'v1.%' OR (access_token IS NOT NULL AND access_token NOT LIKE 'v1.%')`
   が 0 行になればよい。残った `user_id` があれば、その人に一度画面を開いてもらう。0 行を確かめてから PR 3（平文の分岐を消し、鍵を必須にする）を出す

### 守れるもの・守れないもの

- 守れる：今後 D1 の中身だけが見られた場合（コンソール、書き出したファイル、バックアップ、ログ）。シークレットはダッシュボードで書き込み専用なので、D1 と同じ画面から鍵は読めない
- 守れない：
  - Worker のコードやシークレットを書き換えられる人（Cloudflare アカウントそのものを取られた場合）。その場合は Google 側で SABAKAN のアクセス権を取り消す
  - これまでの平文：D1 の Time Travel（過去 30 日の復元）や過去の書き出しに残っている。気になる場合は、移行のあとで Google アカウント →「セキュリティ」→「サードパーティのアクセス」で SABAKAN を一度取り消し、ドライブを接続し直す（新しい鍵は最初から暗号文で入る）。任意
  - `sessions.id` は平文のまま。D1 を読めた人はログイン中の人として振る舞える。ただしセッションは 30 日で切れ、`refresh_token` のような期限の無い鍵より被害が小さい。ハッシュ化は、`sessions` を API トークンと兼ねる見直し（別の記録）と一緒に扱う

### 鍵の扱い

- 鍵はユーザーがパスワード管理などに控える。なくしても、データの正本はドライブにあるので失うものはなく、管理者がドライブを接続し直せば戻る
- 鍵の入れ替え（ローテーション）は今は作らない。形に `v1` を入れておき、必要になったら作る

### デプロイとロールバック

- 暗号化のあとで PR 2 より前の版へ戻すと、古いコードは暗号文を読めず、管理者のドライブ接続が切れる（管理者が接続し直せば直る）。PR 2 のあとは、ダッシュボードのロールバックではなく修正を出して前に進める
- デプロイ直後の数秒は新旧のコードが混ざり、一時的に失敗することがある。古いコードが平文で上書きしても新しいコードが拾い直すので、データは壊れない（PR 3 までは平文の分岐を残す理由でもある）

## 2. D1 の migration

### 形

```ts
// apps/api/src/migrations.ts（D1 の表の定義はここだけ）
export const MIGRATIONS: { version: number; name: string; sql: string[] }[] = [
  { version: 1, name: "初期の表", sql: [/* 今の 5 表 */] },
  // 2 以降は末尾に足すだけ。書いた番号の中身は直さない
];
```

| 項目 | 決め |
| --- | --- |
| 記録の表 | `schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`。wrangler 標準の `d1_migrations` とは別名で、衝突しない |
| 当てる時 | 今の `init()` と同じく、isolate ごとに最初の D1 アクセスの前に 1 回。`db.batch([CREATE TABLE IF NOT EXISTS schema_migrations ..., SELECT max(version) FROM schema_migrations])` の 1 往復で済んだ番号を見て、残りを番号順に当てる |
| 1 つの番号の当て方 | `db.batch([INSERT INTO schema_migrations ..., ...その番号の SQL])`。D1 の batch は 1 つのトランザクション（Cloudflare の文書による）なので、途中で失敗すれば全体が取り消される |
| 失敗したとき | `max(version)` を読み直す。その番号以上なら別の isolate が先に当てたとみなして続ける。未満なら元の例外を投げる（SQL の誤り）。読み直しは 1 回まで |
| 古いコードに戻したとき | `max(version)` がコードの知る最大より大きければ、何もせず通す |
| 今の本番 DB | 1 番だけは今の 5 表を `IF NOT EXISTS` で書く（例外）。表はそのまま、`schema_migrations` に 1 番が記録されるだけ。2 番以降では `IF NOT EXISTS` を使わない（当たっていないのに記録だけ進む事故を隠すため） |
| ローカル | `wrangler dev` でも同じコードが当てるので、手で流す SQL は要らない |
| テスト | 空の DB・今の本番と同じ DB・2 つ同時に当てる・SQL の誤り・古いコードの場合。土台（Node の `node:sqlite` を D1 の形に包むか、wrangler の `getPlatformProxy()` のローカル D1 か）は実装時に動く方を選ぶ |
| `schema.sql` | 消す |

### 書き方の決まり（PR 1 で CLAUDE.md に足す）

- D1 の変更は `MIGRATIONS` の末尾に番号を足すだけ。書いた番号の中身は変えない
- 古いコードと新しいコードが同時に動いても壊れない変更にする（列は足すだけ。消す・改名するときは、使わなくなったコードを先に出してから別の番号で消す）
- migration の誤りは全員の全リクエストを止める。Workers Builds はテストを流さないので、`npm test` が通ってからマージする
- ここで当てる SQL は D1 だけに効く。ドライブのファイルの形を変える「移行」（CLAUDE.md「構造の変更」）とは別物

## 無料枠

| 項目 | 今 | 変更後 |
| --- | --- | --- |
| isolate の起動ごとの D1 | `CREATE TABLE IF NOT EXISTS` を 5 本（1 往復） | 2 文を 1 往復（未適用があるときだけ追加） |
| 管理者の鍵を読むたびの CPU | なし | AES-GCM の復号 1〜2 回（200 バイト程度。1ms を大きく下回る） |
| D1 の書き込み | なし | 平文の行の書き戻しが 1 行に 1 回だけ |

常時動く処理・外部の呼び出し・新しい保存先は増えない。

## ユーザーにしてもらうこと

1. 鍵を作る：ブラウザの開発者ツールのコンソールで
   `btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))`
   （Mac・Linux なら `openssl rand -base64 32` でもよい。末尾の改行は貼り込まない）
2. Cloudflare ダッシュボード → Workers & Pages → `sabakan` → 設定 → 変数とシークレット → 追加。種類「シークレット」、名前 `DRIVE_TOKEN_KEY`、値は 1 の文字列。保存すると今の版が出し直され、開いている部屋の接続が一度切れる（すぐつながり直す）
3. 同じ値をパスワード管理などに控える
4. 暗号化の PR（PR 2）をマージする（1〜3 と前後しても止まらないが、鍵を入れるまでは平文のまま）
5. 管理者で一度画面を開き、上の確認の SQL が 0 行になったのを確かめて、知らせる → PR 3 を出す

migration の PR（PR 1）は、ユーザーの作業なしでマージできる。

## PR の分け方

| 順 | PR | 中身 |
| --- | --- | --- |
| 1 | この記録と migration | 0002、`migrations.ts`、`D1Repo.init()` の置き換え、`schema.sql` の削除、CLAUDE.md の該当箇所、テスト |
| 2 | 鍵の暗号化 | `tokenCipher.ts`、`D1Repo` の読み書き、平文の書き戻し、`index.ts`・`roomObject.ts` で鍵を渡す、`Env` に `DRIVE_TOKEN_KEY`、README（設定表、48 行の `.dev.vars`、56 行の「refresh token を D1 に保存」）、テスト（別の鍵で書いた行があっても `/api/me` と接続し直しが通る、を含む） |
| 3 | 仕上げ | 平文の分岐を消し、鍵を必須（無ければ 503）にする。本番で平文の行が 0 になってから |

## 他の案と、難しくなること

### 暗号化

| 案 | 採らない理由 |
| --- | --- |
| 暗号化しない | D1 だけの漏れで管理者のドライブの鍵が渡る。表を足していくほど D1 を見る機会が増える |
| `access_token` は D1 に置かず isolate のメモリだけに持つ | 平文の行が 1 つ減るが、isolate や部屋が起きるたびに Google へ更新を問い合わせる。有効期限 1 時間の値なので、暗号化して置く方が安い |
| Cloudflare の Secrets Store や外部の鍵管理サービス | 無料枠や対応状況の確認が要り、仕組みが増える。シークレット 1 つで足りる |
| 鍵を `GOOGLE_CLIENT_SECRET` から導く | 設定は増えないが、Google 側でクライアントシークレットを作り直すと鍵が変わり、全員のドライブ接続が切れる。用途の違う秘密は分ける |
| 鍵が無ければ最初から 503（移行期間を作らない） | 平文で動く期間が無いが、マージと鍵の登録の順を間違えると家族全員が止まる。手作業の順番に頼らない方を選んだ |

難しくなること：鍵をなくすと管理者のドライブ接続をやり直す必要がある。ローカル開発でも `.dev.vars` に鍵が要る（PR 3 まではなくても動く）。D1 コンソールから鍵の中身を見て調べることはできなくなる。PR 2 のあとはロールバックで接続が切れる。

### migration

| 案 | 採らない理由 |
| --- | --- |
| wrangler の D1 migrations（`migrations/0001_xxx.sql` と `wrangler d1 migrations apply`） | Cloudflare の標準で、SQL が 1 番号 1 ファイルになり読みやすい。ただしデプロイの前に別のコマンドを流す必要があり、Workers Builds のデプロイコマンドの変更とビルド用トークンの D1 権限をダッシュボードで設定してもらうことになる。ブランチのビルドが本番 DB に当たらないよう分ける必要もあり、ローカルでも毎回手で流す。表が数個のうちは、Worker が自分で当てる方が設定が少ない |
| 今の `IF NOT EXISTS` を続ける | 列の追加が書けず、索引や `sessions` の列の追加で行き詰まる |

難しくなること：Worker が起動時に DDL を流すので、重い移行（大きな表の作り直し）は D1 の 1 文の実行時間と最初のリクエストの待ち時間に響く。その必要が出たら、wrangler の migrations へ切り替える記録を書く（そのときは `schema_migrations` から `d1_migrations` への橋渡しが要る）。migration の失敗はその isolate の全リクエストのエラーとして出る。

## 決めないこと

- セッション ID（`sessions.id`）のハッシュ化と、`sessions` に API トークンを兼ねさせるための列：データ構造の見直しの記録で扱う（この記録の migration の 2 番以降として足す）
- 索引の表の中身：その記録で決める。操作の記録（決定 K）の表は、作るかどうかも含めて別に決める
