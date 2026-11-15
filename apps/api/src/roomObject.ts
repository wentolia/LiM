import { DriveStore, type StoreEntry } from "@lim/core";
import { ownerAccessToken } from "./app";
import { GoogleOAuth } from "./google";
import { D1Repo } from "./repo";
import { Room, type Conn } from "./room";
import type { Env } from "./index";
import { roomTarget } from "./roomTarget";

/* Durable Object の最小限の型 */
interface DOState {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, v: unknown): Promise<void> };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
const roomFolderCache = new Map<string, Map<string, string>>();
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket & { accept(): void } } };

/**
 * ページ 1 枚ごとの共同編集の部屋（名前 = "<プロジェクトID>:<パス>"）。
 * Worker がメンバーかどうかを確かめてから、ここへ WebSocket をつなぐ。
 */
export class PageRoom {
  private room: Room | null = null;

  constructor(private state: DOState, private env: Env) {}

  private makeRoom(projectId: string, path: string, origin: string): Room {
    const repo = new D1Repo(this.env.DB);
    const google = new GoogleOAuth({
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      redirectUri: `${origin}/api/auth/callback`,
    });
    let store: DriveStore | null = null;
    const drive = async () => {
      if (store) return store;
      const project = await repo.getProject(projectId);
      if (!project) throw new Error("project not found");
      let cache = roomFolderCache.get(project.folder_id);
      if (!cache) roomFolderCache.set(project.folder_id, (cache = new Map()));
      store = new DriveStore(() => ownerAccessToken(repo, google, project.owner_id, Date.now()), { id: project.folder_id }, undefined, undefined, cache);
      return store;
    };
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    return new Room({
      file: {
        stat: async () => (await drive()).stat(path),
        read: async () => dec.decode(await (await drive()).read(path)),
        write: async (text, ifRevision): Promise<StoreEntry> =>
          (await drive()).write(path, enc.encode(text), "text/markdown; charset=utf-8", { ifRevision }),
      },
      storage: {
        get: () => this.state.storage.get("room"),
        put: (v) => this.state.storage.put("room", v),
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as number),
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const { projectId, path } = roomTarget(req);
    // 消えたページの部屋は作り直す
    if (!this.room || (this.room.gone && this.room.size === 0)) {
      this.room = this.makeRoom(projectId, path, new URL(req.url).origin);
    }
    const room = this.room;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const conn: Conn = {
      send: (d) => server.send(d),
      close: (code, reason) => server.close(code, reason),
    };
    const queue: Uint8Array[] = [];
    let joined = false;
    server.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") return;
      const data = new Uint8Array(e.data as ArrayBuffer);
      if (joined) room.message(conn, data);
      else queue.push(data);
    });
    const leave = () => void room.leave(conn)?.catch((err) => console.error("flush on leave failed", err));
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);
    room.join(conn).then(
      () => {
        joined = true;
        for (const d of queue.splice(0)) room.message(conn, d);
      },
      (err) => {
        console.error("join failed", err);
        server.close(1011, "load failed");
      },
    );
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}
