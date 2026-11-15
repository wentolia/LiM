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
