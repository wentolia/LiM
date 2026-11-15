import { describe, expect, it } from "vitest";
import { roomRequest, roomTarget } from "../src/roomTarget";

describe("roomTarget", () => {
  it("日本語のページ名でも部屋へ渡せる", () => {
    const req = new Request("https://x.example/api/projects/p1/room?path=x", { headers: { Upgrade: "websocket" } });
    const forwarded = roomRequest(req, "p1", "pages/会議メモ 2026.md");
    expect(forwarded.headers.get("Upgrade")).toBe("websocket");
    expect(roomTarget(forwarded)).toEqual({ projectId: "p1", path: "pages/会議メモ 2026.md" });
  });
});

describe("toBytes", () => {
  it("Blob・ArrayBuffer・ビューのどれでも同じバイト列になり、文字列は無視する", async () => {
    const { toBytes } = await import("../src/roomObject");
    const bytes = new Uint8Array([0, 1, 2, 250]);
    expect(await toBytes(bytes.buffer.slice(0))).toEqual(bytes);
    expect(await toBytes(new Blob([bytes]))).toEqual(bytes);
    expect(await toBytes(new Uint8Array([9, ...bytes]).subarray(1))).toEqual(bytes);
    expect(await toBytes("hello")).toBeNull();
  });
});
