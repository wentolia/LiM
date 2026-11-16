/* ページの id（ULID）と、frontmatter に書く時刻の形 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID（26 文字。先頭 10 文字が時刻なので、文字の順に並べると作った順になる） */
export function newId(now = Date.now(), random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => void crypto.getRandomValues(b)): string {
  let time = "";
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  random(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

/** 時刻を `2026-11-15T17:00:00+09:00` の形にする。決まりは日本時間（+09:00）。端末の時間帯の設定には左右されない */
export function formatTime(date: Date, offsetMinutes = 540): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  return `${local.toISOString().slice(0, 19)}${sign}${p(offsetMinutes / 60)}:${p(offsetMinutes % 60)}`;
}

/**
 * `id` を付け直すべきページ（移行用）。何度呼んでも、付け終わったあとは空になる。
 * - `id` が無い、または ULID の形でない
 * - 同じ `id` が複数ある：パスの順で最初の 1 件を残し、残りを付け直す
 * frontmatter が読めないページは書き換えられないので skipped に入れる
 */
export function pagesNeedingId(pages: { path: string; props: Record<string, unknown>; invalidFrontmatter?: true }[]): { paths: string[]; skipped: string[] } {
  const paths: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const p of [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (p.invalidFrontmatter) {
      skipped.push(p.path);
      continue;
    }
    const id = p.props.id;
    if (isId(id) && !seen.has(id)) seen.add(id);
    else paths.push(p.path);
  }
  return { paths, skipped };
}
