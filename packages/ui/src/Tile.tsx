import { excerpt, type Page } from "@lim/core";
import { createContext, useContext } from "react";

/** 画像パス（../assets/x.png）を表示用 URL にする。アプリ側が Provider で渡す */
export const ImageContext = createContext<{ resolve: (src: string) => string }>({ resolve: (s) => s });

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
  const { resolve } = useContext(ImageContext);
  const raw = small ? null : firstImage(page.body);
  const img = raw ? resolve(raw) : null;
  return (
    <button type="button" className={small ? "tile small" : "tile"} onClick={() => onOpen(page.title)}>
      <span className="t">{page.title}</span>
      {img && <img className="img" src={img} alt="" loading="lazy" />}
      <span className="x">{excerpt(page.body, img ? 2 : small ? 3 : 6)}</span>
    </button>
  );
}
