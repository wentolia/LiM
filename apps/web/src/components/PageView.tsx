import type { SaveState } from "./Header";
import { useContext, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { AssetsContext } from "../assets";
import { CollabContext, joinRoom } from "../collab";
import { pageBody } from "@lim/core";
import { createEditor, replaceText, type LinkHandlers } from "../editor";
import type { Workspace } from "../workspace";
import { formatDate } from "./ListView";
import { Tile } from "./Tile";

interface Props {
  ws: Workspace;
  title: string;
  onOpen: (title: string) => void;
  onRenamed: (title: string) => void;
  onBack: () => void;
  setSaving: (state: SaveState) => void;
}

const SAVE_DELAY = 600;

export function PageView({ ws, title, onOpen, onRenamed, onBack, setSaving }: Props) {
  const page = ws.get(title);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const inFlight = useRef(false);
  const assets = useContext(AssetsContext);
  const collab = useContext(CollabContext);
  const [loading, setLoading] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [error, setError] = useState<string | null>(null);

  // 最新の値をエディタのコールバックから参照する
  const latest = useRef({ ws, title, onOpen });
  latest.current = { ws, title, onOpen };

  const flush = async () => {
    window.clearTimeout(timer.current);
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    inFlight.current = true;
    try {
      const saved = await latest.current.ws.saveBody(latest.current.title, text);
      // 他の人の変更と合わせた結果をエディタにも反映する（入力が続いていなければ）
      if (saved !== text && pending.current === null && view.current) replaceText(view.current, saved);
      setSaving(pending.current === null ? "saved" : "saving");
    } catch (e) {
      console.error(e);
      // 失敗した内容は次の保存で再送する
      pending.current ??= text;
      setSaving("error");
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    setDraftTitle(title);
    setError(null);
  }, [title]);

  // 他の人の変更が取り込まれたら、編集中でなければエディタに反映する（共同編集では部屋が反映する）
  useEffect(
    () =>
      collab ? undefined : ws.subscribe(() => {
        const p = ws.get(title);
        if (!p || !view.current || pending.current !== null || inFlight.current) return;
        replaceText(view.current, p.body);
      }),
    [ws, title],
  );

  // ページが変わったらエディタを作り直す
  useEffect(() => {
    if (!host.current || !page) return;
    const handlers: LinkHandlers = {
        exists: (t) => latest.current.ws.exists(t),
        resolve: assets.resolve,
        upload: assets.upload,
        onUploadError: (m) => setError(`画像を保存できませんでした：${m}`),
        open: async (t) => {
          await flush();
          const w = latest.current.ws;
          if (!w.exists(t)) await w.create(t);
          latest.current.onOpen(w.get(t)?.title ?? t);
        },
    };

    // ---- このブラウザだけ：自分で保存する ----
    if (!collab) {
      const v = createEditor(host.current, page.body, (text) => {
        pending.current = text;
        setSaving("saving");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, SAVE_DELAY);
      }, handlers);
      view.current = v;
      if (!page.body) v.focus();
      return () => {
        void flush();
        v.destroy();
        view.current = null;
      };
    }

    // ---- プロジェクト：共同編集の部屋につなぐ。保存は部屋がドライブへ行う ----
    const parent = host.current;
    const room = joinRoom(collab, page.path);
    let v: EditorView | null = null;
    let disposed = false;
    let graphTimer: number | undefined;
    setLoading(true);
    room.onStatus((st) => {
      if (st === "connected") setSaving("saved");
      else if (st === "gone") {
        setError("このページは改名または削除されました。一覧から開き直してください。");
        void latest.current.ws.refresh();
      } else setSaving("offline");
    });
    void room.synced.then(() => {
      if (disposed) return;
      setLoading(false);
      v = createEditor(
        parent,
        "",
        (text) => {
          // 一覧・リンク・関連ページ用に手元の索引だけ更新する（保存は部屋が行う）
          window.clearTimeout(graphTimer);
          graphTimer = window.setTimeout(() => latest.current.ws.applyLocal(latest.current.title, text), 300);
        },
        handlers,
        { ytext: pageBody(room.doc), awareness: room.provider.awareness },
      );
      view.current = v;
      if (!pageBody(room.doc).length) v.focus();
    });
    return () => {
      disposed = true;
      window.clearTimeout(graphTimer);
      if (v) latest.current.ws.applyLocal(latest.current.title, v.state.doc.toString());
      v?.destroy();
      view.current = null;
      room.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.path, collab]);

  if (!page) {
    return (
      <div className="empty">
        「{title}」というページはありません。{" "}
        <button type="button" onClick={onBack}>
          一覧へ戻る
        </button>
      </div>
    );
  }

  const commitTitle = async () => {
    if (draftTitle.trim() === page.title) return;
    try {
      await flush();
      if (collab && view.current) ws.applyLocal(page.title, view.current.state.doc.toString());
      const next = await ws.rename(page.title, draftTitle);
      setError(null);
      onRenamed(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const related = ws.related(page.title);

  return (
    <>
      <div className="toolbar">
        <button type="button" className="back" onClick={onBack}>
          ← 一覧
        </button>
        <span className="text right">最終更新 {formatDate(ws.updatedAt(page.title))}</span>
      </div>
      <article className="page">
        <input
          className="title-input"
          aria-label="タイトル"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitTitle().then(() => view.current?.focus());
            }
          }}
        />
        {error && <div className="error">{error}</div>}
        {loading && <div className="note">読み込み中…</div>}
        <div ref={host} />
      </article>
      {related.map((g) => (
        <div className="related" key={g.via}>
          <button type="button" className="tile small via" onClick={() => onOpen(g.via)}>
            <span className="label">共通のリンク</span>
            <span className="name">{g.via}</span>
          </button>
          {g.pages.map((p) => (
            <Tile key={p.path} page={p} onOpen={onOpen} small />
          ))}
        </div>
      ))}
    </>
  );
}
