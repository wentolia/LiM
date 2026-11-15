import { describe, expect, it } from "vitest";
import { ConflictError, type StoreEntry } from "@lim/core";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Room, type Conn } from "../src/room";

/** ドライブ上の 1 ファイルのフェイク */
function fakeFile(initial: string | null) {
  const f = { text: initial, rev: initial === null ? 0 : 1, writes: 0 };
  const entry = (): StoreEntry => ({ path: "pages/x.md", revision: String(f.rev), updatedAt: "", size: 0 });
  return {
    f,
    file: {
      stat: async () => (f.text === null ? null : entry()),
      read: async () => f.text ?? "",
      write: async (text: string, ifRevision: string) => {
        const cur = f.text === null ? "" : String(f.rev);
        if (cur !== ifRevision) throw new ConflictError("pages/x.md", cur);
        f.text = text;
        f.rev++;
        f.writes++;
        return entry();
      },
    },
  };
}

function setup(initial: string | null) {
  const { f, file } = fakeFile(initial);
  let saved: { ystate: Uint8Array; revision: string; base: string } | undefined;
  const timers: (() => void)[] = [];
  const room = new Room({
    file,
    storage: { get: async () => saved, put: async (v) => void (saved = v) },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  /** y-websocket のクライアント相当 */
  async function client() {
    const doc = new Y.Doc();
    const conn: Conn = {
      send: (data) => {
        const dec = decoding.createDecoder(data);
        if (decoding.readVarUint(dec) !== 0) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, room);
        if (encoding.length(enc) > 1) room.message(conn, encoding.toUint8Array(enc));
      },
      close: () => {},
    };
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === room) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      room.message(conn, encoding.toUint8Array(enc));
    });
    await room.join(conn);
    // クライアント側からも sync step1 を送る
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    room.message(conn, encoding.toUint8Array(enc));
    return { doc, text: doc.getText("body"), conn };
  }
  const tick = async () => {
    for (const t of timers.splice(0)) t();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { f, room, client, tick, saved: () => saved };
}

describe("共同編集の部屋", () => {
  it("ドライブの本文で始まり、2 人の入力が互いに届く", async () => {
    const s = setup("---\n担当: A\n---\nこんにちは");
    const a = await s.client();
    const b = await s.client();
    expect(a.text.toString()).toBe("こんにちは");
    a.text.insert(5, "、Aです");
    b.text.insert(0, "Bより：");
    expect(a.text.toString()).toBe("Bより：こんにちは、Aです");
    expect(b.text.toString()).toBe(a.text.toString());
  });

  it("数秒後にドライブへ書き出し、プロパティは保つ", async () => {
    const s = setup("---\n担当: A\n---\n本文");
    const a = await s.client();
    a.text.insert(2, "です");
    await s.tick();
    expect(s.f.text).toBe("---\n担当: A\n---\n本文です");
    expect(s.saved()?.revision).toBe("2");
  });

  it("最後の人が抜けたらすぐ書き出す", async () => {
    const s = setup("a");
    const a = await s.client();
    a.text.insert(1, "b");
    await s.room.leave(a.conn);
    expect(s.f.text).toBe("ab");
  });

  it("ドライブ側が別に書き換えられていたらマージして書き出す", async () => {
    const s = setup("1行目\n2行目");
    const a = await s.client();
    a.text.insert(a.text.length, "（追記）");
    s.f.text = "1行目（外で編集）\n2行目";
    s.f.rev++;
    await s.tick();
    expect(s.f.text).toBe("1行目（外で編集）\n2行目（追記）");
    expect(a.text.toString()).toBe("1行目（外で編集）\n2行目（追記）");
  });

  it("ファイルが消えていたら（改名・削除）書き出さずに閉じる", async () => {
    const s = setup("a");
    const a = await s.client();
    a.text.insert(1, "b");
    s.f.text = null;
    await s.tick();
    expect(s.f.text).toBe(null);
    expect(s.room.gone).toBe(true);
  });

  it("保存済みの状態から再開しても、外での変更を取り込む", async () => {
    const s = setup("old");
    const a = await s.client();
    a.text.insert(3, "!");
    await s.room.leave(a.conn);
    const saved = s.saved()!;
    s.f.text = "new from drive";
    s.f.rev++;
    const room2 = new Room({
      file: { stat: async () => ({ path: "", revision: String(s.f.rev), updatedAt: "", size: 0 }), read: async () => s.f.text!, write: async () => { throw new Error("x"); } },
      storage: { get: async () => saved, put: async () => {} },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await room2.load();
    expect(room2.doc.getText("body").toString()).toBe("new from drive");
  });
});
