import { ConflictError, formatTime, LinkGraph, merge3, newId, pagesNeedingId, pathOf, sanitizeTitle, normalizeTitle, parsePage, renameLinks, renamePropLinks, serializePage, type Page, type Store, type StoreEntry } from "@lim/core";

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

export { pathOf, sanitizeTitle };

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
  private async put(title: string, props: Record<string, unknown>, body: string, at?: string, fresh = false): Promise<Page> {
    // 既存ページは実際のパスに書く（題名の決まりより前に作られたファイル名でも二重にしない）
    const path = at ?? this.get(title)?.path ?? pathOf(title);
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
          // 新規作成（fresh）で他の人が先に同じ名前で作っていた：混ぜずに呼び出し元へ返す（両方の id と frontmatter が重なるのを防ぐ）
          if (!(e instanceof ConflictError) || attempt >= 3 || (fresh && !this.revs.has(path))) throw e;
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

  /**
   * 新しいページを作る。名前が重複したら番号を付ける。
   * exact：その題名のページが欲しい（リンクから開くとき）。他の人が先に作っていたら、それを使う
   */
  async create(base = "無題", opts: { exact?: boolean } = {}): Promise<string> {
    const stem = sanitizeTitle(base) || "無題";
    for (let attempt = 0; ; attempt++) {
      let title = stem;
      if (opts.exact && this.exists(title)) return this.get(title)!.title;
      for (let n = 2; this.exists(title); n++) title = `${stem} ${n}`;
      try {
        await this.put(title, { id: newId(), created_at: formatTime(new Date()) }, "", undefined, true);
        this.emit();
        return title;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 3) throw e;
        await this.refresh();
      }
    }
  }

  /** id を付けるべきページ（無い・形が違う・重複）と、frontmatter が読めず付けられないページ */
  missingIds(): { paths: string[]; skipped: string[] } {
    return pagesNeedingId(this.graph.all());
  }

  /**
   * 移行：id の無いページ・重複したページに id を付ける。保存先と一致している内容（部屋の書き出し待ちの分は含めない）に
   * 項目を 1 つ足して revision 条件付きで書く。開いている部屋は次の書き出しで 3-way マージして取り込む。
   * 何度流しても同じ結果になる（他の人が先に付けていたら何もしない）。
   * ドライブの条件付き書き込みは「確かめる → 書く」の 2 往復で原子的でないため、部屋が書き出した直後の内容を
   * 古い内容で上書きしないよう、最近（recentMs 以内）更新されたページは飛ばす（あとで流し直せば付く）
   */
  async assignIds(
    onProgress?: (done: number, total: number) => void,
    opts: { now?: number; recentMs?: number } = {},
  ): Promise<{ assigned: number; recent: number; failed: number; skipped: string[] }> {
    // 他の人の変更を先に取り込み、最新の内容と更新日時で判断する
    await this.refresh();
    const { paths, skipped } = this.missingIds();
    // 端末の時計が遅れていても、ドライブの最新の更新日時より前にはしない（全件が「編集中」のままになるのを防ぐ）
    const newest = Math.max(0, ...[...this.updated.values()].map((v) => Date.parse(v) || 0));
    const now = Math.max(opts.now ?? Date.now(), newest);
    const recentMs = opts.recentMs ?? 120_000;
    let assigned = 0;
    let recent = 0;
    let failed = 0;
    for (let i = 0; i < paths.length; i++) {
      const page = this.graph.all().find((p) => p.path === paths[i]);
      const at = page ? Date.parse(this.updatedAt(page.title)) : NaN;
      if (!(now - at >= recentMs)) recent++;
      else {
        try {
          if (await this.addId(paths[i])) assigned++;
          else recent++;
        } catch (e) {
          // 1 件の失敗（通信・ドライブの回数制限）で止めない。流し直せば続きから付く
          console.warn("id", paths[i], e);
          failed++;
        }
      }
      onProgress?.(i + 1, paths.length);
    }
    if (assigned) this.emit();
    return { assigned, recent, failed, skipped };
  }

  /** 1 件に id を付ける。保存先が手元の内容から変わっていたら（誰かが今書いた）付けずに false */
  private async addId(path: string): Promise<boolean> {
    const text = this.bases.get(path);
    const rev = this.revs.get(path);
    if (text === undefined || rev === undefined) return false;
    const page = parsePage(path, text);
    if (page.invalidFrontmatter) return false;
    const next = serializePage({ ...page.props, id: newId() }, page.body);
    this.saving.add(path);
    try {
      const entry = await this.store.write(path, enc.encode(next), "text/markdown", { ifRevision: rev });
      this.revs.set(path, entry.revision);
      this.bases.set(path, next);
      const saved = parsePage(path, next);
      this.graph.upsert(saved);
      this.updated.set(normalizeTitle(saved.title), entry.updatedAt);
      return true;
    } catch (e) {
      if (e instanceof ConflictError) return false;
      throw e;
    } finally {
      this.saving.delete(path);
    }
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
    if (this.store.rename) {
      // 保存先の「名前の変更」を使う（ドライブの版履歴とファイル ID が残り、途中で失敗しても二重や欠落が出ない）
      const to = pathOf(next);
      let entry: StoreEntry;
      try {
        entry = await this.store.rename(page.path, to);
      } catch (e) {
        if (e instanceof ConflictError) throw new Error(`「${next}」という名前のページはすでにあります`);
        throw e;
      }
      const base = this.bases.get(page.path);
      this.revs.delete(page.path);
      this.bases.delete(page.path);
      this.graph.remove(page.title);
      this.updated.delete(normalizeTitle(page.title));
      this.revs.set(to, entry.revision);
      if (base !== undefined) this.bases.set(to, base);
      const text = serializePage(page.props, page.body);
      this.graph.upsert(parsePage(to, text));
      this.updated.set(normalizeTitle(next), entry.updatedAt);
      // 共同編集の部屋がまだ書き出していない分（手元の索引には入っている）を新しいファイルに書く
      if (base !== undefined && text !== base) await this.put(next, page.props, page.body, to);
    } else {
      await this.put(next, page.props, page.body, pathOf(next));
      await this.store.remove(page.path);
      this.revs.delete(page.path);
      this.bases.delete(page.path);
      this.graph.remove(page.title);
      this.updated.delete(normalizeTitle(page.title));
      // 大文字小文字だけの改名では put が同じキーを上書きしているので、消した分を戻す
      if (!this.exists(next)) await this.put(next, page.props, page.body, pathOf(next));
    }
    for (const r of referrers) {
      await this.put(r.title, renamePropLinks(r.props, page.title, next), renameLinks(r.body, page.title, next));
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
