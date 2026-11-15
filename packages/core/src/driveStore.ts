import { checkRevision, ConflictError, type Store, type StoreEntry, type WriteOptions } from "./store.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,modifiedTime,version,size,mimeType";

interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  version?: string;
  size?: string;
  mimeType: string;
}

export type Fetch = typeof fetch;

/** ルートフォルダの指定：名前ならマイドライブ直下に探す（無ければ作る）、id ならそのフォルダ */
export type DriveRoot = string | { id: string };

/**
 * Google ドライブ上のフォルダをワークスペースとする Store 実装。
 * パス "pages/x.md" はルート直下のフォルダ pages/ 内のファイル x.md に対応する。
 * スコープは drive.file なので、SABAKAN が作ったファイルだけが見える。
 * ブラウザでも Cloudflare Workers でも動く（fetch / Blob / FormData のみ使用）。
 */
export class DriveStore implements Store {
  private ids = new Map<string, string>(); // path → fileId

  /**
   * folders：フォルダ ID の覚え書き（"" → ルート, "pages" → ルート/pages）。
   * フォルダは消えない前提なので、サーバーではリクエストをまたいで共有して往復を減らす。
   */
  constructor(
    private getToken: () => Promise<string>,
    private root: DriveRoot = "SABAKAN",
    private fetcher: Fetch = (...a) => fetch(...a),
    private onAuthError: () => void = () => {},
    private folders: Map<string, string> = new Map(),
  ) {}

  private async request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.getToken();
    const res = await this.fetcher(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) {
      this.onAuthError();
      return this.request(url, init, false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google ドライブとの通信に失敗しました（${res.status}）${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return res;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  private async search(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`);
      out.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  private esc(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  /** フォルダ ID を返す。無ければ作る。dir は "" か "pages" のような1階層 */
  async folder(dir: string): Promise<string> {
    const cached = this.folders.get(dir);
    if (cached) return cached;
    if (dir === "" && typeof this.root !== "string") {
      this.folders.set("", this.root.id);
      return this.root.id;
    }
    const parent = dir === "" ? "root" : await this.folder("");
    const name = dir === "" ? (this.root as string) : dir;
    const found = await this.search(
      `name = '${this.esc(name)}' and mimeType = '${FOLDER}' and '${parent}' in parents and trashed = false`,
    );
    let id = found[0]?.id;
    if (!id) {
      const created = await this.json<DriveFile>(`${API}/files?fields=${FIELDS}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      id = created.id;
    }
    this.folders.set(dir, id);
    return id;
  }

  private split(path: string): [dir: string, name: string] {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
  }

  private entry(path: string, f: DriveFile): StoreEntry {
    this.ids.set(path, f.id);
    return { path, revision: f.version ?? f.modifiedTime, updatedAt: f.modifiedTime, size: Number(f.size ?? 0) };
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    const dir = prefix.replace(/\/$/, "");
    const files = await this.search(`'${await this.folder(dir)}' in parents and trashed = false and mimeType != '${FOLDER}'`);
    return files.map((f) => this.entry(dir ? `${dir}/${f.name}` : f.name, f));
  }

  private async idOf(path: string): Promise<string | undefined> {
    if (this.ids.has(path)) return this.ids.get(path);
    const [dir, name] = this.split(path);
    const found = await this.search(`name = '${this.esc(name)}' and '${await this.folder(dir)}' in parents and trashed = false`);
    if (found[0]) this.entry(path, found[0]);
    return found[0]?.id;
  }

  /** 一覧と中身をまとめて読む（並行数 limit）。list で得た ID を使うので、1 ファイル 1 往復で済む */
  async readAll(prefix: string, opts: { offset?: number; max?: number; limit?: number } = {}): Promise<{ entries: (StoreEntry & { data: Uint8Array })[]; total: number }> {
    const all = await this.list(prefix);
    const slice = all.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.max ?? all.length));
    const out: (StoreEntry & { data: Uint8Array })[] = new Array(slice.length);
    let next = 0;
    const worker = async () => {
      while (next < slice.length) {
        const i = next++;
        out[i] = { ...slice[i], data: await this.read(slice[i].path) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.limit ?? 8, slice.length) }, worker));
    return { entries: out, total: all.length };
  }

  async read(path: string): Promise<Uint8Array> {
    const id = await this.idOf(path);
    if (!id) throw new Error(`not found: ${path}`);
    const res = await this.request(`${API}/files/${id}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 1 ファイルの現在の状態（無ければ null）。キャッシュを使わず毎回問い合わせる */
  async stat(path: string): Promise<StoreEntry | null> {
    const [dir, name] = this.split(path);
    const found = await this.search(`name = '${this.esc(name)}' and '${await this.folder(dir)}' in parents and trashed = false`);
    return found[0] ? this.entry(path, found[0]) : null;
  }

  async write(path: string, data: Uint8Array, contentType = "text/markdown", opts?: WriteOptions): Promise<StoreEntry> {
    if (opts?.ifRevision !== undefined) checkRevision(path, (await this.stat(path))?.revision, opts);
    const id = await this.idOf(path);
    const body = new Blob([data as BlobPart], { type: contentType });
    if (id) {
      const f = await this.json<DriveFile>(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
        method: "PATCH",
        headers: { "Content-Type": contentType },
        body,
      });
      return this.entry(path, f);
    }
    const [dir, name] = this.split(path);
    const meta = { name, parents: [await this.folder(dir)], mimeType: contentType };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    form.append("file", body);
    const f = await this.json<DriveFile>(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      body: form,
    });
    return this.entry(path, f);
  }

  /** 削除はゴミ箱へ移すだけ（ドライブ側で復元できる） */
  async remove(path: string): Promise<void> {
    const id = await this.idOf(path);
    if (!id) return;
    await this.request(`${API}/files/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    this.ids.delete(path);
  }

  /** 同じフォルダの中で名前を変える。ファイル ID と版履歴はそのまま残る */
  async rename(from: string, to: string): Promise<StoreEntry> {
    const [fromDir] = this.split(from);
    const [toDir, toName] = this.split(to);
    if (fromDir !== toDir) throw new Error("フォルダをまたぐ改名はできません");
    const id = await this.idOf(from);
    if (!id) throw new Error(`not found: ${from}`);
    const other = await this.stat(to);
    // stat が from と同じファイルを見つけたら（大文字小文字だけの改名）そのまま進める
    if (other && this.ids.get(to) !== id) throw new ConflictError(to, other.revision);
    const f = await this.json<DriveFile>(`${API}/files/${id}?fields=${FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: toName }),
    });
    this.ids.delete(from);
    return this.entry(to, f);
  }

  async changes() {
    return { changed: await this.list("pages/"), removed: [], cursor: String(Date.now()) };
  }

  /** ルート直下に新しいフォルダを作って ID を返す（同名があっても新規に作る） */
  async createFolder(name: string): Promise<string> {
    const created = await this.json<DriveFile>(`${API}/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [await this.folder("")] }),
    });
    return created.id;
  }

  /** ルート直下に同名フォルダがあれば ID を返す */
  async findFolder(name: string): Promise<string | undefined> {
    const found = await this.search(
      `name = '${this.esc(name)}' and mimeType = '${FOLDER}' and '${await this.folder("")}' in parents and trashed = false`,
    );
    return found[0]?.id;
  }

  /** ログイン中のユーザー（表示用） */
  async user(): Promise<{ name: string; email: string }> {
    const r = await this.json<{ user: { displayName: string; emailAddress: string } }>(`${API}/about?fields=user`);
    return { name: r.user.displayName, email: r.user.emailAddress };
  }
}
