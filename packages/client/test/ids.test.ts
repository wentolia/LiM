import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { isId, MemoryStore, parsePage } from "@lim/core";
import { Workspace } from "../src/workspace";
import { exportProject, importProject } from "../src/archive";

const enc = new TextEncoder();
const dec = new TextDecoder();
const LATER = Date.now() + 3600_000;
const read = async (store: MemoryStore, path: string) => parsePage(path, dec.decode(await store.read(path)));

async function setup(files: Record<string, string>) {
  const store = new MemoryStore();
  for (const [p, t] of Object.entries(files)) await store.write(p, enc.encode(t));
  const ws = new Workspace(store);
  await ws.load();
  return { store, ws };
}

describe("id の付与（0004）", () => {
  it("新しいページは id と created_at（+09:00）を持つ", async () => {
    const { store, ws } = await setup({});
    await ws.create("メモ");
    const page = await read(store, "pages/メモ.md");
    expect(isId(page.props.id)).toBe(true);
    expect(String(page.props.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/);
  });

  it("移行：無いページ・重複に付け、本文と他の項目は残す。2 回目は何もしない", async () => {
    const { store, ws } = await setup({
      "pages/A.md": "---\nid: 01JD3Z8Q5N0000000000000000\nrating: 4\n---\n本文A",
      "pages/B.md": "---\nid: 01JD3Z8Q5N0000000000000000\n---\n本文B",
      "pages/C.md": "本文C [[A]]",
      "pages/D.md": "---\n: [\n---\n読めない",
    });
    const r = await ws.assignIds(undefined, { now: LATER });
    expect(r).toEqual({ assigned: 2, recent: 0, failed: 0, skipped: ["pages/D.md"] });
    const a = await read(store, "pages/A.md");
    const b = await read(store, "pages/B.md");
    const c = await read(store, "pages/C.md");
    expect(a.props.id).toBe("01JD3Z8Q5N0000000000000000");
    expect(isId(b.props.id) && b.props.id !== a.props.id).toBe(true);
    expect(c.props).toEqual({ id: c.props.id });
    expect(c.body).toBe("本文C [[A]]");
    expect(dec.decode(await store.read("pages/D.md"))).toBe("---\n: [\n---\n読めない");
    expect(await ws.assignIds(undefined, { now: LATER })).toEqual({ assigned: 0, recent: 0, failed: 0, skipped: ["pages/D.md"] });
  });

  it("最近更新されたページと、誰かが今書いたページは飛ばす（あとで流し直せば付く）", async () => {
    const { store, ws } = await setup({ "pages/A.md": "a", "pages/B.md": "b" });
    expect((await ws.assignIds()).recent).toBe(2); // 今書いたばかり
    // 手元が古いまま、他の人（部屋）が B を書き出した
    const orig = store.write.bind(store);
    let once = true;
    store.write = async (path, data, type, opts) => {
      if (once && path === "pages/B.md") {
        once = false;
        await orig(path, enc.encode("b 編集中"));
      }
      return orig(path, data, type, opts);
    };
    const r = await ws.assignIds(undefined, { now: LATER });
    expect(r).toMatchObject({ assigned: 1, recent: 1 });
    expect(dec.decode(await store.read("pages/B.md"))).toContain("b 編集中");
  });
});

describe("まとめた書き出しと取り込み（0004）", () => {
  it("ドライブと同じ形の zip。ページだけも選べる", async () => {
    const { store } = await setup({ "pages/A.md": "a", "pages/日本語.md": "あ" });
    await store.write("assets/x.png", new Uint8Array([1, 2, 3]), "image/png");
    const all = await exportProject(store);
    const files = unzipSync(new Uint8Array(await all.zip.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["README.md", "assets/x.png", "pages/A.md", "pages/日本語.md"]);
    expect(dec.decode(files["pages/日本語.md"])).toBe("あ");
    expect([...files["assets/x.png"]]).toEqual([1, 2, 3]);
    expect(all).toMatchObject({ pages: 2, assets: 1, renamed: [] });
    const pagesOnly = await exportProject(store, { assets: false });
    expect(Object.keys(unzipSync(new Uint8Array(await pagesOnly.zip.arrayBuffer())))).not.toContain("assets/x.png");
  });

  it("書き出したものを空のプロジェクトへ取り込むと元に戻る", async () => {
    const src = await setup({ "pages/A.md": "---\nid: 01JD3Z8Q5N0000000000000000\n---\na", "pages/B.md": "b" });
    await src.store.write("assets/x.png", new Uint8Array([9]), "image/png");
    const zip = new Uint8Array(await (await exportProject(src.store)).zip.arrayBuffer());
    const dst = new MemoryStore();
    const r = await importProject(dst, zip, []);
    expect(r.written.sort()).toEqual(["assets/x.png", "pages/A.md", "pages/B.md"]);
    expect(r).toMatchObject({ existed: [], ignored: [], failed: [] });
    expect(dec.decode(await dst.read("pages/A.md"))).toBe("---\nid: 01JD3Z8Q5N0000000000000000\n---\na");
    // もう一度取り込んでも上書きしない
    expect((await importProject(dst, zip, [])).written).toEqual([]);
  });

  it("同じ題名（同一視）・同じ id のページは取り込まず、ファイル名は題名の決まりにそろえる", async () => {
    const { zipSync } = await import("fflate");
    const zip = zipSync({
      "家計/README.md": enc.encode("x"),
      "家計/pages/memo.md": enc.encode("小文字"),
      "家計/pages/古い名前.md": enc.encode("---\nid: 01JD3Z8Q5N0000000000000000\n---\n写し"),
      "家計/pages/a_b.md": enc.encode("1"),
      "家計/pages/a b.md": enc.encode("2"),
      "家計/pages/ｶﾞ:x.md": enc.encode("3"),
      "家計/other/x.txt": enc.encode("?"),
    });
    const dst = new MemoryStore();
    const existing = [
      { title: "Memo", props: {} },
      { title: "新しい名前", props: { id: "01JD3Z8Q5N0000000000000000" } },
    ];
    const r = await importProject(dst, zip, existing);
    expect(r.existed.sort()).toEqual(["pages/a b.md", "pages/memo.md", "pages/古い名前.md"].sort());
    expect(r.written.sort()).toEqual(["pages/a_b.md", "pages/ｶﾞ－x.md".normalize("NFC")].sort());
    expect(r.ignored).toEqual(["家計/other/x.txt"]);
  });
});
