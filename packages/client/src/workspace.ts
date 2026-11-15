import { ConflictError, LinkGraph, merge3, normalizeTitle, parsePage, renameLinks, serializePage, type Page, type Store, type StoreEntry } from "@lim/core";

/** 一覧と本文をまとめて返せる保存先 */
export interface BulkLoader {
  loadPages(): Promise<(StoreEntry & { text: string })[]>;
}

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
  /** パスごとの、最後に保存先と一致していた revision と本文（3-way マージの base） */
  private revs = new Map<string, string>();
  private bases = new Map<string, string>();
  /** 保存中のパス（その間は他の人の変更で上書きしない） */
  private saving = new Set<string>();

  constructor(private store: Store) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    // まとめ読みできる保存先（サーバー経由）なら 1 回の往復で済ませる
    const bulk = (this.store as Partial<BulkLoader>).loadPages;
    if (bulk) return this.loadFrom(await bulk.call(this.store));
    const md = (await this.store.list("pages/")).filter((e) => e.path.endsWith(".md"));
    // 1 件ずつ読む保存先は、6 件ずつ並行に読む
    const texts: string[] = new Array(md.length);
    let next = 0;
    const worker = async () => {
      while (next < md.length) {
        const i = next++;
        texts[i] = dec.decode(await this.store.read(md[i].path));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, md.length) }, worker));
    this.loadFrom(md.map((e, i) => ({ ...e, text: texts[i] })));
  }

  private loadFrom(files: (StoreEntry & { text: string })[]): void {
    const graph = new LinkGraph();
    this.updated.clear();
    this.revs.clear();
    this.bases.clear();
    for (const e of files) {
      if (!e.path.endsWith(".md")) continue;
      this.revs.set(e.path, e.revision);
      this.bases.set(e.path, e.text);
      const page = parsePage(e.path, e.text);
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

  /**
   * 保存する。他の人が先に保存していたら（楽観ロック失敗）、最新を読み直して
   * 3-way マージした結果を保存し直す。どちらの変更も消さない。
   */
  private async put(title: string, props: Record<string, unknown>, body: string): Promise<Page> {
    const path = pathOf(title);
    let text = serializePage(props, body);
    this.saving.add(path);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const entry = await this.store.write(path, enc.encode(text), "text/markdown", { ifRevision: this.revs.get(path) ?? "" });
          this.revs.set(path, entry.revision);
          this.bases.set(path, text);
          const page = parsePage(path, text);
          this.graph.upsert(page);
          this.updated.set(normalizeTitle(page.title), entry.updatedAt);
          return page;
        } catch (e) {
          if (!(e instanceof ConflictError) || attempt >= 3) throw e;
          const theirs = dec.decode(await this.store.read(path));
          text = merge3(this.bases.get(path) ?? "", text, theirs).text;
          this.bases.set(path, theirs);
          this.revs.set(path, e.current);
        }
      }
    } finally {
      this.saving.delete(path);
    }
  }

  /** 本文を保存する。プロパティ（frontmatter）は保持する。他の人の変更と合わせた結果の本文を返す */
  async saveBody(title: string, body: string): Promise<string> {
    const current = this.get(title);
    if (current && current.body === body) return body;
    const page = await this.put(title, current?.props ?? {}, body);
    this.emit();
    return page.body;
  }

  /** 保存はせず、手元の索引（一覧・リンク）だけ本文を更新する。共同編集では保存は部屋が行う */
  applyLocal(title: string, body: string): void {
    const cur = this.get(title);
    if (!cur || cur.body === body) return;
    this.graph.upsert(parsePage(cur.path, serializePage(cur.props, body)));
    this.emit();
  }

  /**
   * 保存先の変更（他の人の編集・追加・削除）を取り込む。変わったページのタイトルを返す。
   * 保存中のページは、保存のほうでマージするので飛ばす。
   */
  async refresh(): Promise<string[]> {
    const entries = (await this.store.list("pages/")).filter((e) => e.path.endsWith(".md"));
    const changed: string[] = [];
    const seen = new Set(entries.map((e) => e.path));
    for (const e of entries) {
      if (this.saving.has(e.path) || this.revs.get(e.path) === e.revision) continue;
      const text = dec.decode(await this.store.read(e.path));
      // 読んでいる間に自分が保存を始めた／終えたなら、そちらを優先する
      if (this.saving.has(e.path) || this.revs.get(e.path) === e.revision) continue;
      this.revs.set(e.path, e.revision);
      this.bases.set(e.path, text);
      const page = parsePage(e.path, text);
      this.graph.upsert(page);
      this.updated.set(normalizeTitle(page.title), e.updatedAt);
      changed.push(page.title);
    }
    for (const path of [...this.revs.keys()]) {
      if (seen.has(path) || this.saving.has(path)) continue;
      const page = this.graph.all().find((p) => p.path === path);
      this.revs.delete(path);
      this.bases.delete(path);
      if (page) {
        this.graph.remove(page.title);
        this.updated.delete(normalizeTitle(page.title));
        changed.push(page.title);
      }
    }
    if (changed.length) this.emit();
    return changed;
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
    this.revs.delete(page.path);
    this.bases.delete(page.path);
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
