import { describe, expect, it, vi } from "vitest";
import { createApp, ownerAccessToken } from "../src/app";
import type { Google } from "../src/google";
import { D1Repo, type D1Database } from "../src/repo";
import { BadTokenKey, isEncrypted, tokenCipher } from "../src/tokenCipher";
import { freshD1 } from "./d1";

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const cipher = async (k: string) => (await tokenCipher(k))!;
const quiet = () => {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => { w.mockRestore(); e.mockRestore(); };
};
const rawRow = (d: D1Database) => d.prepare("SELECT * FROM drive_tokens WHERE user_id = 'u1'").first<Record<string, unknown>>();
const google = (calls: string[]): Google => ({
  authUrl: () => "",
  exchange: async () => { throw new Error("unused"); },
  refresh: async (rt) => { calls.push(rt); return { access_token: `fresh-${rt}`, expires_in: 3600 }; },
});

describe("tokenCipher", () => {
  it("暗号化して戻せる。IV は毎回違う", async () => {
    const c = await cipher(KEY_A);
    const a = await c.encrypt("1//secret", "drive_tokens:u1:refresh_token");
    const b = await c.encrypt("1//secret", "drive_tokens:u1:refresh_token");
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toContain("secret");
    expect(a).not.toBe(b);
    expect(await c.decrypt(a, "drive_tokens:u1:refresh_token")).toBe("1//secret");
  });

  it("別の行・列・鍵では読めず、改ざんも読めない", async () => {
    const c = await cipher(KEY_A);
    const s = await c.encrypt("1//secret", "drive_tokens:u1:refresh_token");
    expect(await c.decrypt(s, "drive_tokens:u2:refresh_token")).toBeNull();
    expect(await c.decrypt(s, "drive_tokens:u1:access_token")).toBeNull();
    expect(await (await cipher(KEY_B)).decrypt(s, "drive_tokens:u1:refresh_token")).toBeNull();
    expect(await c.decrypt(s.slice(0, -2) + (s.endsWith("A") ? "BB" : "AA"), "drive_tokens:u1:refresh_token")).toBeNull();
    expect(await c.decrypt("1//plain", "drive_tokens:u1:refresh_token")).toBeNull();
  });

  it("未登録なら null（移行期間：平文で動く）。前後の空白は無視する", async () => {
    const restore = quiet();
    expect(await tokenCipher(undefined)).toBeNull();
    expect(await tokenCipher(" \n")).toBeNull();
    restore();
    expect(await tokenCipher(` ${KEY_A}\n`)).not.toBeNull();
  });

  it("登録したのに 32 バイトの base64 でなければ投げる（黙って平文に戻らない）", async () => {
    await expect(tokenCipher(btoa("short"))).rejects.toBeInstanceOf(BadTokenKey);
    await expect(tokenCipher("not base64 !!")).rejects.toBeInstanceOf(BadTokenKey);
    await expect(tokenCipher(`"${KEY_A}"`)).rejects.toBeInstanceOf(BadTokenKey);
  });
});

describe("D1Repo のドライブの鍵（ローカルの D1）", { timeout: 20_000 }, () => {
  it("鍵があれば暗号化して保存し、読むときに戻す", async () => {
    const d = await freshD1();
    const repo = new D1Repo(d, await cipher(KEY_A));
    await repo.putDriveToken({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
    const raw = await rawRow(d);
    expect(isEncrypted(raw!.refresh_token as string)).toBe(true);
    expect(isEncrypted(raw!.access_token as string)).toBe(true);
    expect(raw!.expires_at).toBe(5);
    expect(await repo.getDriveToken("u1")).toEqual({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
  });

  it("平文の行は、読んだときに暗号化して書き戻す（access_token は捨てる）。何度読んでも同じ", async () => {
    const d = await freshD1();
    await new D1Repo(d, null).putDriveToken({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
    const repo = new D1Repo(d, await cipher(KEY_A));
    expect(await repo.getDriveToken("u1")).toEqual({ user_id: "u1", refresh_token: "1//rt", access_token: null, expires_at: null });
    const raw = await rawRow(d);
    expect(isEncrypted(raw!.refresh_token as string)).toBe(true);
    expect(raw!.access_token).toBeNull();
    expect(await repo.getDriveToken("u1")).toEqual({ user_id: "u1", refresh_token: "1//rt", access_token: null, expires_at: null });
  });

  it("書き戻しは、その間に別の書き込みがあれば上書きしない", async () => {
    const d = await freshD1();
    const plain = new D1Repo(d, null);
    await plain.putDriveToken({ user_id: "u1", refresh_token: "1//old", access_token: null, expires_at: null });
    // 読んだ直後（書き戻しの直前）に、古いコードが新しい鍵を書いたとする
    let once = true;
    const racing: D1Database = {
      batch: (stmts) => d.batch(stmts),
      prepare: (sql) => {
        if (once && sql.startsWith("UPDATE drive_tokens")) {
          once = false;
          return { ...d.prepare(sql), bind: (...v: unknown[]) => ({ ...d.prepare(sql).bind(...v), run: async () => {
            await d.prepare("UPDATE drive_tokens SET refresh_token = '1//new' WHERE user_id = 'u1'").run();
            return d.prepare(sql).bind(...v).run();
          } }) } as never;
        }
        return d.prepare(sql);
      },
    };
    const repo = new D1Repo(racing, await cipher(KEY_A));
    await repo.getDriveToken("u1");
    expect((await rawRow(d))!.refresh_token).toBe("1//new");
  });

  it("読めない行（別の鍵）は未接続と同じ扱いにし、接続し直せば読める", async () => {
    const d = await freshD1();
    await new D1Repo(d, await cipher(KEY_B)).putDriveToken({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
    const repo = new D1Repo(d, await cipher(KEY_A));
    const restore = quiet();
    expect(await repo.getDriveToken("u1")).toBeNull();
    await expect(ownerAccessToken(repo, google([]), "u1", 0)).rejects.toThrow("管理者のドライブが接続されていません");
    restore();
    // 接続し直し（/api/auth/callback が put する）
    await repo.putDriveToken({ user_id: "u1", refresh_token: "1//again", access_token: "ya29.new", expires_at: 5 });
    expect((await repo.getDriveToken("u1"))!.refresh_token).toBe("1//again");
  });

  it("鍵が未登録の間は平文で読み書きする。暗号文の行は未接続と同じ扱い", async () => {
    const d = await freshD1();
    const plain = new D1Repo(d, null);
    await plain.putDriveToken({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
    expect((await rawRow(d))!.refresh_token).toBe("1//rt");
    expect(await plain.getDriveToken("u1")).toEqual({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.at", expires_at: 5 });
    await new D1Repo(d, await cipher(KEY_A)).getDriveToken("u1"); // 暗号化される
    const restore = quiet();
    expect(await plain.getDriveToken("u1")).toBeNull();
    restore();
  });

  it("暗号化への移行で管理者の接続が切れない：次の利用で 1 回だけ更新し、以後は保存した鍵を使う", async () => {
    const d = await freshD1();
    await new D1Repo(d, null).putDriveToken({ user_id: "u1", refresh_token: "1//rt", access_token: "ya29.old", expires_at: 10_000_000 });
    const repo = new D1Repo(d, await cipher(KEY_A));
    const calls: string[] = [];
    expect(await ownerAccessToken(repo, google(calls), "u1", 0)).toBe("fresh-1//rt");
    expect(await ownerAccessToken(repo, google(calls), "u1", 1000)).toBe("fresh-1//rt");
    expect(calls).toEqual(["1//rt"]);
    const raw = await rawRow(d);
    expect(isEncrypted(raw!.access_token as string)).toBe(true);
  });

  it("読めない行があっても、管理者は画面を開けて（未接続と表示）、ドライブを接続し直せる", async () => {
    const d = await freshD1();
    await new D1Repo(d, await cipher(KEY_B)).putDriveToken({ user_id: "alice", refresh_token: "1//old", access_token: null, expires_at: null });
    const repo = new D1Repo(d, await cipher(KEY_A));
    let seq = 0;
    let drive = false;
    const app = createApp({
      repo, clientId: "cid", now: () => 1_000_000, randomId: () => `r${++seq}abcdefghijkl`,
      openDrive: () => ({ findFolder: async () => undefined }) as never, // 以前のフォルダは無い
      google: {
        authUrl: (state) => `https://accounts.google.com/auth?state=${state}`,
        refresh: async () => { throw new Error("unused"); },
        exchange: async () => ({
          access_token: "ya29.new", expires_in: 3600,
          ...(drive ? { refresh_token: "1//new", scope: "openid https://www.googleapis.com/auth/drive.file" } : {}),
          id_token: `x.${btoa(JSON.stringify({ sub: "alice", email: "alice@example.com", name: "A", aud: "cid", email_verified: true })).replace(/=+$/, "")}.y`,
        }),
      },
    });
    const login = async (withDrive: boolean) => {
      drive = withDrive;
      const start = await app(new Request(`https://x/api/auth/login${withDrive ? "?drive=1" : ""}`));
      const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
      const cb = await app(new Request(`https://x/api/auth/callback?code=c&state=${state}`, { headers: { Cookie: `oauth_state=${state}` } }));
      expect(cb.status).toBe(302);
      return cb.headers.get("Set-Cookie")!.match(/sid=([^;]+)/)![1];
    };
    const me = async (sid: string) => (await app(new Request("https://x/api/me", { headers: { Cookie: `sid=${sid}` } }))).json() as Promise<{ driveConnected: boolean }>;

    const restore = quiet();
    expect((await me(await login(false))).driveConnected).toBe(false);
    expect((await me(await login(true))).driveConnected).toBe(true);
    restore();
    expect(await repo.getDriveToken("alice")).toEqual({ user_id: "alice", refresh_token: "1//new", access_token: "ya29.new", expires_at: 1_000_000 + 3600_000 });
  });
});
