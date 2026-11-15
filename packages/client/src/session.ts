import { ApiStore } from "./api";
import { seedIfEmpty } from "./seed";
import { LocalStorageStore } from "./localStore";
import { Workspace } from "./workspace";

const MODE_KEY = "sabakan:mode";
export const lastMode = (): string | null => localStorage.getItem(MODE_KEY);
export const setMode = (m: "local" | "server" | null) =>
  m ? localStorage.setItem(MODE_KEY, m) : localStorage.removeItem(MODE_KEY);

export async function openLocal(): Promise<Workspace> {
  const store = new LocalStorageStore();
  await seedIfEmpty(store);
  const ws = new Workspace(store);
  await ws.load();
  return ws;
}

export async function openProject(id: string): Promise<{ ws: Workspace; store: ApiStore }> {
  const store = new ApiStore(id);
  const ws = new Workspace(store);
  await ws.load();
  return { ws, store };
}
