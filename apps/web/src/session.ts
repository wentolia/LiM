import type { Store } from "@lim/core";
import { GOOGLE_CLIENT_ID, ROOT_FOLDER } from "./config";
import { GoogleAuth } from "./google/auth";
import { seedIfEmpty } from "./seed";
import { DriveStore } from "./store/driveStore";
import { LocalStorageStore } from "./store/localStore";
import { Workspace } from "./workspace";
import type { Connection } from "./components/Header";

export interface Session {
  ws: Workspace;
  conn: Connection;
}

export const driveEnabled = GOOGLE_CLIENT_ID !== "";
export const auth = driveEnabled ? new GoogleAuth(GOOGLE_CLIENT_ID) : null;

const MODE_KEY = "lim:mode";
export const lastMode = (): string | null => localStorage.getItem(MODE_KEY);

/** 保存先が空なら、別の保存先のページを写す（初回ログイン時にブラウザ内のページを引き継ぐ） */
export async function copyIfEmpty(from: Store, to: Store): Promise<number> {
  if ((await to.list("pages/")).length > 0) return 0;
  const entries = (await from.list("pages/")).filter((e) => e.path.endsWith(".md"));
  // 古い順に書くと、ドライブ上の更新日時も元の並びに近くなる
  entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const e of entries) await to.write(e.path, await from.read(e.path), "text/markdown");
  return entries.length;
}

export async function openLocal(): Promise<Session> {
  const store = new LocalStorageStore();
  await seedIfEmpty(store);
  const ws = new Workspace(store);
  await ws.load();
  localStorage.setItem(MODE_KEY, "local");
  return { ws, conn: { place: "このブラウザ", user: null } };
}

export async function openDrive(onLogout: () => void): Promise<Session> {
  if (!auth) throw new Error("Google ドライブ連携が設定されていません");
  await auth.signIn();
  const store = new DriveStore(() => auth.getToken(), ROOT_FOLDER, undefined, () => auth.invalidate());
  const user = await store.user();
  auth.rememberUser(user.email);

  const local = new LocalStorageStore();
  await seedIfEmpty(local);
  await copyIfEmpty(local, store);

  const ws = new Workspace(store);
  await ws.load();
  localStorage.setItem(MODE_KEY, "drive");
  return {
    ws,
    conn: {
      place: `Google ドライブ（マイドライブ/${ROOT_FOLDER}）`,
      user: user.email,
      onLogout: () => {
        auth.signOut();
        localStorage.removeItem(MODE_KEY);
        onLogout();
      },
    },
  };
}
