import { excerpt, type Page } from "@lim/core";

const IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)|(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))/i;

export function firstImage(body: string): string | null {
  const m = body.match(IMAGE);
  return m ? (m[1] ?? m[2]) : null;
}

interface Props {
  page: Page;
  onOpen: (title: string) => void;
  small?: boolean;
}

/** 一覧と関連ページで共通のタイル */
export function Tile({ page, onOpen, small }: Props) {
  const img = small ? null : firstImage(page.body);
  return (
    <button type="button" className={small ? "tile small" : "tile"} onClick={() => onOpen(page.title)}>
      <span className="t">{page.title}</span>
      {img && <img className="img" src={img} alt="" loading="lazy" />}
      <span className="x">{excerpt(page.body, img ? 2 : small ? 3 : 6)}</span>
    </button>
  );
}
