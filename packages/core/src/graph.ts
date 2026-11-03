import { normalizeTitle, type Page } from "./page.js";

/**
 * ページ間のリンク関係。保存先からいつでも再構築できるキャッシュ。
 * Cloudflare 上では D1 の links 表が同じ役割を担う。
 */
export class LinkGraph {
  private pages = new Map<string, Page>();
  private backlinks = new Map<string, Set<string>>();

  constructor(pages: Iterable<Page> = []) {
    for (const p of pages) this.upsert(p);
  }

  upsert(page: Page): void {
    this.remove(page.title);
    const key = normalizeTitle(page.title);
    this.pages.set(key, page);
    for (const link of page.links) {
      const target = normalizeTitle(link);
      if (!this.backlinks.has(target)) this.backlinks.set(target, new Set());
      this.backlinks.get(target)!.add(key);
    }
  }

  remove(title: string): void {
    const key = normalizeTitle(title);
    const old = this.pages.get(key);
    if (!old) return;
    for (const link of old.links) this.backlinks.get(normalizeTitle(link))?.delete(key);
    this.pages.delete(key);
  }

  get(title: string): Page | undefined {
    return this.pages.get(normalizeTitle(title));
  }

  all(): Page[] {
    return [...this.pages.values()];
  }

  /** リンク先のページが存在するか（未作成リンクの色分け用） */
  exists(title: string): boolean {
    return this.pages.has(normalizeTitle(title));
  }

  /** title へリンクしているページ */
  linksTo(title: string): Page[] {
    const keys = this.backlinks.get(normalizeTitle(title)) ?? new Set();
    return [...keys].map((k) => this.pages.get(k)!).filter(Boolean);
  }

  /**
   * Cosense の「関連ページ」。title と同じリンク先を共有するページを、
   * 共有しているリンク名ごとにまとめて返す（2hop リンク）。
   */
  twoHop(title: string): Map<string, Page[]> {
    const self = normalizeTitle(title);
    const page = this.pages.get(self);
    const result = new Map<string, Page[]>();
    if (!page) return result;
    const direct = new Set([self, ...this.linksTo(title).map((p) => normalizeTitle(p.title))]);
    for (const p of page.links.map((l) => this.get(l)).filter(Boolean) as Page[]) {
      direct.add(normalizeTitle(p.title));
    }
    for (const link of page.links) {
      const via = this.linksTo(link).filter((p) => !direct.has(normalizeTitle(p.title)));
      if (via.length) result.set(link, via);
    }
    return result;
  }
}
