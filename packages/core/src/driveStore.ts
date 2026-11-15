import type { Store, StoreEntry } from "./store.js";

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
  private folders = new Map<string, string>(); // "" → ルート, "pages" → ルート/pages
  private ids = new Map<string, string>(); // path → fileId

  constructor(
    private getToken: () => Promise<string>,
    private root: DriveRoot = "SABAKAN",
    private fetcher: Fetch = (...a) => fetch(...a),
    private onAuthError: () => void = () => {},
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

  async read(path: string): Promise<Uint8Array> {
    const id = await this.idOf(path);
    if (!id) throw new Error(`not found: ${path}`);
    const res = await this.request(`${API}/files/${id}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, contentType = "text/markdown"): Promise<StoreEntry> {
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
