/* Google OAuth（サーバー側の認可コードフロー） */

export const BASIC_SCOPE = "openid email profile";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenResult {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface IdClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  aud: string;
}

/** Google とのやりとり。テストではフェイクに差し替える */
export interface Google {
  authUrl(state: string, withDrive: boolean): string;
  exchange(code: string): Promise<TokenResult>;
  refresh(refreshToken: string): Promise<TokenResult>;
}

export function decodeIdToken(idToken: string): IdClaims {
  const part = idToken.split(".")[1];
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class GoogleOAuth implements Google {
  constructor(private cfg: GoogleConfig, private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  authUrl(state: string, withDrive: boolean): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: withDrive ? `${BASIC_SCOPE} ${DRIVE_SCOPE}` : BASIC_SCOPE,
      state,
      include_granted_scopes: "true",
    });
    if (withDrive) {
      // 管理者のドライブ接続：サーバーが後から使えるよう refresh_token をもらう
      p.set("access_type", "offline");
      p.set("prompt", "consent");
    } else {
      p.set("prompt", "select_account");
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  private async token(body: Record<string, string>): Promise<TokenResult> {
    const res = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }),
    });
    if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<TokenResult>;
  }

  exchange(code: string) {
    return this.token({ code, grant_type: "authorization_code", redirect_uri: this.cfg.redirectUri });
  }

  refresh(refreshToken: string) {
    return this.token({ refresh_token: refreshToken, grant_type: "refresh_token" });
  }
}
