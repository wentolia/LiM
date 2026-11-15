/**
 * Google OAuth クライアント ID（公開して問題ない値。クライアントシークレットは使わない）。
 * ビルド時の環境変数 VITE_GOOGLE_CLIENT_ID が優先。どちらも空ならドライブ連携なし（ブラウザ内保存）で動く。
 */
const FALLBACK_CLIENT_ID = "";

export const GOOGLE_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || FALLBACK_CLIENT_ID;

/** アプリが作ったファイルだけを読み書きできる最小権限 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** マイドライブ直下に作るフォルダ名 */
export const ROOT_FOLDER = "LiM";
