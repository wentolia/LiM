export type SaveState = "saved" | "saving" | "error" | "offline";

interface Props {
  /** 保存先の表示名 */
  place: string;
  /** 開いているプロジェクト（押すとプロジェクト一覧へ） */
  project?: { name: string; onSwitch: () => void; onMembers: () => void };
  save?: SaveState;
  pageCount?: number;
  /** ログイン中のアカウント（未ログインなら null） */
  user: string | null;
  onLogin?: () => void;
  onLogout?: () => void;
  onHome: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "保存済み",
  saving: "保存中…",
  error: "保存できませんでした",
  offline: "接続待ち（入力は再接続後に反映）",
};

/** 接続情報だけを示すヘッダー */
export function Header({ place, project, save, pageCount, user, onLogin, onLogout, onHome }: Props) {
  return (
    <header className="header">
      <button type="button" className="brand" onClick={onHome}>
        SABAKAN
      </button>
      {project && (
        <>
          <button type="button" className="cell project" onClick={project.onSwitch} title="プロジェクトを切り替える">
            {project.name} ▾
          </button>
          <button type="button" className="cell link" onClick={project.onMembers}>
            メンバー
          </button>
        </>
      )}
      <div className="info">
        <span className="cell">
          <span className={`lamp ${save ?? "saved"}`} aria-hidden="true" />
          保存先 {place}
        </span>
        {save && <span className={save === "error" || save === "offline" ? "cell alert" : "cell"}>{SAVE_LABEL[save]}</span>}
        {pageCount !== undefined && <span className="cell">{pageCount} ページ</span>}
        <span className="cell user">{user ?? "未ログイン"}</span>
        {onLogout && (
          <button type="button" className="cell link" onClick={onLogout}>
            ログアウト
          </button>
        )}
        {onLogin && (
          <button type="button" className="cell link" onClick={onLogin}>
            ログイン
          </button>
        )}
      </div>
    </header>
  );
}
