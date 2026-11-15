import { useEffect, useState } from "react";
import type { Workspace } from "./workspace";

/** Workspace の変更で再描画する */
export function useWorkspace(ws: Workspace | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => ws?.subscribe(() => setVersion((v) => v + 1)), [ws]);
  return version;
}

/**
 * ハッシュルーティング
 *   #/                      プロジェクト一覧（ブラウザ内モードではページ一覧）
 *   #/x/<id>/               プロジェクトのページ一覧
 *   #/x/<id>/p/<タイトル>     ページ
 *   #/x/<id>/members        メンバー
 *   #/p/<タイトル>            ブラウザ内モードのページ
 */
export interface Route {
  project: string | null;
  title: string | null;
  members: boolean;
}

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/(?:x\/([\w]+)\/?)?(?:(members)|p\/(.+))?$/);
  if (!m) return { project: null, title: null, members: false };
  return { project: m[1] ?? null, members: !!m[2], title: m[3] ? decodeURIComponent(m[3]) : null };
}

export function routeHash(r: Partial<Route>): string {
  const base = r.project ? `#/x/${r.project}/` : "#/";
  if (r.members) return `${base}members`;
  if (r.title) return `${base}p/${encodeURIComponent(r.title)}`;
  return base;
}

export function useRoute(): [Route, (r: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => { window.location.hash = routeHash(r); }];
}
