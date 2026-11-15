import { describe, expect, it } from "vitest";
import { MemoryStore } from "@lim/core";
import { createApp, validPath, type DriveLike } from "../src/app";
import type { Google } from "../src/google";
import { MemoryRepo } from "../src/repo";

const ORIGIN = "https://sabakan.example";
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
const idToken = (sub: string, email: string) => `x.${b64({ sub, email, name: sub, aud: "cid", email_verified: true })}.y`;

function setup() {
  const repo = new MemoryRepo();
  const drives = new Map<string, MemoryStore>(); // フォルダ ID → 中身
  const folders = new Map<string, string>(); // 名前 → ID（SABAKAN 直下）
  let seq = 0;
  const tokens: string[] = [];
  let nextLogin = { sub: "alice", email: "alice@example.com", drive: false };
  const google: Google = {
    authUrl: (state, withDrive) => `https://accounts.google.com/auth?state=${state}&drive=${withDrive}`,
    exchange: async () => ({
      access_token: `at-${nextLogin.sub}`,
      expires_in: 3600,
      id_token: idToken(nextLogin.sub, nextLogin.email),
      ...(nextLogin.drive ? { refresh_token: `rt-${nextLogin.sub}`, scope: "openid https://www.googleapis.com/auth/drive.file" } : {}),
    }),
    refresh: async (rt) => ({ access_token: `fresh-${rt}`, expires_in: 3600 }),
  };
  const openDrive = (token: string, root: string | { id: string }): DriveLike => {
    tokens.push(token);
    const rootId = typeof root === "string" ? "sabakan-root" : root.id;
    const store = drives.get(rootId) ?? new MemoryStore();
    drives.set(rootId, store);
    return Object.assign(store, {
      createFolder: async (name: string) => { const id = `folder${++seq}`; folders.set(name, id); return id; },
      findFolder: async (name: string) => folders.get(name),
      folder: async () => rootId,
    });
  };
  let t = 1_000_000;
  const rooms: string[] = [];
  const app = createApp({
    repo, google, clientId: "cid", openDrive, now: () => t, randomId: () => `r${++seq}abcdefghijkl`,
    openRoom: async (pid, path) => { rooms.push(`${pid}:${path}`); return new Response("ok"); },
  });

  const jar = new Map<string, string>(); // ユーザー → sid
  async function login(sub: string, email: string, drive = false) {
    nextLogin = { sub, email, drive };
    const start = await app(new Request(`${ORIGIN}/api/auth/login${drive ? "?drive=1" : ""}`));
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cb = await app(new Request(`${ORIGIN}/api/auth/callback?code=c&state=${state}`, { headers: { Cookie: `oauth_state=${state}` } }));
    expect(cb.status).toBe(302);
    const sid = cb.headers.get("Set-Cookie")!.match(/sid=([^;]+)/)![1];
    jar.set(sub, sid);
  }
  function call(sub: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (sub) h.Cookie = `sid=${jar.get(sub)}`;
    if (body !== undefined && typeof body !== "string") h["Content-Type"] = "application/json";
    return app(new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }));
  }
  return { repo, drives, folders, tokens, rooms, login, call, advance: (ms: number) => (t += ms) };
}

describe("API", () => {
  it("ログインしていなければ 401", async () => {
    const s = setup();
    expect((await s.call(null, "GET", "/api/me")).status).toBe(401);
  });

  it("state が一致しないコールバックは受け付けない", async () => {
    const s = setup();
    const res = await s.call(null, "GET", "/api/auth/callback?code=c&state=zzz", undefined, { Cookie: "oauth_state=other" });
    expect(res.headers.get("Location")).toBe("/#/login-error");
  });

  it("管理者がプロジェクトを作り、招待したメンバーだけが読み書きできる", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const me = await (await s.call("alice", "GET", "/api/me")).json();
    expect(me.driveConnected).toBe(true);

    const p = await (await s.call("alice", "POST", "/api/projects", { name: "読書会" })).json();
    expect(p.role).toBe("owner");

    // 招待前の bob は見えない
    await s.login("bob", "bob@example.com");
    expect(await (await s.call("bob", "GET", "/api/projects")).json()).toEqual([]);
    expect((await s.call("bob", "GET", `/api/projects/${p.id}/files`)).status).toBe(404);

    // 招待（大文字でも同じ人）
    expect((await s.call("alice", "POST", `/api/projects/${p.id}/members`, { email: "Bob@Example.com" })).status).toBe(201);
    const list = await (await s.call("bob", "GET", "/api/projects")).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual(["読書会"]);

    // bob が書いたページは alice のドライブ（プロジェクトのフォルダ）に入る
    const put = await s.call("bob", "PUT", `/api/projects/${p.id}/file?path=${encodeURIComponent("pages/メモ.md")}`, "こんにちは", { "Content-Type": "text/markdown" });
    expect(put.status).toBe(200);
    expect(s.tokens.at(-1)).toBe("at-alice");
    const read = await s.call("alice", "GET", `/api/projects/${p.id}/file?path=${encodeURIComponent("pages/メモ.md")}`);
    expect(await read.text()).toBe("こんにちは");
    const files = await (await s.call("alice", "GET", `/api/projects/${p.id}/files?prefix=pages/`)).json();
    expect(files.map((f: { path: string }) => f.path)).toEqual(["pages/メモ.md"]);

    // メンバーは招待できない
    expect((await s.call("bob", "POST", `/api/projects/${p.id}/members`, { email: "c@example.com" })).status).toBe(403);
    // 管理者は外せない
    expect((await s.call("alice", "DELETE", `/api/projects/${p.id}/members?email=alice@example.com`)).status).toBe(400);
    // 外されたら見えなくなる
    await s.call("alice", "DELETE", `/api/projects/${p.id}/members?email=bob@example.com`);
    expect((await s.call("bob", "GET", `/api/projects/${p.id}/files`)).status).toBe(404);
  });

  it("If-Match の revision が古ければ 409 と現在の revision を返す", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    const url = `/api/projects/${p.id}/file?path=pages/x.md`;
    const first = await (await s.call("alice", "PUT", url, "1", { "If-Match": "" })).json();
    const stale = await s.call("alice", "PUT", url, "2", { "If-Match": "" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toBe(first.revision);
    expect((await s.call("alice", "PUT", url, "2", { "If-Match": first.revision })).status).toBe(200);
  });

  it("改名は同じフォルダの .md だけ。行き先に別のページがあれば 409", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    const f = (path: string) => `/api/projects/${p.id}/file?path=${encodeURIComponent(path)}`;
    await s.call("alice", "PUT", f("pages/x.md"), "X");
    await s.call("alice", "PUT", f("pages/y.md"), "Y");
    expect((await s.call("alice", "PATCH", `${f("pages/x.md")}&to=${encodeURIComponent("pages/y.md")}`)).status).toBe(409);
    expect((await s.call("alice", "PATCH", `${f("pages/x.md")}&to=${encodeURIComponent("assets/x.md")}`)).status).toBe(400);
    expect((await s.call("alice", "PATCH", `${f("pages/x.md")}&to=${encodeURIComponent("pages/z.md")}`)).status).toBe(200);
    expect(await (await s.call("alice", "GET", f("pages/z.md"))).text()).toBe("X");
  });

  it("画像は画像の Content-Type で返し、スクリプトは無効化する", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    await s.call("alice", "PUT", `/api/projects/${p.id}/file?path=assets/a.svg`, "<svg/>");
    const res = await s.call("alice", "GET", `/api/projects/${p.id}/file?path=assets/a.svg`);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("初回読み込み：一覧と本文をまとめて返し、40 件ごとに続きを返す", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    for (let i = 0; i < 45; i++) await s.call("alice", "PUT", `/api/projects/${p.id}/file?path=pages/p${i}.md`, `本文${i}`);
    const first = await (await s.call("alice", "GET", `/api/projects/${p.id}/pages`)).json();
    expect(first.pages).toHaveLength(40);
    expect(first.pages[0].text).toMatch(/^本文/);
    expect(first.next).toBe(40);
    const second = await (await s.call("alice", "GET", `/api/projects/${p.id}/pages?offset=40`)).json();
    expect(second.pages).toHaveLength(5);
    expect(second.next).toBe(null);
    await s.login("bob", "bob@example.com");
    expect((await s.call("bob", "GET", `/api/projects/${p.id}/pages`)).status).toBe(404);
  });

  it("共同編集の部屋：パスはクエリで受け取り、メンバーと同一オリジンだけつなぐ", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    const url = `/api/projects/${p.id}/room?path=${encodeURIComponent("pages/議事録.md")}`;
    const ok = await s.call("alice", "GET", url, undefined, { Upgrade: "websocket", Origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(s.rooms).toEqual([`${p.id}:pages/議事録.md`]);
    expect((await s.call("alice", "GET", url, undefined, { Upgrade: "websocket", Origin: "https://evil.example" })).status).toBe(403);
    await s.login("bob", "bob@example.com");
    expect((await s.call("bob", "GET", url, undefined, { Upgrade: "websocket", Origin: ORIGIN })).status).toBe(404);
  });

  it("部屋の診断（check=1）は WebSocket なしで部屋へ通し、メンバー以外は断る", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    const url = `/api/projects/${p.id}/room?check=1&path=${encodeURIComponent("pages/議事録.md")}`;
    const first = await s.call("alice", "GET", url);
    expect(first.status).toBe(200);
    expect(s.rooms).toEqual([`${p.id}:pages/議事録.md`]);
    // 直近の WebSocket 接続の結果（ここでは Origin 違いで断られた）が診断に出る
    const ws = url.replace("check=1&", "");
    await s.call("alice", "GET", ws, undefined, { Upgrade: "websocket", Origin: "https://evil.example" });
    const after = await (await s.call("alice", "GET", url)).json();
    expect(after.lastAttempt.result).toMatch(/^403 forbidden origin/);
    await s.login("bob", "bob@example.com");
    expect((await s.call("bob", "GET", url)).status).toBe(404);
  });

  it("ドライブ未接続の人はプロジェクトを作れない", async () => {
    const s = setup();
    await s.login("bob", "bob@example.com");
    const res = await s.call("bob", "POST", "/api/projects", { name: "x" });
    expect(res.status).toBe(409);
  });

  it("アクセストークンが切れたら refresh_token で更新する", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const p = await (await s.call("alice", "POST", "/api/projects", { name: "a" })).json();
    s.advance(2 * 3600_000);
    await s.call("alice", "GET", `/api/projects/${p.id}/files`);
    expect(s.tokens.at(-1)).toBe("fresh-rt-alice");
  });

  it("以前の個人フォルダ（SABAKAN/pages）があれば「マイページ」として取り込む", async () => {
    const s = setup();
    s.folders.set("pages", "legacy-pages");
    await s.login("alice", "alice@example.com", true);
    const list = await (await s.call("alice", "GET", "/api/projects")).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual(["マイページ"]);
  });

  it("他サイトからの書き込みは拒否する", async () => {
    const s = setup();
    await s.login("alice", "alice@example.com", true);
    const res = await s.call("alice", "POST", "/api/projects", { name: "x" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("パスは pages/ と assets/ 直下だけ", () => {
    expect(validPath("pages/a.md")).toBe(true);
    expect(validPath("assets/x.png")).toBe(true);
    expect(validPath("pages/../x")).toBe(false);
    expect(validPath("pages/a/b.md")).toBe(false);
    expect(validPath("secret.md")).toBe(false);
  });
});
