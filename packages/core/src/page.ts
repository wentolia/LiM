import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** SABAKAN の唯一のデータ型。1 Page = 1 Markdown ファイル。 */
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
  /** frontmatter が YAML として読めなかった。props は空、ファイル全体を本文として扱う（書き戻しても中身は変わらない） */
  invalidFrontmatter?: true;
}

/**
 * 題名をファイル名に使える形にする：NFC にそろえ、使えない文字と制御文字を置き換え、
 * 先頭のドットと末尾のドット・空白を外し、MAX_TITLE_LENGTH 文字までにする
 */
export function sanitizeTitle(title: string): string {
  const t = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "－")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return [...t].slice(0, MAX_TITLE_LENGTH).join("").replace(/[.\s]+$/, "");
}

/** 題名から新しく作るページのパス */
export const pathOf = (title: string) => `pages/${sanitizeTitle(title)}.md`;

/** 予約された項目名。書き出すときはこの順で先頭に並べ、残りは名前順にする */
export const RESERVED_PROPS = ["id", "type", "tags", "created_at"] as const;
/** 人が読むものではないので、一覧などの表示では出さない項目 */
export const HIDDEN_PROPS: readonly string[] = ["id", "created_at"];
/** 題名の長さの上限（ファイル名として PC に同期しても困らない長さ） */
export const MAX_TITLE_LENGTH = 80;

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

/** リンク名の正規化。Unicode を NFC にそろえ、Cosense と同じく空白と _ を同一視し、大文字小文字を無視する */
export function normalizeTitle(title: string): string {
  return title.normalize("NFC").trim().replace(/[\s_]+/g, " ").toLowerCase();
}

function stripCode(text: string): string {
  return text.replace(FENCE, "").replace(INLINE_CODE, "");
}

/**
 * 引用符なしで手書きした `author: [[山田]]` は YAML では [["山田"]]（リストのリスト）になる。
 * 読み込み時に文字列 "[[山田]]" へそろえる（書き出すと `author: "[[山田]]"` になる）
 */
function normalizeBareLinks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === "string") {
    return `[[${value[0][0]}]]`;
  }
  return value.map(normalizeBareLinks);
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
  let invalid = false;
  const fm = text.match(FRONTMATTER);
  if (fm) {
    // 手で書き換えたファイルや外の道具が書いたファイルでも、1 件の失敗で全体を止めない
    let parsed: unknown;
    try {
      parsed = parseYaml(fm[1]);
    } catch {
      invalid = true;
    }
    // 空の frontmatter（--- と --- だけ）は従来どおり props なし。文やリストなど「項目: 値」でないものは読めないものとして扱う
    const isMap = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    if (!invalid && parsed != null && !isMap) invalid = true;
    if (!invalid) {
      if (isMap) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          // defineProperty：__proto__ のような項目名も普通の項目として持つ
          Object.defineProperty(props, k, { value: normalizeBareLinks(v), enumerable: true, writable: true, configurable: true });
        }
      }
      body = text.slice(fm[0].length);
    }
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
    ...(invalid ? { invalidFrontmatter: true as const } : {}),
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

/** props と本文から Markdown ファイルの中身を作る（parsePage の逆） */
export function serializePage(props: Record<string, unknown>, body: string): string {
  const keys = Object.keys(props);
  if (keys.length === 0) return body;
  // 書き出しの形を固定する：予約項目を先頭に、残りは名前順。長い文字列を折り返さない
  const reserved: readonly string[] = RESERVED_PROPS;
  // Map を使う（__proto__ などの項目名も失わない）
  const ordered = new Map<string, unknown>();
  for (const k of RESERVED_PROPS) if (Object.prototype.hasOwnProperty.call(props, k)) ordered.set(k, props[k]);
  for (const k of keys.filter((k) => !reserved.includes(k)).sort()) ordered.set(k, props[k]);
  const fm = stringifyYaml(ordered, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${body}`;
}

/** 本文中の [[old]] / [[old|別名]] を [[next]] に書き換える（改名時のリンク追従） */
export function renameLinks(text: string, oldTitle: string, nextTitle: string): string {
  const target = normalizeTitle(oldTitle);
  return text.replace(WIKILINK, (whole, name: string) => {
    if (normalizeTitle(name) !== target) return whole;
    return whole.replace(name, nextTitle);
  });
}

/** props の中の [[old]] を [[next]] に書き換える（文字列とリスト） */
export function renamePropLinks(props: Record<string, unknown>, oldTitle: string, nextTitle: string): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return renameLinks(v, oldTitle, nextTitle);
    if (Array.isArray(v)) return v.map(walk);
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = walk(v);
  return out;
}

/** 一覧タイル用の本文冒頭。記法を外し、空行を除く */
export function excerpt(body: string, maxLines = 5): string {
  return stripCode(body)
    .split(/\r?\n/)
    .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(WIKILINK, "$1").replace(/^#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}
