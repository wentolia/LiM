/*
 * D1 の表の定義（ここだけ。決定 0002）
 *
 * - D1 を変えるときは MIGRATIONS の末尾に番号を足すだけ。書いた番号の中身は直さない
 * - 古いコードと新しいコードが同時に動いても壊れる変更にしない（列は足すだけ。消す・改名するのは使わなくなってから別の番号で）
 * - IF NOT EXISTS は 1 番だけの例外（migration を入れる前からある本番 DB のため）。2 番以降では使わない
 * - ドライブのファイルの形を変える「移行」とは別物
 */

/* D1 の必要最小限の型（@cloudflare/workers-types を入れずに済ませる） */
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Database {
  prepare(sql: string): D1Stmt;
  /** 1 つのトランザクションとして流す。途中で失敗すれば全体が取り消される */
  batch<T = unknown>(stmts: D1Stmt[]): Promise<{ results: T[] }[]>;
}

export interface Migration { version: number; name: string; sql: string[] }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "初期の表",
    sql: [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS drive_tokens (user_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER)",
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, folder_id TEXT NOT NULL, created_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (project_id, email))",
    ],
  },
];

const LEDGER = "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)";

/** 当て済みの最大の番号（記録の表が無ければ作る。1 往復） */
async function applied(db: D1Database): Promise<number> {
  const [, max] = await db.batch<{ v: number | null }>([db.prepare(LEDGER), db.prepare("SELECT max(version) AS v FROM schema_migrations")]);
  return max?.results[0]?.v ?? 0;
}

/**
 * 未適用の番号を順に当てる。1 つの番号は「記録の行＋その SQL」を 1 つの batch（D1 では 1 トランザクション）で当てる。
 * 失敗したら済んだ番号を読み直し、別の実行環境が先に当てていれば続け、そうでなければ元の例外を投げる。
 * コードの知らない番号まで当たっている（古いコードに戻した）ときは何もしない。
 */
export async function migrate(db: D1Database, list: Migration[] = MIGRATIONS, now = () => new Date().toISOString()): Promise<void> {
  let done = await applied(db);
  for (const m of list) {
    if (m.version <= done) continue;
    try {
      await db.batch([
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").bind(m.version, m.name, now()),
        ...m.sql.map((s) => db.prepare(s)),
      ]);
      done = m.version;
    } catch (e) {
      done = await applied(db).catch(() => done);
      if (done < m.version) {
        console.error(`D1 の migration ${m.version}（${m.name}）に失敗しました`, e);
        throw e;
      }
    }
  }
}
