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
  /** 最後に異常終了したときのコードと理由（診断用） */
  lastClose(): string | null;
  destroy(): void;
}

/**
 * 同時編集につながらないときの診断。サーバーで部屋を開けるかを確かめ、だめなら理由を返す。
 */
export async function diagnoseRoom(cfg: CollabConfig, path: string): Promise<string | null> {
  try {
    const q = new URLSearchParams({ path, check: "1" });
    const res = await fetch(`/api/projects/${cfg.projectId}/room?${q}`, { credentials: "same-origin" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      lastAttempt?: { at: string; result: string; origin: string | null } | null;
    };
    if (!res.ok) return `${res.status} ${body.error ?? res.statusText}`;
    if (body.ok === false) return body.error ?? "部屋を開けません";
    const a = body.lastAttempt;
    if (!a) return "部屋は正常。WebSocket の接続要求がサーバーに届いていません（ネットワーク・プロキシ・ブラウザ拡張が止めている可能性）";
    return `部屋は正常。サーバーが受けた直近の接続：${a.result}（${a.at}、Origin ${a.origin ?? "なし"}）`;
  } catch (e) {
    return (e as Error).message;
  }
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
  let closed = false;
  let lastClose: string | null = null;
  const emit = (s: RoomStatus) => {
    if (!closed) listeners.forEach((fn) => fn(s));
  };
  provider.on("status", ({ status }) => emit(status));
  // 4404 = ページが改名・削除された（y-websocket は 44xx で再接続しない）
  provider.on("closed", (e) => {
    if (e.code === 4404) emit("gone");
  });
  // 診断用：開けたか、どう閉じたかを覚えておく
  let opened = false;
  let attempts = 0;
  provider.on("status", ({ status }) => {
    if (status === "connected") opened = true;
    if (status === "connecting") attempts++;
  });
  provider.on("connection-close", (e) => {
    if (e) lastClose = `${opened ? "接続後に切断" : "接続できず"}・試行${attempts}回・コード${e.code}${e.reason ? ` ${e.reason}` : ""}`;
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
    lastClose: () => lastClose,
    destroy: () => {
      // 閉じたあとの状態変化（切断など）は画面に伝えない
      closed = true;
      listeners.clear();
      provider.destroy();
      doc.destroy();
    },
  };
}
