import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownCodec, pageBody, pageProps, setProp, Origin } from "../src/ydoc";

describe("ページの Y.Doc", () => {
  it("読み込みと書き出し（プロパティは Y.Map、本文は Y.Text）", () => {
    const doc = new Y.Doc();
    markdownCodec.load(doc, "---\n担当: A\n評価: 4\n---\n本文");
    expect(pageProps(doc).toJSON()).toEqual({ 担当: "A", 評価: 4 });
    expect(pageBody(doc).toString()).toBe("本文");
    expect(markdownCodec.save(doc)).toBe("---\n担当: A\n評価: 4\n---\n本文");
  });

  it("プロパティの書き込みと本文の打鍵が同時でも両方残る", () => {
    const a = new Y.Doc();
    markdownCodec.load(a, "---\n期限: 2026-11-20\n---\nメモ");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setProp(b, "期限", "2026-11-22", Origin.gcal); // カレンダー同期
    pageBody(a).insert(2, "（追記）"); // 人の打鍵
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(markdownCodec.save(a)).toBe("---\n期限: 2026-11-22\n---\nメモ（追記）");
    expect(markdownCodec.save(b)).toBe(markdownCodec.save(a));
  });

  it("書き手を origin で見分けられる", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    setProp(doc, "状態", "完了", Origin.ai);
    expect(origins).toEqual(["ai"]);
  });

  it("外での変更はキー単位・行単位で取り込む", () => {
    const doc = new Y.Doc();
    const base = "---\nA: 1\nB: 1\n---\n1\n2";
    markdownCodec.load(doc, base);
    setProp(doc, "A", 2);
    pageBody(doc).insert(pageBody(doc).length, "（自分）");
    markdownCodec.rebase(doc, base, "---\nA: 1\nB: 9\n---\n1（外）\n2");
    expect(markdownCodec.save(doc)).toBe("---\nA: 2\nB: 9\n---\n1（外）\n2（自分）");
  });
});
