interface Props {
  busy: boolean;
  error: string | null;
  /** 前回ログインしたアカウント（あれば） */
  lastUser: string | null;
  onLogin: () => void;
  onLocal: () => void;
}

/** ログイン画面：Google ドライブにつなぐか、このブラウザだけで使うかを選ぶ */
export function Login({ busy, error, lastUser, onLogin, onLocal }: Props) {
  return (
    <div className="app">
      <header className="header">
        <span className="brand">SABAKAN</span>
        <div className="info">
          <span className="cell">保存先 未接続</span>
          <span className="cell user">未ログイン</span>
        </div>
      </header>
      <main className="login">
        <section className="login-box">
          <h1>ログイン</h1>
          <p>ページは Google ドライブの「マイドライブ / SABAKAN」フォルダに、Markdown ファイルとして保存されます。</p>
          <p className="note">SABAKAN が作ったファイル以外は読み書きしません。</p>
          <button type="button" className="primary" onClick={onLogin} disabled={busy}>
            {busy ? "接続中…" : lastUser ? `${lastUser} で続ける` : "Google でログイン"}
          </button>
          {error && <p className="error">{error}</p>}
          <button type="button" className="plain" onClick={onLocal} disabled={busy}>
            ログインせずにこのブラウザだけで使う
          </button>
        </section>
      </main>
    </div>
  );
}
