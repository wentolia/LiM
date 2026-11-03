import { useState } from "react";
import type { PageItem } from "../workspace";
import { Tile } from "./Tile";

interface Props {
  items: PageItem[];
  onOpen: (title: string) => void;
  onCreate: () => void;
}

const formatDate = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const propsText = (props: Record<string, unknown>) =>
  Object.entries(props)
    .map(([k, v]) => `${k} ${String(v).replace(/^\[\[(.+)\]\]$/, "$1")}`)
    .join(" / ") || "—";

/** 全ページの一覧。ギャラリーが基本、表は補助 */
export function ListView({ items, onOpen, onCreate }: Props) {
  const [view, setView] = useState<"gallery" | "table">("gallery");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter(({ page }) => page.title.toLowerCase().includes(needle) || page.body.toLowerCase().includes(needle))
    : items;

  return (
    <>
      <div className="toolbar">
        <label className="search">
          <span>検索</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="タイトル・本文" />
        </label>
        <span className="text">{shown.length} ページ</span>
        <span className="text">更新順</span>
        <div className="tabs" role="tablist" aria-label="表示">
          <button type="button" role="tab" className="tab" aria-selected={view === "gallery"} onClick={() => setView("gallery")}>
            ギャラリー
          </button>
          <button type="button" role="tab" className="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
            表
          </button>
        </div>
        <button type="button" className="primary" onClick={onCreate}>
          ＋ 新しいページ
        </button>
      </div>

      {shown.length === 0 && <div className="empty">該当するページはありません。</div>}

      {view === "gallery" && shown.length > 0 && (
        <div className="gallery">
          {shown.map(({ page }) => (
            <Tile key={page.path} page={page} onOpen={onOpen} />
          ))}
        </div>
      )}

      {view === "table" && shown.length > 0 && (
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>タイトル</th>
                <th>プロパティ</th>
                <th>更新 ▼</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ page, updatedAt }) => (
                <tr key={page.path}>
                  <td>
                    <button type="button" className="title" onClick={() => onOpen(page.title)}>
                      {page.title}
                    </button>
                  </td>
                  <td>{propsText(page.props)}</td>
                  <td className="mono">{formatDate(updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export { formatDate };
