import { useState } from "react";
import { api, exportProject, importProject, useWorkspace, type ApiStore, type Workspace } from "@lim/client";

interface Props {
  projectId: string;
  projectName: string;
  owner: boolean;
  ws: Workspace;
  store: ApiStore;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** データのまとめた書き出し・取り込みと、ページ番号（id）付け（決定 0004） */
export function DataPanel({ projectId, projectName, owner, ws, store }: Props) {
  useWorkspace(ws);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = ws.missingIds();

  const run = async (label: string, f: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      setResult(await f());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** assets: false はページだけ（そろえる前の控え） */
  const saveExport = async (assets: boolean) => {
    const r = await exportProject(store, { assets, onProgress: (d, t) => setBusy(`書き出し中（${d} / ${t}）`) });
    const name = projectName.replace(/[\\/:*?"<>|]/g, "－");
    download(r.zip, assets ? `${name}-${stamp()}.zip` : `${name}-${stamp()}-ページだけ.zip`);
    return r.renamed.length ? `同じ名前のファイルが ${r.renamed.length} 件あったので、名前に番号を足して入れました。` : "";
  };

  return (
    <section className="data">
      <h2>データ</h2>
      <p className="note">
        すべてのページと画像を、1 つの zip ファイルにまとめて保存できます。中身はドライブのフォルダと同じ形の Markdown ファイルなので、アプリが無くても読めます。ときどき保存しておくと安心です。
      </p>
      <div className="actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => void run("書き出し中", async () => `保存しました。${await saveExport(true)}`)}>
          まとめて書き出す
        </button>
        {owner && (
          <label className={`button${busy ? " disabled" : ""}`}>
            書き出したファイルを取り込む
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              disabled={!!busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run("取り込み中", async () => {
                  const r = await importProject(
                    store,
                    new Uint8Array(await file.arrayBuffer()),
                    ws.list().map((i) => i.page),
                    (d, t) => setBusy(`取り込み中（${d} / ${t}）`),
                  );
                  await ws.load();
                  return [
                    `${r.written.length} 件を取り込みました。`,
                    r.existed.length ? `同じ題名か同じ番号のページ・同じ名前の画像があった ${r.existed.length} 件は、上書きせずに今のほうを残しました。` : "",
                    r.failed.length ? `${r.failed.length} 件は書けませんでした。もう一度取り込むと、残りだけが入ります。` : "",
                    r.ignored.length ? `取り込めない場所のファイル ${r.ignored.length} 件は飛ばしました。` : "",
                  ].join("");
                });
              }}
            />
          </label>
        )}
      </div>
      {owner && (
        <div className="actions">
          <p className="note">
            {missing.paths.length > 0
              ? `${missing.paths.length} 件のページに、変わらない番号（id）がまだありません。番号があると、題名を変えても外から同じページを指せます。`
              : "すべてのページに番号（id）があります。"}
            「そろえる」を押すと、ページだけの控えを保存してから、番号の無いページに番号を付け、フォルダの説明（README.md）を今の版にします。
          </p>
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              void run("そろえています", async () => {
                const note = await saveExport(false);
                const r = await ws.assignIds((d, t) => setBusy(`番号を付けています（${d} / ${t}）`));
                await api.syncReadme(projectId);
                return [
                  `控えを保存し、${r.assigned} 件に番号を付けました。${note}`,
                  r.recent ? `いま編集中などの ${r.recent} 件は、数分おいてからもう一度押すと付きます。` : "",
                  r.failed ? `${r.failed} 件は通信などで付けられませんでした。もう一度押すと続きから付けます。` : "",
                  r.skipped.length ? `先頭の項目の書き方が読めない ${r.skipped.length} 件は飛ばしました。` : "",
                ].join("");
              })
            }
          >
            データを今の形にそろえる
          </button>
        </div>
      )}
      {busy && <p className="note">{busy}…</p>}
      {result && <p className="note">{result}</p>}
      {error && <p className="notice error">{error}</p>}
    </section>
  );
}
