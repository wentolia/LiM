import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Pages } from "./App";
import {
  api,
  ApiError,
  ApiStore,
  AssetsContext,
  CollabContext,
  lastMode,
  loginUrl,
  openLocal,
  openProject,
  setMode,
  useRoute,
  useWorkspace,
  type Assets,
  type CollabConfig,
  type Me,
  type ProjectInfo,
  type Workspace,
} from "@lim/client";
import { Header, ImageContext, Login, type SaveState } from "@lim/ui";
import "@lim/ui/styles.css";
import { Members } from "./screens/Members";
import { ProjectList } from "./screens/ProjectList";

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
  const [open, setOpen] = useState<{ id: string; ws: Workspace; store: ApiStore; assets: Assets; collab: CollabConfig } | null>(null);
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
      const [me, projects] = await Promise.all([api.me(), api.projects()]);
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
      ({ ws, store }) =>
        !cancelled &&
        setOpen({
          id: route.project!,
          ws,
          store,
          assets: { resolve: (src) => store.assetUrl(src), upload: (f) => store.upload(f, f.name) },
          collab: { projectId: route.project!, user: state.kind === "server" ? { name: state.me.name, email: state.me.email } : { name: "", email: "" } },
        }),
      (e) => !cancelled && setLoadError(message(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [state.kind, route.project, open?.id]);

  // 他の人の変更を取り込む：10 秒ごと（画面が見えているときだけ）と、画面に戻ったとき
  useEffect(() => {
    if (!open) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        await open.ws.refresh();
      } catch (e) {
        console.warn("refresh failed", e);
      } finally {
        busy = false;
      }
    };
    const id = window.setInterval(tick, 10_000);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [open]);

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
        <AssetsContext.Provider value={open.assets}>
          <ImageContext.Provider value={open.assets}>
            <CollabContext.Provider value={open.collab}>
              <Pages ws={open.ws} title={route.title} go={(t) => go({ project: project.id, title: t })} setSaving={setSaving} />
            </CollabContext.Provider>
          </ImageContext.Provider>
        </AssetsContext.Provider>
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
