import { describe, expect, it } from "vitest";
import { DriveStore } from "../src/driveStore";

/** Drive API v3 の必要最小限を模したフェイク */
function fakeDrive() {
  let seq = 0;
  const files = new Map<string, { id: string; name: string; parents: string[]; mimeType: string; data: string; version: number; trashed: boolean }>();
  const meta = (f: { id: string; name: string; mimeType: string; data: string; version: number }) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: `2026-11-15T00:00:${String(f.version).padStart(2, "0")}Z`, version: String(f.version), size: String(f.data.length),
  });
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (url.pathname.endsWith("/about")) return json({ user: { displayName: "W", emailAddress: "w@example.com" } });
    const m = url.pathname.match(/\/files\/([^/]+)$/);
    if (method === "GET" && url.pathname.endsWith("/files")) {
      const q = url.searchParams.get("q")!;
      const parent = q.match(/'([^']+)' in parents/)![1];
      const name = q.match(/name = '([^']+)'/)?.[1];
      const onlyFolders = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const noFolders = q.includes("mimeType != ");
      const hit = [...files.values()].filter((f) => !f.trashed && f.parents.includes(parent) && (!name || f.name === name)
        && (!onlyFolders || f.mimeType.includes("folder")) && (!noFolders || !f.mimeType.includes("folder")));
      return json({ files: hit.map(meta) });
    }
    if (method === "POST" && url.pathname === "/drive/v3/files") {
      const b = JSON.parse(String(init.body));
      const f = { id: `f${++seq}`, ...b, data: "", version: 1, trashed: false };
      files.set(f.id, f);
      return json(meta(f));
    }
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
      const form = init.body as FormData;
      const b = JSON.parse(await (form.get("metadata") as Blob).text());
      const f = { id: `f${++seq}`, ...b, data: await (form.get("file") as Blob).text(), version: 1, trashed: false };
      files.set(f.id, f);
      return json(meta(f));
    }
    if (m && method === "PATCH" && url.pathname.startsWith("/upload")) {
      const f = files.get(m[1])!;
      f.data = await (init.body as Blob).text();
      f.version++;
      return json(meta(f));
    }
    if (m && method === "PATCH") {
      Object.assign(files.get(m[1])!, JSON.parse(String(init.body)));
      return json({});
    }
    if (m && method === "GET") return new Response(files.get(m[1])!.data, { status: 200 });
    return new Response("unexpected", { status: 500 });
  };
  return { files, calls, fetcher: fetcher as typeof fetch };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("DriveStore", () => {
  it("SABAKAN/pages フォルダを作り、書いて読める", async () => {
    const d = fakeDrive();
    const s = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    await s.write("pages/a.md", enc.encode("hello"));
    const folders = [...d.files.values()].filter((f) => f.mimeType.includes("folder"));
    expect(folders.map((f) => f.name).sort()).toEqual(["SABAKAN", "pages"]);
    expect(dec.decode(await s.read("pages/a.md"))).toBe("hello");
  });

  it("同じパスへの書き込みは上書き（ファイルは増えない）", async () => {
    const d = fakeDrive();
    const s = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    await s.write("pages/a.md", enc.encode("1"));
    const e = await s.write("pages/a.md", enc.encode("2"));
    expect(e.revision).toBe("2");
    const fresh = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    const list = await fresh.list("pages/");
    expect(list.map((x) => x.path)).toEqual(["pages/a.md"]);
    expect(dec.decode(await fresh.read("pages/a.md"))).toBe("2");
  });

  it("ifRevision が違えば ConflictError", async () => {
    const d = fakeDrive();
    const s = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    const e = await s.write("pages/a.md", enc.encode("1"), undefined, { ifRevision: "" });
    await expect(s.write("pages/a.md", enc.encode("2"), undefined, { ifRevision: "" })).rejects.toThrow("先に保存");
    await s.write("pages/a.md", enc.encode("2"), undefined, { ifRevision: e.revision });
    expect(dec.decode(await s.read("pages/a.md"))).toBe("2");
  });

  it("削除はゴミ箱へ移す", async () => {
    const d = fakeDrive();
    const s = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    await s.write("pages/a.md", enc.encode("x"));
    await s.remove("pages/a.md");
    expect(await s.list("pages/")).toEqual([]);
    expect([...d.files.values()].find((f) => f.name === "a.md")?.trashed).toBe(true);
  });

  it("401 ならトークンを捨てて 1 回だけ再試行する", async () => {
    const d = fakeDrive();
    let invalidated = 0;
    let first = true;
    const fetcher = (async (u: RequestInfo | URL, i?: RequestInit) => {
      if (first) { first = false; return new Response("", { status: 401 }); }
      return d.fetcher(u, i);
    }) as typeof fetch;
    const s = new DriveStore(async () => "tok", "SABAKAN", fetcher, () => invalidated++);
    expect(await s.user()).toEqual({ name: "W", email: "w@example.com" });
    expect(invalidated).toBe(1);
  });

  it("id 指定のルートを使い、サブフォルダを作れる", async () => {
    const d = fakeDrive();
    const top = new DriveStore(async () => "tok", "SABAKAN", d.fetcher);
    const projectId = await top.createFolder("企画");
    const s = new DriveStore(async () => "tok", { id: projectId }, d.fetcher);
    await s.write("pages/a.md", enc.encode("x"));
    const pages = [...d.files.values()].find((f) => f.name === "pages")!;
    expect(pages.parents).toEqual([projectId]);
    expect(await top.findFolder("企画")).toBe(projectId);
  });
});
