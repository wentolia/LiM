import { useWorkspace, type Workspace } from "@lim/client";
import { ListView, type SaveState } from "@lim/ui";
import { PageView } from "./screens/PageView";

interface Props {
  ws: Workspace;
  title: string | null;
  go: (title: string | null) => void;
  setSaving: (s: SaveState) => void;
}

/** 1 つの箱（プロジェクト or ブラウザ内）のページ一覧とページ */
export function Pages({ ws, title, go, setSaving }: Props) {
  useWorkspace(ws);
  const items = ws.list();

  const open = async (t: string) => {
    if (!ws.exists(t)) await ws.create(t);
    go(ws.get(t)?.title ?? t);
  };

  return title === null ? (
    <ListView items={items} onOpen={open} onCreate={async () => go(await ws.create())} />
  ) : (
    <PageView key={title} ws={ws} title={title} onOpen={open} onRenamed={(t) => go(t)} onBack={() => go(null)} setSaving={setSaving} />
  );
}
