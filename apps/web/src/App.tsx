import { useState } from "react";
import { Header } from "./components/Header";
import { ListView } from "./components/ListView";
import { PageView } from "./components/PageView";
import { useRoute, useWorkspace } from "./useWorkspace";
import type { Workspace } from "./workspace";

export function App({ ws }: { ws: Workspace }) {
  useWorkspace(ws);
  const [title, go] = useRoute();
  const [saving, setSaving] = useState(false);
  const items = ws.list();

  const open = async (t: string) => {
    if (!ws.exists(t)) await ws.create(t);
    go(ws.get(t)?.title ?? t);
  };

  return (
    <div className="app">
      <Header saving={saving} pageCount={items.length} onHome={() => go(null)} />
      {title === null ? (
        <ListView items={items} onOpen={open} onCreate={async () => go(await ws.create())} />
      ) : (
        <PageView
          key={title}
          ws={ws}
          title={title}
          onOpen={open}
          onRenamed={(t) => go(t)}
          onBack={() => go(null)}
          setSaving={setSaving}
        />
      )}
    </div>
  );
}
