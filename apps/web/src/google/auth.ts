import { DRIVE_SCOPE } from "../config";

/* Google Identity Services（GIS）のトークンクライアントを使う。
 * サーバーを持たず、ブラウザから直接ドライブ API を呼ぶ。トークンは約1時間で失効する。 */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let scriptLoading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  scriptLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google のログイン部品を読み込めませんでした"));
    document.head.appendChild(s);
  });
  return scriptLoading;
}

const HINT_KEY = "lim:login-hint";

export class GoogleAuth {
  private token: string | null = null;
  private expiresAt = 0;
  private client: TokenClient | null = null;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

  constructor(private clientId: string) {}

  private async ensureClient(): Promise<TokenClient> {
    await loadScript();
    this.client ??= window.google!.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      callback: (r) => {
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        if (r.error || !r.access_token) {
          p.reject(new Error(r.error_description || r.error || "ログインできませんでした"));
          return;
        }
        this.token = r.access_token;
        this.expiresAt = Date.now() + ((r.expires_in ?? 3600) - 60) * 1000;
        p.resolve(r.access_token);
      },
      error_callback: (e) => {
        const p = this.pending;
        this.pending = null;
        p?.reject(new Error(e.type === "popup_closed" ? "ログインがキャンセルされました" : e.message || e.type));
      },
    });
    return this.client;
  }

  /** ボタン操作から呼ぶ。初回は同意画面、2回目以降は確認なしで発行される */
  async signIn(): Promise<string> {
    const client = await this.ensureClient();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      const hint = localStorage.getItem(HINT_KEY) ?? undefined;
      client.requestAccessToken({ prompt: hint ? "" : "consent", hint });
    });
  }

  rememberUser(email: string): void {
    localStorage.setItem(HINT_KEY, email);
  }

  /** 有効なトークン。失効していたら再取得を試みる（ポップアップが出る場合がある） */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    return this.signIn();
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  signOut(): void {
    if (this.token) window.google?.accounts.oauth2.revoke(this.token);
    this.token = null;
    this.expiresAt = 0;
    localStorage.removeItem(HINT_KEY);
  }

  lastUser(): string | null {
    return localStorage.getItem(HINT_KEY);
  }
}
