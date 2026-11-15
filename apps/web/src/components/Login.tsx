import { Header } from "./Header";

interface Props {
  error: string | null;
  /** サーバーが使えないとき（ローカル開発など）は Google ログインを出さない */
  serverReady: boolean;
  onLogin: () => void;
  onLocal: () => void;
}

/** ログイン画面：Google でログインするか、このブラウザだけで使うかを選ぶ */
export function Login({ error, serverReady, onLogin, onLocal }: Props) {
  return (
    <div className="app">
      <Header place="未接続" user={null} onHome={() => {}} />
      <main className="sheet">
        <section className="box">
          <h1>ログイン</h1>
          <p>Google アカウントでログインすると、招待されたプロジェクトのページを読み書きできます。</p>
          <p className="note">ページはプロジェクト管理者の Google ドライブに、Markdown ファイルとして保存されます。</p>
          <button type="button" className="primary" onClick={onLogin} disabled={!serverReady}>
            Google でログイン
          </button>
          {!serverReady && <p className="error">サーバーにつながらないため、ログインできません。</p>}
          {error && <p className="error">{error}</p>}
          <button type="button" className="plain" onClick={onLocal}>
            ログインせずにこのブラウザだけで使う
          </button>
        </section>
      </main>
    </div>
  );
}
