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

  it("改名は保存先の「名前の変更」を使い、props の [[旧名]] も書き換える", async () => {
    const { store, ws } = await setup();
    await store.write("pages/C.md", enc.encode('---\n参考: "[[KJ法]]"\n---\n本文'));
    await ws.load();
    const before = (await store.list("pages/")).find((e) => e.path === "pages/KJ法.md")!.revision;
    await ws.rename("KJ法", "KJ法2");
    // 中身はそのまま、版は続き番号（新規作成ではない）
    expect(dec.decode(await store.read("pages/KJ法2.md"))).toBe("カード");
    expect(Number((await store.list("pages/")).find((e) => e.path === "pages/KJ法2.md")!.revision)).toBe(Number(before) + 1);
    expect(dec.decode(await store.read("pages/C.md"))).toContain('参考: "[[KJ法2]]"');
  });

  it("改名の時点で保存先にまだ無い手元の変更（共同編集の書き出し前）も、新しいファイルに書く", async () => {
    const { store, ws } = await setup();
    ws.applyLocal("KJ法", "カード＋追記");
    await ws.rename("KJ法", "KJ法2");
    expect(dec.decode(await store.read("pages/KJ法2.md"))).toBe("カード＋追記");
  });

  it("題名の決まりより前に作られたファイル名（NFD など）でも、保存は元のファイルに書く", async () => {
    const store = new MemoryStore();
    const nfd = "が".normalize("NFD");
    await store.write(`pages/${nfd}.md`, enc.encode("古い"));
    const ws = new Workspace(store);
    await ws.load();
    await ws.saveBody(nfd, "新しい");
    expect((await store.list("pages/")).map((e) => e.path)).toEqual([`pages/${nfd}.md`]);
    expect(dec.decode(await store.read(`pages/${nfd}.md`))).toBe("新しい");
  });

  it("題名は NFC にそろえ、ファイル名に使えない形を直し、80 文字までにする", () => {
    expect(sanitizeTitle("か\u3099")).toBe("が");
    expect(sanitizeTitle("..隠し. ")).toBe("隠し");
    expect([...sanitizeTitle("あ".repeat(100))].length).toBe(80);
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

describe("複数人での編集", () => {
  it("同じページを同時に編集しても、両方の変更が残る", async () => {
    const store = new MemoryStore();
    const a = new Workspace(store);
    await a.create("議事録");
    await a.saveBody("議事録", "議題\n1. 予算\n2. 日程\nメモ");
    const b = new Workspace(store);
    await b.load();
    await b.load();
    // A と B が同じ版から別々の行を書き換える
    await a.saveBody("議事録", "議題\n1. 予算（確定）\n2. 日程\nメモ");
    const merged = await b.saveBody("議事録", "議題\n1. 予算\n2. 日程（来週）\nメモ");
    expect(merged).toBe("議題\n1. 予算（確定）\n2. 日程（来週）\nメモ");
    await a.refresh();
    expect(a.get("議事録")?.body).toBe(merged);
  });

  it("refresh で他の人の追加・削除を取り込む", async () => {
    const store = new MemoryStore();
    const a = new Workspace(store);
    await a.create("一");
    const b = new Workspace(store);
    await b.load();
    await b.create("二");
    expect(await a.refresh()).toEqual(["二"]);
    expect(a.exists("二")).toBe(true);
    await b.rename("一", "いち");
    await a.refresh();
    expect(a.exists("一")).toBe(false);
    expect(a.exists("いち")).toBe(true);
  });

  it("新しいページ名が他の人とぶつかっても消えない", async () => {
    const store = new MemoryStore();
    const a = new Workspace(store);
    const b = new Workspace(store);
    await a.load();
    await b.load();
    await a.saveBody("メモ", "A の内容");
    const merged = await b.saveBody("メモ", "B の内容");
    expect(merged).toContain("A の内容");
    expect(merged).toContain("B の内容");
  });
});

describe("まとめ読み", () => {
  it("loadPages がある保存先は 1 回で読み込む", async () => {
    const store = new MemoryStore();
    let reads = 0;
    const bulk = Object.assign(store, {
      loadPages: async () => [{ path: "pages/A.md", revision: "1", updatedAt: "2026-11-15T00:00:00Z", size: 1, text: "[[B]]" }],
      read: async () => { reads++; return new Uint8Array(); },
    });
    const ws = new Workspace(bulk);
    await ws.load();
    expect(ws.get("A")?.links).toEqual(["B"]);
    expect(reads).toBe(0);
  });
});
