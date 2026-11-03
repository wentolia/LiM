/**
 * 保存先の抽象。Google ドライブ / R2 / GitHub などはこの I/F を実装するだけで差し替えられる。
 * パスは常にワークスペース相対（"pages/x.md", "assets/y.png"）。
 */
export interface Store {
  list(prefix: string): Promise<StoreEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, contentType?: string): Promise<StoreEntry>;
  remove(path: string): Promise<void>;
  /** 前回の cursor 以降の変更（索引の差分更新用） */
  changes(cursor?: string): Promise<{ changed: StoreEntry[]; removed: string[]; cursor: string }>;
}

export interface StoreEntry {
  path: string;
  /** 楽観ロック用。ドライブなら version、R2 なら etag */
  revision: string;
  updatedAt: string;
  size: number;
}

/** テストと開発用のメモリ実装 */
export class MemoryStore implements Store {
  private files = new Map<string, { data: Uint8Array; entry: StoreEntry }>();
  private log: { path: string; removed: boolean }[] = [];

  async list(prefix: string): Promise<StoreEntry[]> {
    return [...this.files.values()].filter((f) => f.entry.path.startsWith(prefix)).map((f) => f.entry);
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    return f.data;
  }

  async write(path: string, data: Uint8Array): Promise<StoreEntry> {
    const prev = this.files.get(path);
    const entry: StoreEntry = {
      path,
      revision: String(Number(prev?.entry.revision ?? 0) + 1),
      updatedAt: new Date().toISOString(),
      size: data.byteLength,
    };
    this.files.set(path, { data, entry });
    this.log.push({ path, removed: false });
    return entry;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.log.push({ path, removed: true });
  }

  async changes(cursor = "0") {
    const from = Number(cursor);
    const latest = new Map<string, boolean>();
    for (const { path, removed } of this.log.slice(from)) latest.set(path, removed);
    const changed: StoreEntry[] = [];
    const removed: string[] = [];
    for (const [path, isRemoved] of latest) {
      const f = this.files.get(path);
      if (isRemoved || !f) removed.push(path);
      else changed.push(f.entry);
    }
    return { changed, removed, cursor: String(this.log.length) };
  }
}
