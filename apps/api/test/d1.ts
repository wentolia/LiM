import { afterEach } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "../src/repo";

// 本物の D1 のローカル実装（wrangler の getPlatformProxy）で、テストごとに空の DB を使う
const proxies: { dispose(): Promise<void> }[] = [];
export async function freshD1(): Promise<D1Database> {
  const p = await getPlatformProxy<{ DB: D1Database }>({ configPath: new URL("./d1.jsonc", import.meta.url).pathname, persist: false });
  proxies.push(p);
  return p.env.DB;
}
afterEach(async () => { await Promise.all(proxies.splice(0).map((p) => p.dispose())); });
