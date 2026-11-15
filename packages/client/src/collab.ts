import { createContext } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

/*
 * 共同編集の接続（ドライブ上の 1 ファイル = 1 部屋）。
 * エディタ以外の機能（表・ボードなど）も、この部屋に Y.Doc の別の型を置いて使う想定。
 */

/** 画像の表示 URL への変換とアップロード（プロジェクトのときだけ） */
export interface Assets {
  resolve: (src: string) => string;
  upload?: (file: File) => Promise<string>;
}

export const AssetsContext = createContext<Assets>({ resolve: (s) => s });

export interface CollabConfig {
  projectId: string;
  user: { name: string; email: string };
}

export const CollabContext = createContext<CollabConfig | null>(null);

const COLORS = ["#0B4F8A", "#9A3412", "#1F6F43", "#6B21A8", "#B45309", "#0E7490", "#BE185D", "#4D7C0F"];

export function colorOf(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export type RoomStatus = "connecting" | "connected" | "disconnected" | "gone";

export interface Room {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /** 最初の同期が済んだら resolve */
  synced: Promise<void>;
  onStatus(fn: (s: RoomStatus) => void): void;
  destroy(): void;
}

export function joinRoom(cfg: CollabConfig, path: string): Room {
  const doc = new Y.Doc();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // パスはクエリで渡す（URL のパス部分に %2F を入れると、途中で / に戻されることがある）
  const provider = new WebsocketProvider(`${proto}//${location.host}/api/projects/${cfg.projectId}`, "room", doc, {
    disableBc: true,
    params: { path },
  });
  const color = colorOf(cfg.user.email);
  provider.awareness.setLocalStateField("user", { name: cfg.user.name || cfg.user.email, color, colorLight: `${color}33` });
  const listeners = new Set<(s: RoomStatus) => void>();
  const emit = (s: RoomStatus) => listeners.forEach((fn) => fn(s));
  provider.on("status", ({ status }) => emit(status));
  // 4404 = ページが改名・削除された（y-websocket は 44xx で再接続しない）
  provider.on("closed", (e) => {
    if (e.code === 4404) emit("gone");
  });
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    provider.on("sync", (ok) => ok && resolve());
  });
  return {
    doc,
    provider,
    synced,
    onStatus: (fn) => void listeners.add(fn),
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}
