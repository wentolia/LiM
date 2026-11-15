import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "../src/hooks";

describe("ルート", () => {
  it("往復できる", () => {
    for (const r of [
      { project: null, title: null, members: false },
      { project: null, title: "メモ", members: false },
      { project: "abc123", title: null, members: false },
      { project: "abc123", title: "知的生産/技術", members: false },
      { project: "abc123", title: null, members: true },
    ]) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
  });
  it("知らない形は一覧", () => {
    expect(parseRoute("#/login-error")).toEqual({ project: null, title: null, members: false });
  });
});
