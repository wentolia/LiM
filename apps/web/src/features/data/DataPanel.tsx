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
  /** この画面でページの控えを保存した（そろえる前に必ず取る） */
  const [backedUp, setBackedUp] = useState(false);
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

  const names = (paths: string[]) => paths.slice(0, 3).map((p) => p.split("/").pop()).join("、") + (paths.length > 3 ? " など" : "");

  return (
    <section className="data">
      <h2>データ</h2>
      <p className="note">
        すべてのページと画像を、1 つのファイル（zip）にまとめて保存できます。中身はドライブのフォルダと同じ形のふつうの文書ファイルなので、アプリが無くても読めます。ときどき保存しておくと安心です。
      </p>
      <div className="actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => void run("書き出し中", async () => `ダウンロードしました。${await saveExport(true)}`)}>
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
                  const pages = r.written.filter((p) => p.startsWith("pages/")).length;
                  return [
                    `ページ ${pages} 件と画像 ${r.written.length - pages} 件を取り込みました。`,
                    r.existed.length ? `同じ題名のページなどがすでにあった ${r.existed.length} 件（${names(r.existed)}）は、上書きせずに今のほうを残しました。` : "",
                    r.failed.length ? `${r.failed.length} 件（${names(r.failed)}）は保存できませんでした（画像は 10MB まで）。` : "",
                    r.ignored.length ? `アプリのデータではないファイル ${r.ignored.length} 件は飛ばしました。` : "",
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
              ? `${missing.paths.length} 件のページに、変わらない番号がまだありません。番号があると、題名を変えても外から同じページを指せます。`
              : "すべてのページに番号があります。"}
            そろえる前に、ページの控えを保存してください。保存できたことを確かめてから「番号を付ける」を押すと、番号の無いページに番号を付け、フォルダの説明（README.md）を今の版にします。
          </p>
          <button type="button" disabled={!!busy} onClick={() => void run("控えを作っています", async () => (await saveExport(false), setBackedUp(true), "ページの控えをダウンロードしました。保存できたことを確かめてから、次へ進んでください。"))}>
            1. ページの控えを保存
          </button>
          <button
            type="button"
            disabled={!!busy || !backedUp}
            onClick={() =>
              void run("番号を付けています", async () => {
                const r = await ws.assignIds((d, t) => setBusy(`番号を付けています（${d} / ${t}）`));
                await api.syncReadme(projectId);
                return [
                  `${r.assigned} 件に番号を付け、フォルダの説明を今の版にしました。`,
                  r.recent ? `いま編集中などの ${r.recent} 件は、数分おいてからもう一度押すと付きます。` : "",
                  r.failed ? `${r.failed} 件は通信などで付けられませんでした。もう一度押すと続きから付けます。` : "",
                  r.skipped.length ? `ページの先頭の項目欄が壊れている ${r.skipped.length} 件（${names(r.skipped)}）は飛ばしました。` : "",
                ].join("");
              })
            }
          >
            2. 番号を付ける
          </button>
        </div>
      )}
      {busy && <p className="note">{busy}…</p>}
      {result && <p className="note">{result}</p>}
      {error && <p className="notice error">{error}</p>}
    </section>
  );
}
