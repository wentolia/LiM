import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../editor";
import type { Workspace } from "../workspace";
import { formatDate } from "./ListView";
import { Tile } from "./Tile";

interface Props {
  ws: Workspace;
  title: string;
  onOpen: (title: string) => void;
  onRenamed: (title: string) => void;
  onBack: () => void;
  setSaving: (saving: boolean) => void;
}

const SAVE_DELAY = 600;

export function PageView({ ws, title, onOpen, onRenamed, onBack, setSaving }: Props) {
  const page = ws.get(title);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
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
    await latest.current.ws.saveBody(latest.current.title, text);
    setSaving(false);
  };

  useEffect(() => {
    setDraftTitle(title);
    setError(null);
  }, [title]);

  // ページが変わったらエディタを作り直す
  useEffect(() => {
    if (!host.current || !page) return;
    const v = createEditor(
      host.current,
      page.body,
      (text) => {
        pending.current = text;
        setSaving(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, SAVE_DELAY);
      },
      {
        exists: (t) => latest.current.ws.exists(t),
        open: async (t) => {
          await flush();
          const w = latest.current.ws;
          if (!w.exists(t)) await w.create(t);
          latest.current.onOpen(w.get(t)?.title ?? t);
        },
      },
    );
    view.current = v;
    if (!page.body) v.focus();
    return () => {
      void flush();
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.path]);

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
