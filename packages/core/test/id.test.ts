import { describe, expect, it } from "vitest";
import { formatTime, isId, newId, pagesNeedingId, parsePage, projectReadme, FORMAT_VERSION, RESERVED_PROPS } from "../src/index";

describe("id（0004）", () => {
  it("ULID：26 文字、作った順に並ぶ", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(isId(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(newId(0, (bytes) => void bytes.fill(0))).toBe("0".repeat(26));
    expect(isId("01JD3Z8Q5N000000000000000I")).toBe(false); // I は使わない
    expect(isId(123)).toBe(false);
  });

  it("時刻は端末の設定によらず日本時間（+09:00）で書く", () => {
    expect(formatTime(new Date("2026-11-15T15:30:05Z"))).toBe("2026-11-16T00:30:05+09:00");
    expect(formatTime(new Date("2026-11-15T15:30:05Z"), -330)).toBe("2026-11-15T10:00:05-05:30");
  });

  it("付けるべきページ：無い・形が違う・重複（パスの順で最初を残す）。読めないものは飛ばす", () => {
    const id = newId();
    const pages = [
      { path: "pages/b.md", props: { id } },
      { path: "pages/a.md", props: { id } },
      { path: "pages/c.md", props: {} },
      { path: "pages/d.md", props: { id: "abc" } },
      { path: "pages/e.md", props: {}, invalidFrontmatter: true as const },
    ];
    expect(pagesNeedingId(pages)).toEqual({ paths: ["pages/b.md", "pages/c.md", "pages/d.md"], skipped: ["pages/e.md"] });
    expect(pagesNeedingId([{ path: "pages/a.md", props: { id } }])).toEqual({ paths: [], skipped: [] });
  });
});

describe("README.md（0004）", () => {
  it("frontmatter に形式の版だけを持ち、予約項目をすべて説明する", () => {
    const text = projectReadme();
    const page = parsePage("README.md", text);
    expect(page.props).toEqual({ format: FORMAT_VERSION });
    for (const k of RESERVED_PROPS) expect(page.body).toContain(`\`${k}\``);
    expect(page.body).toContain("```query");
  });
});
