import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Pages } from "./App";
import { api, ApiError, loginUrl, type Me, type ProjectInfo } from "./api";
import { Header, type SaveState } from "./components/Header";
import { Login } from "./components/Login";
import { Members } from "./components/Members";
import { ProjectList } from "./components/ProjectList";
import { lastMode, openLocal, openProject, setMode } from "./session";
import { useRoute, useWorkspace } from "./useWorkspace";
import type { Workspace } from "./workspace";
import "./styles.css";

type State =
  | { kind: "checking" }
  | { kind: "login"; serverReady: boolean; error: string | null }
  | { kind: "local"; ws: Workspace }
  | { kind: "server"; me: Me; projects: ProjectInfo[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Root() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [route, go] = useRoute();
  const [saving, setSaving] = useState<SaveState>("saved");
  const [open, setOpen] = useState<{ id: string; ws: Workspace } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // ヘッダーのページ数を最新に保つため、開いている箱の変更を購読する
  useWorkspace(state.kind === "local" ? state.ws : (open?.ws ?? null));

  const useLocal = async () => {
    setMode("local");
    setState({ kind: "local", ws: await openLocal() });
  };

  const checkServer = async () => {
    const loginError = window.location.hash === "#/login-error" ? "ログインできませんでした。もう一度お試しください。" : null;
    try {
      const me = await api.me();
      const projects = await api.projects();
      setMode("server");
      setState({ kind: "server", me, projects });
    } catch (e) {
      const ready = e instanceof ApiError && e.status === 401;
      setState({ kind: "login", serverReady: ready, error: loginError ?? (ready || !(e instanceof ApiError) || e.status === 0 ? null : message(e)) });
    }
  };

  useEffect(() => {
    if (lastMode() === "local") void useLocal();
    else void checkServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // プロジェクトを開く（URL に合わせて読み込む）
  useEffect(() => {
    if (state.kind !== "server" || !route.project || open?.id === route.project) return;
    let cancelled = false;
    setOpen(null);
    setLoadError(null);
    openProject(route.project).then(
      (ws) => !cancelled && setOpen({ id: route.project!, ws }),
      (e) => !cancelled && setLoadError(message(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [state.kind, route.project, open?.id]);

  if (state.kind === "checking") return null;

  if (state.kind === "login") {
    return (
      <Login
        serverReady={state.serverReady}
        error={state.error}
        onLogin={() => {
          setMode(null);
          window.location.href = loginUrl();
        }}
        onLocal={() => void useLocal()}
      />
    );
  }

  if (state.kind === "local") {
    return (
      <div className="app">
        <Header
          place="このブラウザ"
          save={saving}
          pageCount={state.ws.list().length}
          user={null}
          onLogin={() => {
            setMode(null);
            void checkServer();
          }}
          onHome={() => go({})}
        />
        <Pages ws={state.ws} title={route.project ? null : route.title} go={(t) => go({ title: t })} setSaving={setSaving} />
      </div>
    );
  }

  // ---- サーバー（プロジェクト）モード ----
  const { me, projects } = state;
  const project = projects.find((p) => p.id === route.project) ?? null;
  const logout = async () => {
    await api.logout().catch(() => {});
    setMode(null);
    setOpen(null);
    window.location.hash = "#/";
    setState({ kind: "login", serverReady: true, error: null });
  };
  const header = (extra: { save?: SaveState; pageCount?: number } = {}) => (
    <Header
      place={project ? "管理者の Google ドライブ" : "Google ドライブ"}
      project={project ? { name: project.name, onSwitch: () => go({}), onMembers: () => go({ project: project.id, members: true }) } : undefined}
      user={me.email}
      onLogout={() => void logout()}
      onHome={() => go(project ? { project: project.id } : {})}
      {...extra}
    />
  );

  if (!route.project) {
    return (
      <div className="app">
        {header()}
        <ProjectList
          me={me}
          projects={projects}
          onOpen={(id) => go({ project: id })}
          onCreate={async (name) => {
            const p = await api.createProject(name);
            setState({ ...state, projects: [...projects, p] });
            go({ project: p.id });
          }}
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="app">
        {header()}
        <div className="empty">このプロジェクトは見つからないか、参加していません。</div>
      </div>
    );
  }

  if (route.members) {
    return (
      <div className="app">
        {header()}
        <Members project={project} onBack={() => go({ project: project.id })} />
      </div>
    );
  }

  return (
    <div className="app">
      {header({ save: saving, pageCount: open?.id === project.id ? open.ws.list().length : undefined })}
      {open?.id === project.id ? (
        <Pages ws={open.ws} title={route.title} go={(t) => go({ project: project.id, title: t })} setSaving={setSaving} />
      ) : (
        <div className="empty">{loadError ? `読み込めませんでした：${loadError}` : "読み込み中…"}</div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
