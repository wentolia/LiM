import { useState } from "react";
import { Header, type SaveState } from "./components/Header";
import { ListView } from "./components/ListView";
import { PageView } from "./components/PageView";
import { useRoute, useWorkspace } from "./useWorkspace";
import type { Session } from "./session";

export function App({ session, onLogin }: { session: Session; onLogin?: () => void }) {
  const { ws } = session;
  useWorkspace(ws);
  const [title, go] = useRoute();
  const [saving, setSaving] = useState<SaveState>("saved");
  const items = ws.list();

  const open = async (t: string) => {
    if (!ws.exists(t)) await ws.create(t);
    go(ws.get(t)?.title ?? t);
  };

  return (
    <div className="app">
      <Header
        save={saving}
        pageCount={items.length}
        conn={session.conn}
        onLogin={session.conn.user ? undefined : onLogin}
        onHome={() => go(null)}
      />
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
