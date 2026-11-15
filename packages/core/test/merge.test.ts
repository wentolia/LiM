import { describe, expect, it } from "vitest";
import { merge3 } from "../src/merge";

const L = (...xs: string[]) => xs.join("\n");

describe("merge3", () => {
  it("別々の行の変更は両方取り込む", () => {
    const base = L("a", "b", "c", "d");
    const mine = L("a", "B", "c", "d");
    const theirs = L("a", "b", "c", "D");
    expect(merge3(base, mine, theirs)).toEqual({ text: L("a", "B", "c", "D"), conflict: false });
  });
  it("片方の追加・削除を取り込む", () => {
    expect(merge3(L("a", "b"), L("a", "b", "mine"), L("x", "a", "b")).text).toBe(L("x", "a", "b", "mine"));
    expect(merge3(L("a", "b", "c"), L("a", "c"), L("a", "b", "c", "t")).text).toBe(L("a", "c", "t"));
  });
  it("同じ行を両方が変えたら両方残す", () => {
    const r = merge3(L("a", "b", "c"), L("a", "mine", "c"), L("a", "theirs", "c"));
    expect(r).toEqual({ text: L("a", "mine", "theirs", "c"), conflict: true });
  });
  it("同じ変更は 1 回だけ", () => {
    expect(merge3(L("a"), L("a", "x"), L("a", "x")).text).toBe(L("a", "x"));
  });
  it("末尾への追記が重なっても両方残る", () => {
    const r = merge3(L("a"), L("a", "m"), L("a", "t"));
    expect(r.text).toBe(L("a", "m", "t"));
  });
});

describe("merge3（隣り合う行）", () => {
  it("隣の行の変更は別々に取り込む", () => {
    const base = L("議題", "1. 予算", "2. 日程", "メモ");
    const r = merge3(base, L("議題", "1. 予算（確定）", "2. 日程", "メモ"), L("議題", "1. 予算", "2. 日程（来週）", "メモ"));
    expect(r).toEqual({ text: L("議題", "1. 予算（確定）", "2. 日程（来週）", "メモ"), conflict: false });
  });
  it("空の base に両方が書いたら両方残す", () => {
    expect(merge3("", "A", "B").text).toBe(L("A", "B"));
  });
});
