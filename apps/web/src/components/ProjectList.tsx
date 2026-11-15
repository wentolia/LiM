import { useState } from "react";
import { loginUrl, type Me, type ProjectInfo } from "../api";

interface Props {
  me: Me;
  projects: ProjectInfo[];
  onOpen: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}

const ROLE: Record<string, string> = { owner: "管理者", member: "メンバー" };

/** プロジェクト一覧。ページ一覧と同じタイル表示 */
export function ProjectList({ me, projects, onOpen, onCreate }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="toolbar">
        <span className="text">プロジェクト</span>
        <span className="text">{projects.length} 件</span>
        {me.driveConnected ? (
          <form className="create right" onSubmit={submit}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新しいプロジェクト名" aria-label="新しいプロジェクト名" />
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              ＋ 作る
            </button>
          </form>
        ) : (
          <a className="primary right" href={loginUrl(true)}>
            ドライブを接続してプロジェクトを作る
          </a>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {projects.length === 0 ? (
        <div className="empty">
          {me.driveConnected
            ? "まだプロジェクトがありません。名前を入れて作ってください。"
            : "参加しているプロジェクトはありません。管理者に、このメールアドレス（" + me.email + "）を招待してもらってください。自分で作る場合は、右上からドライブを接続してください。"}
        </div>
      ) : (
        <div className="gallery">
          {projects.map((p) => (
            <button key={p.id} type="button" className="tile project" onClick={() => onOpen(p.id)}>
              <span className="t">{p.name}</span>
              <span className="x">{ROLE[p.role]}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
