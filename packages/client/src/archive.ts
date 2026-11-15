import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { ConflictError, isId, normalizeTitle, parsePage, projectReadme, sanitizeTitle, titleFromPath, type Page, type Store } from "@lim/core";
import type { BulkLoader } from "./workspace";

/*
 * 全部を 1 つにまとめた書き出しと取り込み（決定 0003 の 8、0004）。
 * 中身はドライブのフォルダと同じ形（README.md・pages/・assets/）の zip。新しい形式は作らない。
 * ブラウザで作る（サーバーの CPU を使わない）。
 */

/** 書き出し・取り込みで扱うファイル（README.md は別扱い） */
const FILE = /^(pages|assets)\/[^/\\]+$/;

async function eachLimited<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** 一時的な通信の失敗で全体をやり直さないよう、2 回まで読み直す */
async function readRetry(store: Store, path: string): Promise<Uint8Array> {
  for (let i = 0; ; i++) {
    try {
      return await store.read(path);
    } catch (e) {
      if (i >= 2) throw new Error(`「${path}」を読めませんでした。もう一度お試しください`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

/** 同じパスが 2 回目以降に出たら「題名 (2).md」のようにずらす（ドライブは同じフォルダに同名を許すため） */
function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) return path;
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.indexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; ; n++) {
    const p = `${stem} (${n})${ext}`;
    if (!used.has(p)) return p;
  }
}

export interface ExportResult {
  zip: Blob;
  pages: number;
  assets: number;
  /** 同じ名前のファイルが複数あり、名前に番号を足して入れたもの */
  renamed: string[];
}

/**
 * プロジェクトのファイルを zip にする。assets: false ならページだけ（id の移行の前に取る控えなど）。
 * 画像は読んだ順に zip へ流し込み、全体を 2 重に持たない
 */
export async function exportProject(
  store: Store,
  opts: { assets?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ExportResult> {
  const chunks: Uint8Array[] = [];
  let finish!: () => void;
  let fail!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => ((finish = res), (fail = rej)));
  const zip = new Zip((err, chunk, final) => {
    if (err) return fail(err);
    chunks.push(chunk);
    if (final) finish();
  });
  const used = new Set<string>();
  const renamed: string[] = [];
  const add = (path: string, data: Uint8Array, updatedAt: string, compress: boolean) => {
    const name = uniquePath(path, used);
    if (name !== path) renamed.push(name);
    used.add(name);
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    if (updatedAt) f.mtime = new Date(updatedAt);
    zip.add(f);
    f.push(data, true);
  };

  add("README.md", strToU8(projectReadme()), "", true);
  let pages = 0;
  let assets = 0;
  const bulk = (store as Partial<BulkLoader>).loadPages;
  if (bulk) {
    const enc = new TextEncoder();
    for (const p of await bulk.call(store)) {
      add(p.path, enc.encode(p.text), p.updatedAt, true);
      pages++;
    }
  }
  const entries = [
    ...(bulk ? [] : await store.list("pages/")),
    ...(opts.assets === false ? [] : await store.list("assets/")),
  ].filter((e) => FILE.test(e.path));
  let done = 0;
  await eachLimited(entries, 4, async (e) => {
    const data = await readRetry(store, e.path);
    // 画像はもう圧縮されているので、そのまま入れる
    const isPage = e.path.startsWith("pages/");
    add(e.path, data, e.updatedAt, isPage);
    if (isPage) pages++;
    else assets++;
    opts.onProgress?.(++done, entries.length);
  });
  zip.end();
  await finished;
  return { zip: new Blob(chunks as BlobPart[], { type: "application/zip" }), pages, assets, renamed };
}

export interface ImportResult {
  written: string[];
  /** 同じ題名（題名の同一視で）か同じ id のページ、または同じ名前の画像がすでにあったので書かなかった */
  existed: string[];
  /** pages/・assets/ の直下でないなど、取り込まないファイル */
  ignored: string[];
  /** 通信などで書けなかった（もう一度取り込めば、書けた分は「すでにある」になり続きだけが入る） */
  failed: string[];
}

/**
 * zip（exportProject の形）を、今のプロジェクトへ「無いものだけ」書く。上書きはしない。
 * - ページは、今あるページと題名（空白と _、大文字小文字を同一視）か id が同じなら飛ばす。zip の中の重複も先に除く
 * - ページのファイル名は題名の決まり（NFC・80 文字・使えない文字なし）にそろえる。画像の名前はページから参照されるので変えない
 * - ページは 1 件ずつ書く（同名の同時作成を避ける）。画像は 3 件ずつ
 */
export async function importProject(
  store: Store,
  zip: Uint8Array,
  existing: Pick<Page, "title" | "props">[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  let files: Record<string, Uint8Array>;
  try {
    // 取り込まないもの（フォルダ、macOS の付属ファイル）は展開しない
    files = unzipSync(zip, { filter: (f) => !f.name.endsWith("/") && !f.name.startsWith("__MACOSX/") });
  } catch {
    throw new Error("zip ファイルを読めませんでした。「まとめて書き出す」で作ったファイルを選んでください");
  }
  const result: ImportResult = { written: [], existed: [], ignored: [], failed: [] };
  const titles = new Set(existing.map((p) => normalizeTitle(p.title)));
  const ids = new Set(existing.map((p) => p.props.id).filter(isId));
  const dec = new TextDecoder();
  const pages: [string, Uint8Array][] = [];
  const assets = new Map<string, Uint8Array>();
  for (const [raw, data] of Object.entries(files)) {
    const name = raw.normalize("NFC");
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    // 書き出しを展開してフォルダごと zip にし直したもの（例：家計/pages/x.md）も読めるよう、先頭のフォルダ 1 つは外す
    const path = FILE.test(name) ? name : name.replace(/^[^/]+\//, "");
    if (!FILE.test(path) || path.split("/")[1].startsWith(".")) {
      if (!/(^|\/)README\.md$/.test(name)) result.ignored.push(raw);
      continue;
    }
    if (path.startsWith("assets/")) {
      assets.set(path, data);
      continue;
    }
    if (!path.endsWith(".md")) {
      result.ignored.push(raw);
      continue;
    }
    const title = sanitizeTitle(titleFromPath(path)) || "無題";
    const pid = parsePage(path, dec.decode(data)).props.id;
    const id = isId(pid) ? pid : undefined;
    const key = normalizeTitle(title);
    if (titles.has(key) || (id && ids.has(id))) {
      result.existed.push(`pages/${title}.md`);
      continue;
    }
    titles.add(key);
    if (id) ids.add(id);
    pages.push([`pages/${title}.md`, data]);
  }

  const total = pages.length + assets.size;
  let done = 0;
  const write = async (path: string, data: Uint8Array) => {
    try {
      await store.write(path, data, path.endsWith(".md") ? "text/markdown" : "application/octet-stream", { ifRevision: "" });
      result.written.push(path);
    } catch (e) {
      if (e instanceof ConflictError) result.existed.push(path);
      else result.failed.push(path);
    }
    onProgress?.(++done, total);
  };
  for (const [path, data] of pages) await write(path, data);
  await eachLimited([...assets], 3, ([path, data]) => write(path, data));
  return result;
}
