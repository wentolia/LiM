import { ConflictError, markdownCodec, Origin, type Codec, type StoreEntry } from "@lim/core";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/*
 * 共同編集の部屋（ドライブ上の 1 ファイル = 1 部屋）。y-websocket と同じやりとり（sync / awareness）で
 * 参加者の変更を配り、数秒おきにファイルへ書き出す。
 * ファイルの形式と Y.Doc の対応は core の Codec が決める（今は markdownCodec。表やボードなどは Codec を足すだけ）。
 * Durable Object からも、テストからも使えるよう、外の世界は Deps で受け取る。
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
export const FLUSH_DELAY = 3000;

/** 部屋が使うドライブの操作（1 ファイル分） */
export interface RoomFile {
  stat(): Promise<StoreEntry | null>;
  read(): Promise<string>;
  write(text: string, ifRevision: string): Promise<StoreEntry>;
}

/** 部屋の状態の保存先（Durable Object のストレージ） */
export interface RoomStorage {
  get(): Promise<{ ystate?: Uint8Array; revision?: string; base?: string } | undefined>;
  put(v: { ystate: Uint8Array; revision: string; base: string }): Promise<void>;
}

export interface Conn {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RoomDeps {
  file: RoomFile;
  codec?: Codec;
  storage: RoomStorage;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export class Room {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  private conns = new Map<Conn, Set<number>>();
  private codec: Codec;
  /** ドライブと一致している最後の内容（ファイル全体）と revision */
  private base = "";
  private revision = "";
  private ready: Promise<void> | null = null;
  private timer: unknown = null;
  private flushing: Promise<void> | null = null;
  /** ファイルが消えた（改名・削除された）ら書き出しをやめる */
  gone = false;

  constructor(private deps: RoomDeps) {
    this.codec = deps.codec ?? markdownCodec;
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns.keys()) if (c !== origin) this.safeSend(c, msg);
      if (origin !== Origin.drive && origin !== Origin.load) this.schedule();
    });
    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const ids = this.conns.get(origin as Conn);
      if (ids) {
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns.keys()) this.safeSend(c, msg);
    });
  }

  private safeSend(c: Conn, msg: Uint8Array) {
    try {
      c.send(msg);
    } catch {
      this.leave(c);
    }
  }

  /** 部屋を開く：保存済みの状態とドライブの最新を突き合わせる */
  load(): Promise<void> {
    this.ready ??= (async () => {
      const saved = await this.deps.storage.get();
      const stat = await this.deps.file.stat();
      if (!stat) {
        this.gone = !!saved?.revision;
        return;
      }
      const raw = saved?.revision === stat.revision && saved.base !== undefined ? saved.base : await this.deps.file.read();
      this.base = raw;
      this.revision = stat.revision;
      if (saved?.ystate) Y.applyUpdate(this.doc, saved.ystate, "load");
      // 前回から外で（別のアプリや旧方式で）書き換えられていたら、その内容に合わせる
      this.doc.transact(() => this.codec.load(this.doc, raw), Origin.load);
    })();
    // 失敗したら次の接続でやり直す（失敗を覚えたままにしない）
    const ready = this.ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  async join(conn: Conn): Promise<void> {
    await this.load();
    this.conns.set(conn, new Set());
    if (this.gone) {
      conn.close(4404, "gone");
      this.conns.delete(conn);
      return;
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      conn.send(encoding.toUint8Array(a));
    }
  }

  message(conn: Conn, data: Uint8Array): void {
    if (!this.conns.has(conn)) return;
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), conn);
    }
  }

  /** 退出。最後の 1 人が抜けたらすぐ書き出す */
  leave(conn: Conn): Promise<void> | undefined {
    const ids = this.conns.get(conn);
    if (!ids) return;
    this.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0) return this.flush();
  }

  get size() {
    return this.conns.size;
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush().catch((e) => console.error("flush failed", e));
    }, FLUSH_DELAY);
  }

  /** 本文をドライブへ書き出す。他で書き換えられていたら 3-way マージして合わせる */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    // 書き出し中なら、終わってからもう一度
    const run = async () => {
      if (this.flushing) await this.flushing.catch(() => {});
      await this.flushOnce();
    };
    const p = run();
    this.flushing = p.finally(() => {
      if (this.flushing === p) this.flushing = null;
    });
    return p;
  }

  private async flushOnce(): Promise<void> {
    if (this.gone || !this.ready) return;
    await this.ready;
    for (let attempt = 0; attempt < 4; attempt++) {
      const text = this.codec.save(this.doc);
      if (text === this.base) return;
      try {
        const e = await this.deps.file.write(text, this.revision);
        this.base = text;
        this.revision = e.revision;
        await this.deps.storage.put({ ystate: Y.encodeStateAsUpdate(this.doc), revision: this.revision, base: this.base });
        return;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        if (err.current === "") {
          // 改名・削除された：この部屋は閉じる
          this.gone = true;
          for (const c of [...this.conns.keys()]) c.close(4404, "gone");
          this.conns.clear();
          return;
        }
        const theirs = await this.deps.file.read();
        this.doc.transact(() => this.codec.rebase(this.doc, this.base, theirs), Origin.drive);
        this.base = theirs;
        this.revision = err.current;
      }
    }
  }
}
