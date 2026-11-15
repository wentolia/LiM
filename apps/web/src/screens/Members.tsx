import { useEffect, useState } from "react";
import { api, type ApiStore, type MemberInfo, type ProjectInfo, type Workspace } from "@lim/client";
import { DataPanel } from "../features/data/DataPanel";

interface Props {
  project: ProjectInfo;
  /** 開いているプロジェクトのページ（読み込み中は null） */
  data: { ws: Workspace; store: ApiStore } | null;
  onBack: () => void;
}

/** メンバー一覧と招待。招待はメールアドレスを登録するだけで、その人が Google でログインすると参加できる */
export function Members({ project, data, onBack }: Props) {
  const [list, setList] = useState<MemberInfo[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const owner = project.role === "owner";

  const run = async (f: () => Promise<MemberInfo[]>) => {
    setError(null);
    try {
      setList(await f());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  useEffect(() => {
    void run(() => api.members(project.id));
  }, [project.id]);

  return (
    <>
      <div className="toolbar">
        <button type="button" className="back" onClick={onBack}>
          ← ページ一覧
        </button>
        <span className="text">メンバー {list.length} 人</span>
        {owner && (
          <form
            className="create right"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api.addMember(project.id, email))) setEmail("");
            }}
          >
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="招待する人のメールアドレス" aria-label="招待する人のメールアドレス" required />
            <button type="submit" className="primary">
              ＋ 招待
            </button>
          </form>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      <main className="sheet">
        <table className="table members">
          <thead>
            <tr>
              <th>メールアドレス</th>
              <th>役割</th>
              <th>追加日</th>
              {owner && <th />}
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.email}>
                <td>{m.email}</td>
                <td>{m.role === "owner" ? "管理者" : "メンバー"}</td>
                <td>{m.added_at.slice(0, 10)}</td>
                {owner && (
                  <td>
                    {m.role !== "owner" && (
                      <button type="button" className="plain" onClick={() => void run(() => api.removeMember(project.id, m.email))}>
                        外す
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {owner && (
          <p className="note">
            招待した人には、このアプリのアドレス（{window.location.origin}）を伝えてください。そのメールアドレスの Google アカウントでログインすると、このプロジェクトが表示されます。ページは管理者のドライブに保存されます。
          </p>
        )}
        {data ? (
          <DataPanel projectId={project.id} projectName={project.name} owner={owner} ws={data.ws} store={data.store} />
        ) : (
          <p className="note">ページを読み込むと、データの書き出しなどがここに出ます。</p>
        )}
      </main>
    </>
  );
}
