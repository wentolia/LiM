import { parse as parseYaml } from "yaml";

/** LiM の唯一のデータ型。1 Page = 1 Markdown ファイル。 */
export interface Page {
  /** 保存先上のパス（例: "pages/読書メモ.md"） */
  path: string;
  /** ファイル名（拡張子なし）。リンク解決のキー */
  title: string;
  /** frontmatter。DB のプロパティもここ */
  props: Record<string, unknown>;
  /** 本文（frontmatter を除く） */
  body: string;
  /** 本文・プロパティ中の [[リンク]] と #タグ（重複なし、出現順） */
  links: string[];
  /** #タグ のみ（links にも含まれる） */
  tags: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const WIKILINK = /\[\[([^\[\]\n|]+?)(?:\|[^\[\]\n]*)?\]\]/g;
// 行頭か空白の直後の #。見出しの "# " は対象外
const TAG = /(^|[\s(])#([^\s#\[\](),.、。!?！？]+)/gmu;

export function titleFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

/** リンク名の正規化。Cosense と同じく空白と _ を同一視し、大文字小文字を無視する */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/[\s_]+/g, " ").toLowerCase();
}

function stripCode(text: string): string {
  return text.replace(FENCE, "").replace(INLINE_CODE, "");
}

function collectFromValue(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(WIKILINK)) out.push(m[1].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) collectFromValue(v, out);
  }
}

export function parsePage(path: string, text: string): Page {
  let props: Record<string, unknown> = {};
  let body = text;
  const fm = text.match(FRONTMATTER);
  if (fm) {
    const parsed = parseYaml(fm[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      props = parsed as Record<string, unknown>;
    }
    body = text.slice(fm[0].length);
  }

  const plain = stripCode(body);
  const links: string[] = [];
  for (const value of Object.values(props)) collectFromValue(value, links);
  for (const m of plain.matchAll(WIKILINK)) links.push(m[1].trim());

  const tags: string[] = [];
  const propTags = props.tags;
  if (Array.isArray(propTags)) tags.push(...propTags.map(String));
  else if (typeof propTags === "string") tags.push(propTags);
  for (const m of plain.matchAll(TAG)) tags.push(m[2]);

  return {
    path,
    title: titleFromPath(path),
    props,
    body,
    links: dedupe([...links, ...tags]),
    tags: dedupe(tags),
  };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = normalizeTitle(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
