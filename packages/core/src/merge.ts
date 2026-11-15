/**
 * 行単位の 3-way マージ。base から mine / theirs がそれぞれ変わったとき、
 * 両方の変更を取り込んだ文章を作る。同じ箇所を両方が変えたときは両方を残す（どちらの変更も消さない）。
 */
export interface MergeResult {
  text: string;
  /** 同じ箇所を両方が変えた（両方残した）か */
  conflict: boolean;
}

/** a と b の最長共通部分列で対応づけ。ret[i] = a[i] に対応する b の位置（なければ -1） */
function match(a: string[], b: string[]): number[] {
  // 先頭と末尾の共通部分は先に処理して、表を小さくする
  const map = new Array<number>(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { map[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; map[ea] = eb; }
  const n = ea - s, m = eb - s;
  if (n === 0 || m === 0) return map;
  if (n * m > 4_000_000) return map; // 大きすぎるときは中央を対応なしとして扱う
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[s + i] === b[s + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[s + i] === b[s + j]) { map[s + i] = s + j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/** base[b0,b1) が side[s0,s1) に置き換わった箇所 */
interface Hunk { b0: number; b1: number; s0: number; s1: number; side: 0 | 1 }

function hunks(map: number[], sideLen: number, side: 0 | 1): Hunk[] {
  const out: Hunk[] = [];
  const n = map.length;
  for (let i = 0, j = 0; ; ) {
    let x = i;
    while (x < n && map[x] < 0) x++;
    const sj = x < n ? map[x] : sideLen;
    if (x > i || sj > j) out.push({ b0: i, b1: x, s0: j, s1: sj, side });
    if (x >= n) break;
    i = x + 1;
    j = sj + 1;
  }
  return out;
}

const overlaps = (a: { b0: number; b1: number }, b: { b0: number; b1: number }) =>
  (a.b0 < b.b1 && b.b0 < a.b1) || (a.b0 === a.b1 && b.b0 === b.b1 && a.b0 === b.b0) ||
  (a.b0 === a.b1 && b.b0 < a.b0 && a.b0 < b.b1) || (b.b0 === b.b1 && a.b0 < b.b0 && b.b0 < a.b1);

export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs || theirs === base) return { text: mine, conflict: false };
  if (mine === base) return { text: theirs, conflict: false };
  const B = base.split("\n");
  const S = [mine.split("\n"), theirs.split("\n")];
  const all = [...hunks(match(B, S[0]), S[0].length, 0), ...hunks(match(B, S[1]), S[1].length, 1)].sort(
    (a, b) => a.b0 - b.b0 || a.b1 - b.b1,
  );

  // 重なる変更をまとめる
  const groups: { b0: number; b1: number; hs: Hunk[] }[] = [];
  for (const h of all) {
    const g = groups.at(-1);
    if (g && overlaps(g, h)) {
      g.hs.push(h);
      g.b1 = Math.max(g.b1, h.b1);
    } else groups.push({ b0: h.b0, b1: h.b1, hs: [h] });
  }

  // 片方の側から見た base[g0,g1) の内容
  const render = (side: 0 | 1, g: { b0: number; b1: number; hs: Hunk[] }) => {
    const out: string[] = [];
    let p = g.b0;
    for (const h of g.hs.filter((x) => x.side === side)) {
      out.push(...B.slice(p, h.b0), ...S[side].slice(h.s0, h.s1));
      p = h.b1;
    }
    out.push(...B.slice(p, g.b1));
    return out;
  };

  const out: string[] = [];
  let conflict = false;
  let i = 0;
  for (const g of groups) {
    out.push(...B.slice(i, g.b0));
    const sides = new Set(g.hs.map((h) => h.side));
    if (sides.size === 1) out.push(...render(g.hs[0].side, g));
    else {
      const m = render(0, g), t = render(1, g);
      if (same(m, t)) out.push(...m);
      else { out.push(...m, ...t); conflict = true; }
    }
    i = g.b1;
  }
  out.push(...B.slice(i));
  return { text: out.join("\n"), conflict };
}
