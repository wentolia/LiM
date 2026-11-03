interface Props {
  saving: boolean;
  pageCount: number;
  onHome: () => void;
}

/** 接続情報だけを示すヘッダー */
export function Header({ saving, pageCount, onHome }: Props) {
  return (
    <header className="header">
      <button type="button" className="brand" onClick={onHome}>
        LIM
      </button>
      <div className="info">
        <span className="cell">
          <span className={saving ? "lamp busy" : "lamp"} aria-hidden="true" />
          保存先 このブラウザ
        </span>
        <span className="cell">{saving ? "保存中…" : "保存済み"}</span>
        <span className="cell">{pageCount} ページ</span>
        <span className="cell user">未ログイン</span>
      </div>
    </header>
  );
}
