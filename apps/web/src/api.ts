import type { Store, StoreEntry } from "@lim/core";

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

  async read(path: string): Promise<Uint8Array> {
    const res = await fetch(this.url(path), { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, `読み込めませんでした（${res.status}）`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, contentType = "text/markdown"): Promise<StoreEntry> {
    const res = await fetch(this.url(path), {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": contentType },
      body: data as BlobPart,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error ?? `保存できませんでした（${res.status}）`);
    return body as StoreEntry;
  }

  async remove(path: string): Promise<void> {
    await call("DELETE", this.url(path));
  }

  async changes() {
    return { changed: await this.list("pages/"), removed: [], cursor: String(Date.now()) };
  }
}
