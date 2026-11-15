/*
 * ドライブの鍵（refresh_token / access_token）を D1 に置く前に暗号化する（決定 0002）
 *
 * - AES-GCM 256 ビット。鍵は Worker のシークレット DRIVE_TOKEN_KEY（32 バイトの乱数の base64）
 * - 保存の形：v1.<IV の base64url>.<暗号文と認証タグの base64url>
 * - 付加データ（AAD）に「表:行:列」を入れ、別の行や列へ移し替えた暗号文は読めないようにする
 */

export interface TokenCipher {
  encrypt(plain: string, aad: string): Promise<string>;
  /** 読めなければ（鍵の取り違え・改ざん・形の違い）null */
  decrypt(stored: string, aad: string): Promise<string | null>;
}

const PREFIX = "v1.";
export const isEncrypted = (v: string) => v.startsWith(PREFIX);

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** 鍵の文字列をちょうど 32 バイトとして読む。違えば null */
function keyBytes(secret: string): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = fromB64(secret);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

async function makeCipher(raw: Uint8Array<ArrayBuffer>): Promise<TokenCipher> {
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async encrypt(plain, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12)); // 毎回新しく作る
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plain));
      return `${PREFIX}${toB64url(iv)}.${toB64url(new Uint8Array(ct))}`;
    },
    async decrypt(stored, aad) {
      if (!isEncrypted(stored)) return null;
      const [, iv, ct, extra] = stored.split(".");
      if (!iv || !ct || extra !== undefined) return null;
      try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(aad) }, key, fromB64(ct));
        return dec.decode(pt);
      } catch {
        return null;
      }
    },
  };
}

const cache = new Map<string, Promise<TokenCipher>>();
let warned = false;

/** 登録したのに形が違う鍵。黙って平文に戻らないよう、サーバーは 503 を返す（決定 0002） */
export class BadTokenKey extends Error {
  constructor() { super("サーバーの設定（DRIVE_TOKEN_KEY）が正しくありません。32 バイトの乱数の base64 を登録してください"); }
}

/**
 * シークレットから暗号器を作る（実行環境ごとに 1 回）。
 * 未登録（空）なら null：移行期間として今までどおり平文で動く。登録してあるのに 32 バイトでなければ BadTokenKey を投げる
 */
export async function tokenCipher(secret: string | undefined): Promise<TokenCipher | null> {
  const id = secret?.trim() ?? "";
  if (!id) {
    if (!warned) {
      warned = true;
      console.warn("DRIVE_TOKEN_KEY がありません。ドライブの鍵を暗号化せずに保存します");
    }
    return null;
  }
  let c = cache.get(id);
  if (!c) {
    const raw = keyBytes(id);
    if (!raw) throw new BadTokenKey();
    cache.set(id, (c = makeCipher(raw)));
  }
  return c;
}
