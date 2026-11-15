import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, type Migration } from "../src/migrations";
import { D1Repo, type D1Database } from "../src/repo";

// node:sqlite を D1 の形に包む（batch は 1 トランザクション。D1 の batch と同じ性質を前提にする）
// （@types/node を入れずに済ませるため、必要な形だけ書く）
interface SqliteStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
interface Sqlite { prepare(sql: string): SqliteStmt; exec(sql: string): void }
const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } })
  .process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => Sqlite };

function sqliteD1(db: Sqlite = new DatabaseSync(":memory:")): D1Database & { raw: Sqlite } {
  const tick = () => new Promise((r) => setTimeout(r, 0)); // 別の実行環境と入り混じるように、毎回いったん譲る
  const stmt = (sql: string, args: unknown[] = []): any => ({
    sql, args,
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => { await tick(); return (db.prepare(sql).get(...args) ?? null); },
    all: async () => { await tick(); return { results: db.prepare(sql).all(...args) }; },
    run: async () => { await tick(); db.prepare(sql).run(...args); },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts: any[]) => {
      await tick();
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const p = db.prepare(s.sql);
          return { results: /^\s*select/i.test(s.sql) ? p.all(...s.args) : (p.run(...s.args), []) };
        });
        db.exec("COMMIT");
        return out as never;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const tables = (d: ReturnType<typeof sqliteD1>) =>
  (d.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const versions = (d: ReturnType<typeof sqliteD1>) =>
  (d.raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);

describe("migrations", () => {
  it("番号は 1 から隙間なく増える", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("空の DB に全部当たる", async () => {
    const d = sqliteD1();
    await migrate(d);
    expect(tables(d)).toEqual(["drive_tokens", "members", "projects", "schema_migrations", "sessions", "users"]);
    expect(versions(d)).toEqual([1]);
  });

  it("migration 前からある本番 DB では、表と行をそのままにして 1 番を記録する", async () => {
    const d = sqliteD1();
    for (const s of MIGRATIONS[0].sql) d.raw.exec(s);
    d.raw.exec("INSERT INTO drive_tokens (user_id, refresh_token) VALUES ('u1', 'rt')");
    await migrate(d);
    expect(versions(d)).toEqual([1]);
    expect(d.raw.prepare("SELECT refresh_token FROM drive_tokens").get()).toEqual({ refresh_token: "rt" });
  });

  it("何度流しても同じ", async () => {
    const d = sqliteD1();
    await migrate(d);
    await migrate(d);
    expect(versions(d)).toEqual([1]);
  });

  it("2 つの実行環境が同時に当てても、それぞれ 1 回だけ当たる", async () => {
    const d = sqliteD1();
    const list: Migration[] = [...MIGRATIONS, { version: 2, name: "列を足す", sql: ["ALTER TABLE users ADD COLUMN note TEXT"] }];
    await Promise.all([migrate(d, list), migrate(d, list), migrate(d, list)]);
    expect(versions(d)).toEqual([1, 2]);
  });

  it("SQL の誤りは投げ、記録も表も残さない", async () => {
    const d = sqliteD1();
    const list: Migration[] = [...MIGRATIONS, { version: 2, name: "誤り", sql: ["CREATE TABLE t (x TEXT)", "ALTER TABLE nope ADD COLUMN y TEXT"] }];
    await expect(migrate(d, list)).rejects.toThrow();
    expect(versions(d)).toEqual([1]);
    expect(tables(d)).not.toContain("t");
  });

  it("コードの知らない番号まで当たっていれば（古いコードに戻した）何もしない", async () => {
    const d = sqliteD1();
    await migrate(d, [...MIGRATIONS, { version: 2, name: "新しい", sql: ["ALTER TABLE users ADD COLUMN note TEXT"] }]);
    await migrate(d);
    expect(versions(d)).toEqual([1, 2]);
  });

  it("D1Repo は最初の読み書きの前に当てる", async () => {
    const d = sqliteD1();
    const repo = new D1Repo(d);
    await repo.upsertUser({ id: "u1", email: "a@example.com", name: "A" });
    expect(await repo.getUser("u1")).toEqual({ id: "u1", email: "a@example.com", name: "A" });
    expect(versions(d)).toEqual([1]);
  });
});
