import * as Y from "yjs";
import { merge3 } from "./merge.js";
import { parsePage, serializePage } from "./page.js";

/*
 * ページを共同編集するときの Y.Doc の形と、書き込み操作。
 * 画面（エディタ）・サーバー（部屋）・今後の外部連携（カレンダー同期、AI など）はすべてここを通して書く。
 *
 *   props: Y.Map   … frontmatter のプロパティ。キー単位で書くので、本文の打鍵と衝突しない
 *   body:  Y.Text  … 本文（Markdown）
 */

export const PAGE_PROPS = "props";
export const PAGE_BODY = "body";

/** 書き手。Y のトランザクションの origin に入れる（その場の判別用。履歴には残らない） */
export const Origin = {
  user: "user",
  drive: "drive",
  load: "load",
  ai: "ai",
  gcal: "gcal",
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

export const pageProps = (doc: Y.Doc) => doc.getMap<unknown>(PAGE_PROPS);
export const pageBody = (doc: Y.Doc) => doc.getText(PAGE_BODY);

/** Y.Text を next にする最小の置き換え（前後の共通部分は触らない） */
export function applyText(ytext: Y.Text, next: string, origin: Origin = Origin.drive): void {
  const cur = ytext.toString();
  if (cur === next) return;
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  ytext.doc!.transact(() => {
    if (cur.length - a - b > 0) ytext.delete(a, cur.length - a - b);
    if (next.length - a - b > 0) ytext.insert(a, next.slice(a, next.length - b));
  }, origin);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** プロパティを 1 つ書く（undefined で消す） */
export function setProp(doc: Y.Doc, key: string, value: unknown, origin: Origin = Origin.user): void {
  const props = pageProps(doc);
  doc.transact(() => {
    if (value === undefined) props.delete(key);
    else if (!same(props.get(key), value)) props.set(key, value);
  }, origin);
}

/** プロパティ全体を next に合わせる（変わったキーだけ書く） */
export function applyProps(doc: Y.Doc, next: Record<string, unknown>, origin: Origin = Origin.drive): void {
  const props = pageProps(doc);
  doc.transact(() => {
    for (const k of [...props.keys()]) if (!(k in next)) props.delete(k);
    for (const [k, v] of Object.entries(next)) if (!same(props.get(k), v)) props.set(k, v);
  }, origin);
}

/** Y.Doc → Markdown ファイル */
export function pageToMarkdown(doc: Y.Doc): string {
  return serializePage(pageProps(doc).toJSON(), pageBody(doc).toString());
}

/** ファイルの中身 ⇔ Y.Doc の対応。共同編集の部屋は形式ごとにこれを使う */
export interface Codec {
  /** ファイルの内容を Y.Doc に反映する（差分だけ当てる） */
  load(doc: Y.Doc, raw: string): void;
  /** Y.Doc からファイルの内容を作る */
  save(doc: Y.Doc): string;
  /** 他で書き換えられていた（theirs）とき、base からの双方の変更を合わせて Y.Doc に反映する */
  rebase(doc: Y.Doc, base: string, theirs: string): void;
}

/** Markdown ページ */
export const markdownCodec: Codec = {
  load(doc, raw) {
    const page = parsePage("pages/x.md", raw);
    doc.transact(() => {
      applyProps(doc, page.props, Origin.load);
      applyText(pageBody(doc), page.body, Origin.load);
    }, Origin.load);
  },
  save: pageToMarkdown,
  rebase(doc, base, theirs) {
    const b = parsePage("pages/x.md", base);
    const t = parsePage("pages/x.md", theirs);
    const props = pageProps(doc);
    doc.transact(() => {
      // プロパティはキー単位：外で変わったキーだけ取り込む
      const keys = new Set([...Object.keys(b.props), ...Object.keys(t.props)]);
      for (const k of keys) {
        if (same(b.props[k], t.props[k])) continue;
        if (k in t.props) props.set(k, t.props[k]);
        else props.delete(k);
      }
      // 本文は行単位の 3-way マージ
      applyText(pageBody(doc), merge3(b.body, pageBody(doc).toString(), t.body).text, Origin.drive);
    }, Origin.drive);
  },
};
