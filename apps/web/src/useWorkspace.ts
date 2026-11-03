import { useEffect, useState } from "react";
import type { Workspace } from "./workspace";

/** Workspace の変更で再描画する */
export function useWorkspace(ws: Workspace): number {
  const [version, setVersion] = useState(0);
  useEffect(() => ws.subscribe(() => setVersion((v) => v + 1)), [ws]);
  return version;
}

/** #/p/<タイトル> 形式のハッシュルーティング */
export function useRoute(): [string | null, (title: string | null) => void] {
  const read = () => {
    const m = window.location.hash.match(/^#\/p\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const [title, setTitle] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setTitle(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (t: string | null) => {
    window.location.hash = t === null ? "#/" : `#/p/${encodeURIComponent(t)}`;
  };
  return [title, go];
}
