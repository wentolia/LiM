import { describe, expect, it } from "vitest";
import { MemoryStore } from "@lim/core";
import { Workspace, sanitizeTitle } from "../src/workspace";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function setup() {
  const store = new MemoryStore();
  await store.write("pages/A.md", enc.encode("---\n評価: 4\n---\n[[KJ法]] と [[B]]"));
  await store.write("pages/B.md", enc.encode("[[KJ法]] をつかう"));
  await store.write("pages/KJ法.md", enc.encode("カード"));
  const ws = new Workspace(store);
  await ws.load();
  return { store, ws };
}

describe("Workspace", () => {
  it("本文を保存してもプロパティは保持される", async () => {
    const { store, ws } = await setup();
    await ws.saveBody("A", "書き換えた [[KJ法]]");
    const text = dec.decode(await store.read("pages/A.md"));
    expect(text).toContain("評価: 4");
    expect(text).toContain("書き換えた [[KJ法]]");
  });

  it("新規ページは名前が重複しない", async () => {
    const { ws } = await setup();
    expect(await ws.create()).toBe("無題");
    expect(await ws.create()).toBe("無題 2");
    expect(await ws.create("B")).toBe("B 2");
  });

  it("改名すると参照元のリンクも書き換わる", async () => {
    const { store, ws } = await setup();
    await ws.rename("KJ法", "KJ法（川喜田）");
    expect(ws.exists("KJ法")).toBe(false);
    expect(ws.get("A")!.body).toBe("[[KJ法（川喜田）]] と [[B]]");
    expect(dec.decode(await store.read("pages/B.md"))).toBe("[[KJ法（川喜田）]] をつかう");
    await expect(ws.rename("A", "B")).rejects.toThrow("すでにあります");
  });

  it("関連ページ：同じリンク先を持つページをリンク名ごとに返す", async () => {
    const { ws } = await setup();
    const rel = ws.related("A");
    expect(rel.map((g) => [g.via, g.pages.map((p) => p.title)])).toEqual([["KJ法", ["B"]]]);
  });

  it("ファイル名に使えない文字を置き換える", () => {
    expect(sanitizeTitle(" a/b:c ")).toBe("a－b－c");
  });
});
