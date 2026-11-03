import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { seedIfEmpty } from "./seed";
import { LocalStorageStore } from "./store/localStore";
import { Workspace } from "./workspace";
import "./styles.css";

async function start() {
  const store = new LocalStorageStore();
  await seedIfEmpty(store);
  const ws = new Workspace(store);
  await ws.load();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App ws={ws} />
    </StrictMode>,
  );
}

void start();
