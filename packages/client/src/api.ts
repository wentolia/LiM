import { ConflictError, type Store, type StoreEntry, type WriteOptions } from "@lim/core";

/* サーバー（/api）とのやりとり */

export interface Me { id: string; email: string; name: string; driveConnected: boolean }
export type Role = "owner" | "member";
export interface ProjectInfo { id: string; name: string; role: Role; created_at: string }
export interface MemberInfo { email: string; role: Role; added_at: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "サーバーにつながりません");
  }
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) throw new ApiError(res.status === 200 ? 0 : res.status, "サーバーにつながりません");
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `エラー（${res.status}）`);
  return data as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  projects: () => call<ProjectInfo[]>("GET", "/api/projects"),
  createProject: (name: string) => call<ProjectInfo>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) => call<{ ok: true }>("PATCH", `/api/projects/${id}`, { name }),
  members: (id: string) => call<MemberInfo[]>("GET", `/api/projects/${id}/members`),
  addMember: (id: string, email: string) => call<MemberInfo[]>("POST", `/api/projects/${id}/members`, { email }),
  removeMember: (id: string, email: string) =>
    call<MemberInfo[]>("DELETE", `/api/projects/${id}/members?email=${encodeURIComponent(email)}`),
};

export const loginUrl = (withDrive = false) => `/api/auth/login${withDrive ? "?drive=1" : ""}`;

/** プロジェクトのファイルをサーバー経由で読み書きする Store */
export class ApiStore implements Store {
  constructor(private projectId: string) {}

  private url(path: string) {
    return `/api/projects/${this.projectId}/file?path=${encodeURIComponent(path)}`;
  }

  list(prefix: string): Promise<StoreEntry[]> {
    return call("GET", `/api/projects/${this.projectId}/files?prefix=${encodeURIComponent(prefix)}`);
  }

  /** 初回読み込み：ページの一覧と本文をまとめて受け取る（40 件ずつ） */
  async loadPages(): Promise<(StoreEntry & { text: string })[]> {
    const out: (StoreEntry & { text: string })[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const r: { pages: (StoreEntry & { text: string })[]; next: number | null } = await call(
        "GET",
        `/api/projects/${this.projectId}/pages?offset=${offset}`,
      );
      out.push(...r.pages);
      offset = r.next;
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await fetch(this.url(path), { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, `読み込めませんでした（${res.status}）`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, contentType = "text/markdown", opts?: WriteOptions): Promise<StoreEntry> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (opts?.ifRevision !== undefined) headers["If-Match"] = opts.ifRevision;
    const res = await fetch(this.url(path), { method: "PUT", credentials: "same-origin", headers, body: data as BlobPart });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) throw new ConflictError(path, body.current ?? "");
    if (!res.ok) throw new ApiError(res.status, body.error ?? `保存できませんでした（${res.status}）`);
    return body as StoreEntry;
  }

  async remove(path: string): Promise<void> {
    await call("DELETE", this.url(path));
  }

  /** 画像などを assets/ に保存し、ページから参照するパス（../assets/…）を返す */
  async upload(file: Blob, name = "image"): Promise<string> {
    if (file.size > 10 * 1024 * 1024) throw new Error("画像は 10MB までです");
    const ext = (file.type.split("/")[1] ?? name.split(".").pop() ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const path = `assets/${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    await this.write(path, new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream");
    return `../${path}`;
  }

  /** ページ内の画像パス（../assets/x.png）を表示用の URL にする。外部 URL はそのまま */
  assetUrl(src: string): string {
    const m = src.match(/^(?:\.\.\/)?(assets\/[^/]+)$/);
    return m ? this.url(m[1]) : src;
  }

  async changes() {
    return { changed: await this.list("pages/"), removed: [], cursor: String(Date.now()) };
  }
}
