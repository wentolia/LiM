import { describe, expect, it } from "vitest";
import { LinkGraph, MemoryStore, extractQueries, parsePage, parseQuery, runQuery } from "../src/index.js";

const book = (title: string, props: string, body = "") =>
  parsePage(`pages/${title}.md`, `---\n${props}\n---\n# ${title}\n${body}`);

describe("parsePage", () => {
  it("frontmatter・リンク・タグを抽出し、コード内は無視する", () => {
    const p = parsePage(
      "pages/読書メモ.md",
      [
        "---",
        "type: book",
        'author: "[[山田太郎]]"',
        "tags: [設計]",
        "---",
        "# 読書メモ",
        "[[ローカルファースト]] が参考になる #ツール",
        "`[[コード内]]` は無視",
        "```",
        "[[ブロック内]] #無視",
        "```",
      ].join("\n"),
    );
    expect(p.title).toBe("読書メモ");
    expect(p.props.type).toBe("book");
    expect(p.links).toEqual(["山田太郎", "ローカルファースト", "設計", "ツール"]);
    expect(p.tags).toEqual(["設計", "ツール"]);
  });

  it("見出しの # はタグにしない", () => {
    expect(parsePage("a.md", "# 見出し\n## 小見出し").tags).toEqual([]);
  });
});

describe("LinkGraph", () => {
  const g = new LinkGraph([
    parsePage("pages/A.md", "[[共通]] [[B]]"),
    parsePage("pages/B.md", "text"),
    parsePage("pages/C.md", "[[共通]]"),
    parsePage("pages/D.md", "[[a]]"),
  ]);

  it("バックリンク（大文字小文字・空白を同一視）", () => {
    expect(g.linksTo("A").map((p) => p.title)).toEqual(["D"]);
    expect(g.exists("共通")).toBe(false);
  });

  it("2hop リンクで関連ページを返す", () => {
    const hop = g.twoHop("A");
    expect([...hop.keys()]).toEqual(["共通"]);
    expect(hop.get("共通")!.map((p) => p.title)).toEqual(["C"]);
  });

  it("更新でリンクが差し替わる", () => {
    g.upsert(parsePage("pages/D.md", "none"));
    expect(g.linksTo("A")).toEqual([]);
  });
});

describe("query", () => {
  const graph = new LinkGraph([
    book("本1", "type: book\nrating: 4\nstatus: 読了\nauthor: '[[山田]]'"),
    book("本2", "type: book\nrating: 5\nstatus: 未読"),
    book("本3", "type: book\nstatus: 読了"),
    book("日記", "type: journal", "[[本1]] を読んだ"),
  ]);

  it("Notion 的 DB：type で絞り rating 降順（値なしは末尾）", () => {
    const [q] = extractQueries("# 本\n```query\nwhere: type = book\nsort: rating desc\nview: table\n```\n");
    const r = runQuery(q, { graph });
    expect(q.view).toBe("table");
    expect(r.pages.map((p) => p.title)).toEqual(["本2", "本1", "本3"]);
  });

  it("ボード：group でまとめる", () => {
    const r = runQuery(parseQuery("where: type = book\ngroup: status\nview: board"), { graph });
    expect([...r.groups!.keys()]).toEqual(["読了", "未読"]);
  });

  it("バックリンク = links_to: this", () => {
    const current = graph.get("本1")!;
    const r = runQuery(parseQuery("where: links_to: this"), { graph, current });
    expect(r.pages.map((p) => p.title)).toEqual(["日記"]);
  });

  it("リレーション（プロパティのリンク）と複数条件・比較", () => {
    const r = runQuery(parseQuery("where:\n  - author = 山田\n  - rating >= 4"), { graph });
    expect(r.pages.map((p) => p.title)).toEqual(["本1"]);
  });

  it("全文検索", () => {
    const r = runQuery(parseQuery('where: text: "読んだ"'), { graph });
    expect(r.pages.map((p) => p.title)).toEqual(["日記"]);
  });
});

describe("MemoryStore", () => {
  it("changes で差分を返す", async () => {
    const s = new MemoryStore();
    const enc = new TextEncoder();
    await s.write("pages/a.md", enc.encode("a"));
    const first = await s.changes();
    expect(first.changed.map((e) => e.path)).toEqual(["pages/a.md"]);
    await s.remove("pages/a.md");
    const next = await s.changes(first.cursor);
    expect(next.removed).toEqual(["pages/a.md"]);
  });
});
