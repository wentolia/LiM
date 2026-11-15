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
    const { projectId, path } = roomTarget(req);
    const check = new URL(req.url).searchParams.get("check") === "1";
    if (!check && req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    // 消えたページの部屋は作り直す
    if (!this.room || (this.room.gone && this.room.size === 0)) {
      this.room = this.makeRoom(projectId, path, new URL(req.url).origin);
    }
    const room = this.room;
    if (check) {
      try {
        await room.load();
        return Response.json({ ok: true, gone: room.gone, clients: room.size });
      } catch (e) {
        return Response.json({ ok: false, error: errorText(e) });
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // 新しい互換日付では、バイナリの受信が既定で Blob になる。ArrayBuffer で受け取る
    try {
      (server as unknown as { binaryType: string }).binaryType = "arraybuffer";
    } catch {
      /* 古いランタイムは常に ArrayBuffer */
    }
    server.accept();
    const conn: Conn = {
      send: (d) => server.send(d),
      close: (code, reason) => server.close(code, reason),
    };
    const queue: Uint8Array[] = [];
    let joined = false;
    // 受信は順番どおりに処理する（Blob の読み出しが非同期のため）。例外で部屋ごと落ちないようにする
    let chain = Promise.resolve();
    server.addEventListener("message", (e: MessageEvent) => {
      chain = chain
        .then(async () => {
          const data = await toBytes(e.data);
          if (!data) return;
          if (joined) room.message(conn, data);
          else queue.push(data);
        })
        .catch((err) => {
          console.error("bad message", err);
          server.close(1011, "bad message");
        });
    });
    const leave = () => void room.leave(conn)?.catch((err) => console.error("flush on leave failed", err));
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);
    room.join(conn).then(
      () => {
        joined = true;
        try {
          for (const d of queue.splice(0)) room.message(conn, d);
        } catch (err) {
          console.error("bad message", err);
          server.close(1011, "bad message");
        }
      },
      (err) => {
        console.error("join failed", err);
        // 理由は 123 バイトまで。日本語は 3 バイトなので短く切る
        server.close(1011, `load failed: ${errorText(err)}`.slice(0, 40));
      },
    );
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** WebSocket の受信データをバイト列にする（ArrayBuffer / Blob / ビューのどれでも） */
export async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (typeof data === "string") return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}
