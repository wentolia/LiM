export type SaveState = "saved" | "saving" | "error";

export interface Connection {
  /** 保存先の表示名 */
  place: string;
  /** ログイン中のユーザー表示（未ログインなら null） */
  user: string | null;
  onLogout?: () => void;
}

interface Props {
  save: SaveState;
  pageCount: number;
  conn: Connection;
  /** ブラウザ内モードからログインへ進む */
  onLogin?: () => void;
  onHome: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = { saved: "保存済み", saving: "保存中…", error: "保存できませんでした" };

/** 接続情報だけを示すヘッダー */
export function Header({ save, pageCount, conn, onLogin, onHome }: Props) {
  return (
    <header className="header">
      <button type="button" className="brand" onClick={onHome}>
        LIM
      </button>
      <div className="info">
        <span className="cell">
          <span className={`lamp ${save}`} aria-hidden="true" />
          保存先 {conn.place}
        </span>
        <span className={save === "error" ? "cell alert" : "cell"}>{SAVE_LABEL[save]}</span>
        <span className="cell">{pageCount} ページ</span>
        <span className="cell user">{conn.user ?? "未ログイン"}</span>
        {conn.onLogout && (
          <button type="button" className="cell logout" onClick={conn.onLogout}>
            ログアウト
          </button>
        )}
        {onLogin && (
          <button type="button" className="cell logout" onClick={onLogin}>
            ログイン
          </button>
        )}
      </div>
    </header>
  );
}
