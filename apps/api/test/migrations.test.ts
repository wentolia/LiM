import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { MIGRATIONS, migrate, type Migration } from "../src/migrations";
import { D1Repo, type D1Database } from "../src/repo";

// 本物の D1 のローカル実装（wrangler の getPlatformProxy）で、テストごとに空の DB を使う
const proxies: { dispose(): Promise<void> }[] = [];
async function freshD1(): Promise<D1Database> {
  const p = await getPlatformProxy<{ DB: D1Database }>({ configPath: new URL("./d1.jsonc", import.meta.url).pathname, persist: false });
  proxies.push(p);
  return p.env.DB;
}
afterEach(async () => { await Promise.all(proxies.splice(0).map((p) => p.dispose())); });

const tables = async (d: D1Database) =>
  (await d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
const versions = async (d: D1Database) =>
  (await d.prepare("SELECT version FROM schema_migrations ORDER BY version").all<{ version: number }>()).results.map((r) => r.version);
const columns = async (d: D1Database, table: string) =>
  (await d.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

// migration を入れる前の本番 DB の形（当時の repo.ts の SCHEMA。1 番を書き換えたら食い違いに気づけるよう、ここに固定する）
const BEFORE_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS drive_tokens (user_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, folder_id TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (project_id, email))",
];
const ADD_NOTE: Migration = { version: MIGRATIONS.length + 1, name: "列を足す", sql: ["ALTER TABLE users ADD COLUMN note TEXT"] };
const all = MIGRATIONS.map((m) => m.version);

describe("migrations の書き方", () => {
  it("番号は 1 から隙間なく増える", () => {
    expect(all).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });
  it("1 番は migration 前の本番 DB と同じ形", () => {
    expect(MIGRATIONS[0].sql).toEqual(BEFORE_MIGRATIONS);
  });
  it("2 番以降で IF NOT EXISTS を使わない", () => {
    expect(MIGRATIONS.slice(1).flatMap((m) => m.sql).filter((s) => /IF NOT EXISTS/i.test(s))).toEqual([]);
  });
});

describe("migrate（ローカルの D1）", { timeout: 20_000 }, () => {
  it("空の DB に全部当たる", async () => {
    const d = await freshD1();
    await migrate(d);
    expect(await tables(d)).toEqual(["drive_tokens", "members", "projects", "schema_migrations", "sessions", "users"]);
    expect(await versions(d)).toEqual(all);
  });

  it("migration 前からある本番 DB では、表と行をそのままにして記録だけ付く", async () => {
    const d = await freshD1();
    await d.batch(BEFORE_MIGRATIONS.map((s) => d.prepare(s)));
    await d.prepare("INSERT INTO drive_tokens (user_id, refresh_token) VALUES ('u1', 'rt')").run();
    await migrate(d);
    expect(await versions(d)).toEqual(all);
    expect((await d.prepare("SELECT user_id, refresh_token FROM drive_tokens").all()).results).toEqual([{ user_id: "u1", refresh_token: "rt" }]);
  });

  it("何度流しても同じ", async () => {
    const d = await freshD1();
    await migrate(d);
    await migrate(d);
    expect(await versions(d)).toEqual(all);
  });

  it("3 つの実行環境が同時に当てても、それぞれ 1 回だけ当たる", async () => {
    const d = await freshD1();
    const list = [...MIGRATIONS, ADD_NOTE];
    await Promise.all([migrate(d, list), migrate(d, list), migrate(d, list)]);
    expect(await versions(d)).toEqual(list.map((m) => m.version));
    expect(await columns(d, "users")).toContain("note");
  });

  it("SQL の誤りはログに出して投げ、同じ番号の表も記録も残さない", async () => {
    const d = await freshD1();
    const bad: Migration = { version: MIGRATIONS.length + 1, name: "誤り", sql: ["CREATE TABLE t (x TEXT)", "ALTER TABLE nope ADD COLUMN y TEXT"] };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(migrate(d, [...MIGRATIONS, bad])).rejects.toThrow();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    expect(await versions(d)).toEqual(all);
    expect(await tables(d)).not.toContain("t");
  });

  it("コードの知らない番号まで当たっていれば（古いコードに戻した）何もしない", async () => {
    const d = await freshD1();
    await migrate(d, [...MIGRATIONS, ADD_NOTE]);
    await migrate(d);
    expect(await versions(d)).toEqual([...all, ADD_NOTE.version]);
  });

  it("D1Repo は DB ごとに、最初の読み書きの前に当てる", async () => {
    for (const d of [await freshD1(), await freshD1()]) {
      const repo = new D1Repo(d);
      await repo.upsertUser({ id: "u1", email: "a@example.com", name: "A" });
      expect(await repo.getUser("u1")).toEqual({ id: "u1", email: "a@example.com", name: "A" });
      expect(await versions(d)).toEqual(all);
    }
  });
});
