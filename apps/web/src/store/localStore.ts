import type { Store, StoreEntry } from "@lim/core";

interface StoredFile {
  text: string;
  revision: number;
  updatedAt: string;
}

/**
 * ブラウザの localStorage に保存する Store 実装。
 * Google ドライブ連携ができるまでの暫定の保存先で、I/F は同じなので後で差し替える。
 */
export class LocalStorageStore implements Store {
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  constructor(
    private key = "lim:files",
    private storage: Storage = window.localStorage,
  ) {}

  private load(): Record<string, StoredFile> {
    try {
      return JSON.parse(this.storage.getItem(this.key) ?? "{}");
    } catch {
      return {};
    }
  }

  private persist(files: Record<string, StoredFile>): void {
    this.storage.setItem(this.key, JSON.stringify(files));
  }

  private entry(path: string, f: StoredFile): StoreEntry {
    return { path, revision: String(f.revision), updatedAt: f.updatedAt, size: f.text.length };
  }

  isEmpty(): boolean {
    return Object.keys(this.load()).length === 0;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    return Object.entries(this.load())
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, f]) => this.entry(p, f));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.load()[path];
    if (!f) throw new Error(`not found: ${path}`);
    return this.enc.encode(f.text);
  }

  async write(path: string, data: Uint8Array, _contentType?: string, updatedAt?: string): Promise<StoreEntry> {
    const files = this.load();
    const next: StoredFile = {
      text: this.dec.decode(data),
      revision: (files[path]?.revision ?? 0) + 1,
      updatedAt: updatedAt ?? new Date().toISOString(),
    };
    files[path] = next;
    this.persist(files);
    return this.entry(path, next);
  }

  async remove(path: string): Promise<void> {
    const files = this.load();
    delete files[path];
    this.persist(files);
  }

  async changes() {
    return { changed: await this.list(""), removed: [], cursor: String(Date.now()) };
  }
}
