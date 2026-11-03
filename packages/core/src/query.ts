import { normalizeTitle, type Page } from "./page.js";
import type { LinkGraph } from "./graph.js";

/**
 * ページ集合の絞り込み・並べ替え・描き方。語彙は where / sort / group / view の 4 つだけ。
 *
 * ```query
 * where: type = book          # 文字列 1 つ、または配列（AND）
 * sort: rating desc
 * group: status
 * view: table
 * ```
 */
export interface Query {
  where: Condition[];
  sort?: { key: string; desc: boolean };
  group?: string;
  view: string;
}

export type Condition =
  | { kind: "compare"; key: string; op: "=" | "!=" | ">" | "<" | ">=" | "<="; value: string }
  | { kind: "exists"; key: string }
  | { kind: "links_to"; target: string }
  | { kind: "tag"; tag: string }
  | { kind: "text"; text: string };

export interface QueryContext {
  graph: LinkGraph;
  /** query を書いたページ。links_to: this の解決に使う */
  current?: Page;
}

const COMPARE = /^([^\s=!<>]+)\s*(=|!=|>=|<=|>|<)\s*(.+)$/;
const FUNC = /^(links_to|tag|text|exists)\s*:\s*(.+)$/;

export function parseCondition(src: string): Condition {
  const s = src.trim();
  const f = s.match(FUNC);
  if (f) {
    const arg = unquote(f[2]);
    switch (f[1]) {
      case "links_to":
        return { kind: "links_to", target: arg };
      case "tag":
        return { kind: "tag", tag: arg.replace(/^#/, "") };
      case "text":
        return { kind: "text", text: arg };
      default:
        return { kind: "exists", key: arg };
    }
  }
  const c = s.match(COMPARE);
  if (c) return { kind: "compare", key: c[1], op: c[2] as never, value: unquote(c[3]) };
  throw new Error(`解釈できない条件です: ${src}`);
}

/**
 * query ブロックの解釈。`where: links_to: this` のように値にコロンを含められるよう、
 * YAML ではなく「キー: 値」の行形式として読む。where は複数行（`- 条件`）で AND。
 */
export function parseQuery(src: string): Query {
  const query: Query = { where: [], view: "list" };
  let section = "";
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#\s.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item) {
      if (section !== "where") throw new Error(`リスト項目は where の下にのみ書けます: ${rawLine}`);
      query.where.push(parseCondition(item[1]));
      continue;
    }
    const kv = line.match(/^(where|sort|group|view)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`解釈できない行です: ${rawLine}`);
    section = kv[1];
    const value = kv[2].trim();
    if (!value) continue;
    if (section === "where") query.where.push(parseCondition(value));
    else if (section === "view") query.view = value;
    else if (section === "group") query.group = value;
    else {
      const [key, dir] = value.split(/\s+/);
      query.sort = { key, desc: dir?.toLowerCase() === "desc" };
    }
  }
  return query;
}

/** 本文中の ```query ブロックを取り出す */
export function extractQueries(body: string): Query[] {
  const out: Query[] = [];
  for (const m of body.matchAll(/^(```|~~~)query[^\n]*\n([\s\S]*?)^\1\s*$/gm)) {
    out.push(parseQuery(m[2]));
  }
  return out;
}

/** プロパティ値の取得。title / path は組み込みプロパティ */
export function getProp(page: Page, key: string): unknown {
  if (key === "title") return page.title;
  if (key === "path") return page.path;
  return page.props[key];
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function scalar(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const link = s.match(/^\[\[(.+)\]\]$/);
  return link ? link[1] : s;
}

function compare(a: unknown, b: unknown): number {
  const x = scalar(a);
  const y = scalar(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1; // 値なしは常に末尾
  if (y === null) return -1;
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
  return String(x).localeCompare(String(y), "ja");
}

function matches(page: Page, cond: Condition, ctx: QueryContext): boolean {
  switch (cond.kind) {
    case "exists": {
      const v = getProp(page, cond.key);
      return v !== undefined && v !== null && v !== "";
    }
    case "tag":
      return page.tags.some((t) => normalizeTitle(t) === normalizeTitle(cond.tag));
    case "text": {
      const needle = cond.text.toLowerCase();
      return page.title.toLowerCase().includes(needle) || page.body.toLowerCase().includes(needle);
    }
    case "links_to": {
      const target = cond.target === "this" ? ctx.current?.title : cond.target;
      if (!target) return false;
      return page.links.some((l) => normalizeTitle(l) === normalizeTitle(target));
    }
    case "compare": {
      const value = getProp(page, cond.key);
      const values = Array.isArray(value) ? value : [value];
      return values.some((v) => {
        if (cond.op === "=") return scalar(v) !== null && compare(v, cond.value) === 0;
        if (cond.op === "!=") return scalar(v) === null || compare(v, cond.value) !== 0;
        if (scalar(v) === null) return false;
        const d = compare(v, cond.value);
        return cond.op === ">" ? d > 0 : cond.op === "<" ? d < 0 : cond.op === ">=" ? d >= 0 : d <= 0;
      });
    }
  }
}

export interface QueryResult {
  query: Query;
  pages: Page[];
  /** group 指定時のみ。グループ値 → ページ（出現順） */
  groups?: Map<string, Page[]>;
}

export function runQuery(query: Query, ctx: QueryContext): QueryResult {
  let pages = ctx.graph
    .all()
    .filter((p) => p !== ctx.current && query.where.every((c) => matches(p, c, ctx)));
  if (query.sort) {
    const { key, desc } = query.sort;
    pages = pages.sort((a, b) => {
      const d = compare(getProp(a, key), getProp(b, key));
      // 値なしは昇順・降順どちらでも末尾に置く
      if (getProp(a, key) == null || getProp(b, key) == null) return d;
      return desc ? -d : d;
    });
  }
  const result: QueryResult = { query, pages };
  if (query.group) {
    const groups = new Map<string, Page[]>();
    for (const p of pages) {
      const k = String(scalar(getProp(p, query.group)) ?? "（なし）");
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    result.groups = groups;
  }
  return result;
}
