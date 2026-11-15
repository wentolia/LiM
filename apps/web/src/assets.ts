import { createContext } from "react";

/** 画像の表示 URL への変換と、アップロード（プロジェクトのときだけ） */
export interface Assets {
  resolve: (src: string) => string;
  upload?: (file: File) => Promise<string>;
}

export const AssetsContext = createContext<Assets>({ resolve: (s) => s });
