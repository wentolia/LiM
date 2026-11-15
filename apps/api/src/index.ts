import { createApp, defaultOpenDrive } from "./app";
import { GoogleOAuth } from "./google";
import { D1Repo, type D1Database } from "./repo";

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.GOOGLE_CLIENT_SECRET) {
      return Response.json({ error: "サーバーの設定（GOOGLE_CLIENT_SECRET）がまだです" }, { status: 503 });
    }
    const app = createApp({
      repo: new D1Repo(env.DB),
      google: new GoogleOAuth({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: `${url.origin}/api/auth/callback`,
      }),
      clientId: env.GOOGLE_CLIENT_ID,
      openDrive: defaultOpenDrive,
    });
    return app(req);
  },
};
