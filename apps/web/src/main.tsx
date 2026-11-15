import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Login } from "./components/Login";
import { auth, driveEnabled, lastMode, openDrive, openLocal, type Session } from "./session";
import "./styles.css";

function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(driveEnabled && lastMode() !== "local");

  const useLocal = async () => {
    setShowLogin(false);
    setSession(await openLocal());
  };

  // ドライブ連携が未設定、または前回「このブラウザだけ」を選んだならそのまま開く
  useEffect(() => {
    if (!showLogin) void useLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      setSession(
        await openDrive(() => {
          setSession(null);
          setShowLogin(true);
        }),
      );
      setShowLogin(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (showLogin || !session) {
    if (!showLogin) return null; // ブラウザ内の読み込み中
    return (
      <Login
        busy={busy}
        error={error}
        lastUser={auth?.lastUser() ?? null}
        onLogin={login}
        onLocal={() => void useLocal()}
      />
    );
  }
  return <App key={session.conn.user ?? "local"} session={session} onLogin={driveEnabled ? () => setShowLogin(true) : undefined} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
