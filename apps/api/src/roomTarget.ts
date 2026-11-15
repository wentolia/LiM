/**
 * Worker → 部屋（Durable Object）へ、どのプロジェクトのどのページかを伝える。
 * HTTP ヘッダーには日本語などを入れられない（入れると例外になる）ので、エンコードして渡す。
 */
export function roomRequest(request: Request, projectId: string, path: string): Request {
  const headers = new Headers(request.headers);
  headers.set("X-Project-Id", projectId);
  headers.set("X-Path", encodeURIComponent(path));
  return new Request(request.url, { headers });
}

export function roomTarget(req: Request): { projectId: string; path: string } {
  return {
    projectId: req.headers.get("X-Project-Id") ?? "",
    path: decodeURIComponent(req.headers.get("X-Path") ?? ""),
  };
}
