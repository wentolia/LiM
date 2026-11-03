import { LinkGraph, normalizeTitle, parsePage, renameLinks, serializePage, type Page, type Store } from "@lim/core";

export interface PageItem {
  page: Page;
  updatedAt: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ファイル名に使えない文字を置き換える */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "－").replace(/\s+/g, " ").trim();
}

export const pathOf = (title: string) => `pages/${sanitizeTitle(title)}.md`;

/**
 * 全ページを 1 つの箱として扱う作業領域。
 * 保存先（Store）からページを読み、リンクグラフを持ち、変更を通知する。
 */
export class Workspace {
  graph = new LinkGraph();
  private updated = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private store: Store) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    const entries = await this.store.list("pages/");
    const graph = new LinkGraph();
    this.updated.clear();
    for (const e of entries) {
      if (!e.path.endsWith(".md")) continue;
      const page = parsePage(e.path, dec.decode(await this.store.read(e.path)));
      graph.upsert(page);
      this.updated.set(normalizeTitle(page.title), e.updatedAt);
    }
    this.graph = graph;
    this.emit();
  }

  /** 更新の新しい順 */
  list(): PageItem[] {
    return this.graph
      .all()
      .map((page) => ({ page, updatedAt: this.updated.get(normalizeTitle(page.title)) ?? "" }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(title: string): Page | undefined {
    return this.graph.get(title);
  }

  updatedAt(title: string): string {
    return this.updated.get(normalizeTitle(title)) ?? "";
  }

  exists(title: string): boolean {
    return this.graph.exists(title);
  }

  private async put(title: string, props: Record<string, unknown>, body: string): Promise<Page> {
    const path = pathOf(title);
    const entry = await this.store.write(path, enc.encode(serializePage(props, body)), "text/markdown");
    const page = parsePage(path, serializePage(props, body));
    this.graph.upsert(page);
    this.updated.set(normalizeTitle(page.title), entry.updatedAt);
    return page;
  }

  /** 本文を保存する。プロパティ（frontmatter）は保持する */
  async saveBody(title: string, body: string): Promise<void> {
    const current = this.get(title);
    if (current && current.body === body) return;
    await this.put(title, current?.props ?? {}, body);
    this.emit();
  }

  /** 新しいページを作る。名前が重複したら番号を付ける */
  async create(base = "無題"): Promise<string> {
    let title = sanitizeTitle(base) || "無題";
    for (let n = 2; this.exists(title); n++) title = `${sanitizeTitle(base) || "無題"} ${n}`;
    await this.put(title, {}, "");
    this.emit();
    return title;
  }

  /** 改名。他ページの [[旧名]] も書き換える。成功したら新しい名前を返す */
  async rename(oldTitle: string, nextRaw: string): Promise<string> {
    const next = sanitizeTitle(nextRaw);
    const page = this.get(oldTitle);
    if (!page || !next || next === page.title) return page?.title ?? oldTitle;
    if (this.exists(next) && normalizeTitle(next) !== normalizeTitle(page.title)) {
      throw new Error(`「${next}」という名前のページはすでにあります`);
    }
    const referrers = this.graph.linksTo(page.title).filter((p) => p.title !== page.title);
    await this.put(next, page.props, page.body);
    await this.store.remove(page.path);
    this.graph.remove(page.title);
    this.updated.delete(normalizeTitle(page.title));
    // 大文字小文字だけの改名では put が同じキーを上書きしているので、消した分を戻す
    if (!this.exists(next)) await this.put(next, page.props, page.body);
    for (const r of referrers) {
      await this.put(r.title, r.props, renameLinks(r.body, page.title, next));
    }
    this.emit();
    return next;
  }

  /** title と同じリンク先を持つページ（Cosense の関連ページ）。リンク名ごと */
  related(title: string): { via: string; pages: Page[] }[] {
    const page = this.get(title);
    if (!page) return [];
    return page.links
      .map((link) => ({
        via: link,
        pages: this.graph.linksTo(link).filter((p) => normalizeTitle(p.title) !== normalizeTitle(page.title)),
      }))
      .filter((g) => g.pages.length > 0);
  }
}
