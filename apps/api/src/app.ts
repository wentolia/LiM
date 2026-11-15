import { ConflictError, DriveStore, pathOf, type Store, type StoreEntry } from "@lim/core";
import { decodeIdToken, DRIVE_SCOPE, type Google } from "./google";
import type { Project, Repo, Role, User } from "./repo";

/* SABAKAN の API。メンバーは Google で本人確認だけ行い、
 * ページの読み書きはサーバーがプロジェクト管理者のドライブに対して代わりに行う。 */

export interface Deps {
  repo: Repo;
  google: Google;
  clientId: string;
  /** 管理者のアクセストークンでドライブを開く（テストではメモリ Store に差し替える） */
  openDrive: (token: string, root: string | { id: string }) => DriveLike;
  /** 共同編集の部屋へつなぐ（WebSocket）。無ければ共同編集なし */
  openRoom?: (projectId: string, path: string, req: Request) => Promise<Response>;
  now?: () => number;
  randomId?: () => string;
}

export type DriveLike = Store & {
  readAll?: (prefix: string, opts?: { offset?: number; max?: number }) => Promise<{ entries: (StoreEntry & { data: Uint8Array })[]; total: number }>;
  createFolder(name: string): Promise<string>;
  findFolder(name: string): Promise<string | undefined>;
  folder(dir: string): Promise<string>;
};

/** フォルダ ID の覚え書き（ルートごと）。同じ実行環境ではリクエストをまたいで使う */
const folderCaches = new Map<string, Map<string, string>>();

export const defaultOpenDrive = (token: string, root: string | { id: string }): DriveLike => {
  const key = typeof root === "string" ? `name:${root}` : root.id;
  let cache = folderCaches.get(key);
  if (!cache) folderCaches.set(key, (cache = new Map()));
  return new DriveStore(async () => token, root, undefined, undefined, cache);
};

const ROOT_FOLDER = "SABAKAN";
/** まとめ読みの 1 回あたりの件数（Workers 無料プランの外部通信 50 回/リクエスト に収める） */
const BULK_MAX = 40;
const SESSION_DAYS = 30;
const SID = "sid";
const STATE = "oauth_state";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** 管理者の有効なアクセストークン（期限切れなら refresh_token で更新して保存） */
export async function ownerAccessToken(repo: Repo, google: Google, ownerId: string, now: number): Promise<string> {
  const t = await repo.getDriveToken(ownerId);
  if (!t) throw new HttpError(409, "管理者のドライブが接続されていません");
  if (t.access_token && t.expires_at && t.expires_at > now + 60_000) return t.access_token;
  const r = await google.refresh(t.refresh_token).catch(() => {
    throw new HttpError(409, "管理者のドライブ接続が切れています。管理者がもう一度ドライブを接続してください");
  });
  await repo.putDriveToken({ ...t, access_token: r.access_token, expires_at: now + r.expires_in * 1000 });
  return r.access_token;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** パスは pages/ か assets/ 直下のファイルだけ許す */
export function validPath(path: string | null): path is string {
  return !!path && /^(pages|assets)\/[^/\\]+$/.test(path) && !path.includes("..") && path.length < 300;
}

const TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
};
export const contentTypeOf = (path: string) => TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

const normEmail = (e: string) => e.trim().toLowerCase();

/** 部屋への WebSocket 接続の直近の結果（診断用。プロジェクト:パスごと、同じ isolate の中だけ） */
const roomAttempts = new Map<string, { at: string; origin: string | null; upgrade: string | null; result: string }>();

export function createApp(deps: Deps) {
  const now = deps.now ?? (() => Date.now());
  const rid = deps.randomId ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const { repo, google } = deps;

  async function currentUser(req: Request): Promise<User | null> {
    const sid = cookies(req)[SID];
    return sid ? repo.getSessionUser(sid, now()) : null;
  }

  async function requireUser(req: Request): Promise<User> {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, "ログインしてください");
    return u;
  }

  const ownerToken = (ownerId: string) => ownerAccessToken(repo, google, ownerId, now());

  async function access(req: Request, projectId: string, need: Role = "member"): Promise<{ user: User; project: Project; role: Role }> {
    const user = await requireUser(req);
    const project = await repo.getProject(projectId);
    const role = project ? await repo.roleOf(projectId, user.email) : null;
    if (!project || !role) throw new HttpError(404, "プロジェクトが見つかりません");
    if (need === "owner" && role !== "owner") throw new HttpError(403, "管理者だけができる操作です");
    return { user, project, role };
  }

  async function projectStore(project: Project): Promise<DriveLike> {
    return deps.openDrive(await ownerToken(project.owner_id), { id: project.folder_id });
  }

  async function createProject(user: User, name: string): Promise<Project> {
    const token = await ownerToken(user.id);
    const top = deps.openDrive(token, ROOT_FOLDER);
    const project: Project = {
      id: rid().slice(0, 12),
      name,
      owner_id: user.id,
      folder_id: await top.createFolder(name.replace(/[\\/]/g, "－")),
      created_at: new Date(now()).toISOString(),
    };
    await repo.createProject(project);
    await repo.addMember({ project_id: project.id, email: user.email, role: "owner", added_at: project.created_at });
    return project;
  }

  /** 初めてドライブを接続したとき、以前の個人用フォルダ（SABAKAN/pages）があればプロジェクトとして取り込む */
  async function adoptLegacyFolder(user: User): Promise<void> {
    if ((await repo.projectsOwnedBy(user.id)).length > 0) return;
    const top = deps.openDrive(await ownerToken(user.id), ROOT_FOLDER);
    if (!(await top.findFolder("pages"))) return;
    const id = rid().slice(0, 12);
    const created_at = new Date(now()).toISOString();
    await repo.createProject({ id, name: "マイページ", owner_id: user.id, folder_id: await top.folder(""), created_at });
    await repo.addMember({ project_id: id, email: user.email, role: "owner", added_at: created_at });
  }

  const routes: [method: string, pattern: RegExp, handler: (req: Request, m: string[], url: URL) => Promise<Response>][] = [
    // ---- ログイン ----
    ["GET", /^\/api\/auth\/login$/, async (_req, _m, url) => {
      const withDrive = url.searchParams.get("drive") === "1";
      const state = `${rid()}.${withDrive ? 1 : 0}`;
      return new Response(null, {
        status: 302,
        headers: { Location: google.authUrl(state, withDrive), "Set-Cookie": cookie(STATE, state, 600) },
      });
    }],
    ["GET", /^\/api\/auth\/callback$/, async (req, _m, url) => {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code || cookies(req)[STATE] !== state) {
        return new Response(null, { status: 302, headers: { Location: "/#/login-error" } });
      }
      const tok = await google.exchange(code);
      if (!tok.id_token) throw new HttpError(400, "本人確認の情報がありません");
      const claims = decodeIdToken(tok.id_token);
      if (claims.aud !== deps.clientId || claims.email_verified === false) throw new HttpError(400, "本人確認に失敗しました");
      const user: User = { id: claims.sub, email: normEmail(claims.email), name: claims.name ?? claims.email };
      await repo.upsertUser(user);

      if (state.endsWith(".1") && tok.scope?.includes(DRIVE_SCOPE)) {
        const prev = await repo.getDriveToken(user.id);
        const refresh = tok.refresh_token ?? prev?.refresh_token;
        if (refresh) {
          await repo.putDriveToken({ user_id: user.id, refresh_token: refresh, access_token: tok.access_token, expires_at: now() + tok.expires_in * 1000 });
          await adoptLegacyFolder(user);
        }
      }

      const sid = rid() + rid();
      await repo.createSession(sid, user.id, now() + SESSION_DAYS * 86400_000);
      const headers = new Headers({ Location: "/" });
      headers.append("Set-Cookie", cookie(SID, sid, SESSION_DAYS * 86400));
      headers.append("Set-Cookie", cookie(STATE, "", 0));
      return new Response(null, { status: 302, headers });
    }],
    ["POST", /^\/api\/auth\/logout$/, async (req) => {
      const sid = cookies(req)[SID];
      if (sid) await repo.deleteSession(sid);
      return json({ ok: true }, 200, { "Set-Cookie": cookie(SID, "", 0) });
    }],
    ["GET", /^\/api\/me$/, async (req) => {
      const user = await requireUser(req);
      return json({ ...user, driveConnected: !!(await repo.getDriveToken(user.id)) });
    }],

    // ---- プロジェクト ----
    ["GET", /^\/api\/projects$/, async (req) => {
      const user = await requireUser(req);
      return json((await repo.projectsOf(user.email)).map(({ id, name, role, created_at }) => ({ id, name, role, created_at })));
    }],
    ["POST", /^\/api\/projects$/, async (req) => {
      const user = await requireUser(req);
      const name = String(((await req.json()) as { name?: string }).name ?? "").trim();
      if (!name) throw new HttpError(400, "プロジェクト名を入力してください");
      const p = await createProject(user, name.slice(0, 80));
      return json({ id: p.id, name: p.name, role: "owner", created_at: p.created_at }, 201);
    }],
    ["PATCH", /^\/api\/projects\/(\w+)$/, async (req, m) => {
      await access(req, m[1], "owner");
      const name = String(((await req.json()) as { name?: string }).name ?? "").trim();
      if (!name) throw new HttpError(400, "プロジェクト名を入力してください");
      await repo.renameProject(m[1], name.slice(0, 80));
      return json({ ok: true });
    }],

    // ---- メンバー ----
    ["GET", /^\/api\/projects\/(\w+)\/members$/, async (req, m) => {
      await access(req, m[1]);
      return json(await repo.members(m[1]));
    }],
    ["POST", /^\/api\/projects\/(\w+)\/members$/, async (req, m) => {
      await access(req, m[1], "owner");
      const email = normEmail(String(((await req.json()) as { email?: string }).email ?? ""));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "メールアドレスの形が正しくありません");
      await repo.addMember({ project_id: m[1], email, role: "member", added_at: new Date(now()).toISOString() });
      return json(await repo.members(m[1]), 201);
    }],
    ["DELETE", /^\/api\/projects\/(\w+)\/members$/, async (req, m, url) => {
      const { project } = await access(req, m[1], "owner");
      const email = normEmail(url.searchParams.get("email") ?? "");
      const owner = await repo.getUser(project.owner_id);
      if (owner?.email === email) throw new HttpError(400, "管理者は外せません");
      await repo.removeMember(m[1], email);
      return json(await repo.members(m[1]));
    }],

    // ---- 共同編集（WebSocket） ----
    ["GET", /^\/api\/projects\/(\w+)\/room(?:\/(.*))?$/, async (req, m, url) => {
      const path = url.searchParams.get("path") ?? decodeURIComponent(m[2] ?? "");
      const key = `${m[1]}:${path}`;
      // ?check=1 は接続できないときの診断（部屋を開けるか＋直近の WebSocket 接続の結果を JSON で返す）
      const check = url.searchParams.get("check") === "1" && req.headers.get("Upgrade") !== "websocket";
      if (check) {
        await access(req, m[1]);
        if (!validPath(path) || !path.endsWith(".md")) throw new HttpError(400, "bad path");
        if (!deps.openRoom) throw new HttpError(501, "共同編集は使えません");
        const res = await deps.openRoom(m[1], path, req);
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return json({ ...body, lastAttempt: roomAttempts.get(key) ?? null });
      }
      const note = (result: string) => {
        roomAttempts.delete(key);
        roomAttempts.set(key, { at: new Date(now()).toISOString(), origin: req.headers.get("Origin"), upgrade: req.headers.get("Upgrade"), result });
        if (roomAttempts.size > 200) roomAttempts.delete(roomAttempts.keys().next().value!);
      };
      try {
        // 他サイトからの WebSocket 接続を防ぐ
        const origin = req.headers.get("Origin");
        if (origin !== url.origin) throw new HttpError(403, `forbidden origin (expected ${url.origin})`);
        if (req.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "WebSocket で接続してください");
        await access(req, m[1]);
        if (!validPath(path) || !path.endsWith(".md")) throw new HttpError(400, "bad path");
        if (!deps.openRoom) throw new HttpError(501, "共同編集は使えません");
        const res = await deps.openRoom(m[1], path, req);
        note(String(res.status));
        return res;
      } catch (e) {
        note(e instanceof HttpError ? `${e.status} ${e.message}` : `error ${(e as Error).message}`);
        throw e;
      }
    }],

    // ---- ファイル（ページ・画像） ----
    ["GET", /^\/api\/projects\/(\w+)\/files$/, async (req, m, url) => {
      const { project } = await access(req, m[1]);
      const prefix = url.searchParams.get("prefix") ?? "pages/";
      if (!/^(pages|assets)\/$/.test(prefix)) throw new HttpError(400, "bad prefix");
      return json(await (await projectStore(project)).list(prefix));
    }],
    // 初回読み込み用：ページの一覧と本文をまとめて返す（1 回 40 件まで。続きは offset で）
    ["GET", /^\/api\/projects\/(\w+)\/pages$/, async (req, m, url) => {
      const { project } = await access(req, m[1]);
      const store = await projectStore(project);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const dec = new TextDecoder();
      if (store.readAll) {
        const r = await store.readAll("pages/", { offset, max: BULK_MAX });
        const pages = r.entries.filter((e) => e.path.endsWith(".md")).map(({ data, ...e }) => ({ ...e, text: dec.decode(data) }));
        return json({ pages, next: offset + BULK_MAX < r.total ? offset + BULK_MAX : null });
      }
      const all = (await store.list("pages/")).filter((e) => e.path.endsWith(".md"));
      const slice = all.slice(offset, offset + BULK_MAX);
      const pages = await Promise.all(slice.map(async (e) => ({ ...e, text: dec.decode(await store.read(e.path)) })));
      return json({ pages, next: offset + BULK_MAX < all.length ? offset + BULK_MAX : null });
    }],
    ["GET", /^\/api\/projects\/(\w+)\/file$/, async (req, m, url) => {
      const { project } = await access(req, m[1]);
      const path = url.searchParams.get("path");
      if (!validPath(path)) throw new HttpError(400, "bad path");
      const data = await (await projectStore(project)).read(path).catch(() => { throw new HttpError(404, "ありません"); });
      const asset = path.startsWith("assets/");
      return new Response(data as BlobPart, {
        headers: {
          "Content-Type": contentTypeOf(path),
          // 画像はファイル名が変わらないので長めにキャッシュ。ページは常に最新を読む
          "Cache-Control": asset ? "private, max-age=86400" : "no-store",
          // 画像として以外は解釈させない（SVG 内のスクリプトなどを無効化）
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }],
    ["PUT", /^\/api\/projects\/(\w+)\/file$/, async (req, m, url) => {
      const { project } = await access(req, m[1]);
      const path = url.searchParams.get("path");
      if (!validPath(path)) throw new HttpError(400, "bad path");
      const data = new Uint8Array(await req.arrayBuffer());
      if (data.length > 10 * 1024 * 1024) throw new HttpError(413, "ファイルが大きすぎます（10MB まで）");
      const ifMatch = req.headers.get("If-Match");
      try {
        return json(await (await projectStore(project)).write(path, data, contentTypeOf(path), ifMatch === null ? undefined : { ifRevision: ifMatch }));
      } catch (e) {
        if (e instanceof ConflictError) return json({ error: e.message, current: e.current }, 409);
        throw e;
      }
    }],
    ["PATCH", /^\/api\/projects\/(\w+)\/file$/, async (req, m, url) => {
      // 改名（同じフォルダの中だけ）。ドライブの版履歴とファイル ID を保つ
      const { project } = await access(req, m[1]);
      const path = url.searchParams.get("path");
      const to = url.searchParams.get("to");
      const isPage = (x: string | null): x is string => validPath(x) && x.startsWith("pages/") && x.endsWith(".md");
      if (!isPage(path) || !isPage(to)) throw new HttpError(400, "bad path");
      // 行き先は題名の決まり（NFC・80 文字・使えない文字なし）に沿っていること
      if (to !== pathOf(to.slice("pages/".length, -".md".length))) throw new HttpError(400, "その名前は使えません");
      const store = await projectStore(project);
      if (!store.rename) throw new HttpError(501, "この保存先は改名に対応していません");
      try {
        return json(await store.rename(path, to));
      } catch (e) {
        if (e instanceof ConflictError) return json({ error: "その名前のページはすでにあります", current: e.current }, 409);
        throw e;
      }
    }],
    ["DELETE", /^\/api\/projects\/(\w+)\/file$/, async (req, m, url) => {
      const { project } = await access(req, m[1]);
      const path = url.searchParams.get("path");
      if (!validPath(path)) throw new HttpError(400, "bad path");
      await (await projectStore(project)).remove(path);
      return json({ ok: true });
    }],
  ];

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // 他サイトからの書き込みを防ぐ：変更系は同一オリジンのみ
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
    }
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && method === req.method) {
        try {
          return await handler(req, m, url);
        } catch (e) {
          if (e instanceof HttpError) return json({ error: e.message }, e.status);
          console.error(e);
          return json({ error: e instanceof Error ? e.message : "サーバーでエラーが起きました" }, 500);
        }
      }
    }
    return json({ error: "not found" }, 404);
  };
}
