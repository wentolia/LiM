/* メンバー表の読み書き。D1 実装とテスト用のメモリ実装を同じ I/F で持つ。表の定義は migrations.ts */
import { migrate, type D1Database, type D1Stmt } from "./migrations";
export type { D1Database } from "./migrations";
import type { TokenCipher } from "./tokenCipher";

export interface User { id: string; email: string; name: string }
export interface Project { id: string; name: string; owner_id: string; folder_id: string; created_at: string }
export type Role = "owner" | "member";
export interface Member { project_id: string; email: string; role: Role; added_at: string }
export interface DriveToken { user_id: string; refresh_token: string; access_token: string | null; expires_at: number | null }

export interface Repo {
  upsertUser(u: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  createSession(id: string, userId: string, expiresAt: number): Promise<void>;
  getSessionUser(id: string, now: number): Promise<User | null>;
  deleteSession(id: string): Promise<void>;
  getDriveToken(userId: string): Promise<DriveToken | null>;
  putDriveToken(t: DriveToken): Promise<void>;
  /** email がメンバーになっているプロジェクト（役割つき） */
  projectsOf(email: string): Promise<(Project & { role: Role })[]>;
  projectsOwnedBy(userId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(p: Project): Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  roleOf(projectId: string, email: string): Promise<Role | null>;
  members(projectId: string): Promise<Member[]>;
  addMember(m: Member): Promise<void>;
  removeMember(projectId: string, email: string): Promise<void>;
}


/** 暗号文の付加データ：別の行・列へ移した暗号文は読めない */
const aad = (userId: string, column: string) => `drive_tokens:${userId}:${column}`;

const ready = new WeakMap<D1Database, Promise<void>>();

export class D1Repo implements Repo {
  /** cipher はドライブの鍵の暗号器（決定 0002） */
  constructor(private db: D1Database, private cipher: TokenCipher) {}

  private q(sql: string, ...v: unknown[]): D1Stmt {
    return this.db.prepare(sql).bind(...v);
  }
  /** 未適用の migration を当てる（同じ実行環境（isolate）で 1 回だけ） */
  private init(): Promise<void> {
    let p = ready.get(this.db);
    if (!p) {
      p = migrate(this.db).catch((e) => {
        ready.delete(this.db); // 次のリクエストでやり直す
        throw e;
      });
      ready.set(this.db, p);
    }
    return p;
  }
  private async first<T>(sql: string, ...v: unknown[]) { await this.init(); return this.q(sql, ...v).first<T>(); }
  private async all<T>(sql: string, ...v: unknown[]) { await this.init(); return (await this.q(sql, ...v).all<T>()).results; }
  private async run(sql: string, ...v: unknown[]) { await this.init(); await this.q(sql, ...v).run(); }

  upsertUser(u: User) {
    return this.run("INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name", u.id, u.email, u.name);
  }
  getUser(id: string) { return this.first<User>("SELECT * FROM users WHERE id = ?", id); }
  createSession(id: string, userId: string, expiresAt: number) {
    return this.run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", id, userId, expiresAt);
  }
  getSessionUser(id: string, now: number) {
    return this.first<User>("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?", id, now);
  }
  deleteSession(id: string) { return this.run("DELETE FROM sessions WHERE id = ?", id); }
  /** ドライブの鍵を読む。読めない行（鍵の取り違え・改ざん・平文）は未接続と同じ null にし、管理者が接続し直せるようにする */
  async getDriveToken(userId: string): Promise<DriveToken | null> {
    const row = await this.first<DriveToken>("SELECT * FROM drive_tokens WHERE user_id = ?", userId);
    if (!row) return null;
    const refresh = await this.cipher.decrypt(row.refresh_token, aad(userId, "refresh_token"));
    if (refresh === null) {
      console.error(`drive_tokens.refresh_token を今の DRIVE_TOKEN_KEY で読めません（user_id: ${userId}）。鍵を確かめるか、ドライブを接続し直してください`);
      return null;
    }
    const access = row.access_token ? await this.cipher.decrypt(row.access_token, aad(userId, "access_token")) : null;
    return { user_id: userId, refresh_token: refresh, access_token: access, expires_at: access ? row.expires_at : null };
  }
  async putDriveToken(t: DriveToken) {
    const refresh = await this.cipher.encrypt(t.refresh_token, aad(t.user_id, "refresh_token"));
    const access = t.access_token ? await this.cipher.encrypt(t.access_token, aad(t.user_id, "access_token")) : null;
    return this.run(
      "INSERT INTO drive_tokens (user_id, refresh_token, access_token, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at",
      t.user_id, refresh, access, t.expires_at,
    );
  }
  projectsOf(email: string) {
    return this.all<Project & { role: Role }>("SELECT p.*, m.role FROM members m JOIN projects p ON p.id = m.project_id WHERE m.email = ? ORDER BY p.created_at", email);
  }
  projectsOwnedBy(userId: string) { return this.all<Project>("SELECT * FROM projects WHERE owner_id = ?", userId); }
  getProject(id: string) { return this.first<Project>("SELECT * FROM projects WHERE id = ?", id); }
  createProject(p: Project) {
    return this.run("INSERT INTO projects (id, name, owner_id, folder_id, created_at) VALUES (?, ?, ?, ?, ?)", p.id, p.name, p.owner_id, p.folder_id, p.created_at);
  }
  renameProject(id: string, name: string) { return this.run("UPDATE projects SET name = ? WHERE id = ?", name, id); }
  async deleteProject(id: string) {
    await this.run("DELETE FROM members WHERE project_id = ?", id);
    await this.run("DELETE FROM projects WHERE id = ?", id);
  }
  async roleOf(projectId: string, email: string) {
    return (await this.first<{ role: Role }>("SELECT role FROM members WHERE project_id = ? AND email = ?", projectId, email))?.role ?? null;
  }
  members(projectId: string) { return this.all<Member>("SELECT * FROM members WHERE project_id = ? ORDER BY added_at", projectId); }
  addMember(m: Member) {
    return this.run("INSERT INTO members (project_id, email, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", m.project_id, m.email, m.role, m.added_at);
  }
  removeMember(projectId: string, email: string) { return this.run("DELETE FROM members WHERE project_id = ? AND email = ?", projectId, email); }
}

/** テスト・ローカル確認用 */
export class MemoryRepo implements Repo {
  users = new Map<string, User>();
  sessions = new Map<string, { userId: string; expiresAt: number }>();
  tokens = new Map<string, DriveToken>();
  projects = new Map<string, Project>();
  memberList: Member[] = [];

  async upsertUser(u: User) { this.users.set(u.id, u); }
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async createSession(id: string, userId: string, expiresAt: number) { this.sessions.set(id, { userId, expiresAt }); }
  async getSessionUser(id: string, now: number) {
    const s = this.sessions.get(id);
    return s && s.expiresAt > now ? (this.users.get(s.userId) ?? null) : null;
  }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async getDriveToken(userId: string) { return this.tokens.get(userId) ?? null; }
  async putDriveToken(t: DriveToken) { this.tokens.set(t.user_id, t); }
  async projectsOf(email: string) {
    return this.memberList
      .filter((m) => m.email === email && this.projects.has(m.project_id))
      .map((m) => ({ ...this.projects.get(m.project_id)!, role: m.role }));
  }
  async projectsOwnedBy(userId: string) { return [...this.projects.values()].filter((p) => p.owner_id === userId); }
  async getProject(id: string) { return this.projects.get(id) ?? null; }
  async createProject(p: Project) { this.projects.set(p.id, p); }
  async renameProject(id: string, name: string) { const p = this.projects.get(id); if (p) p.name = name; }
  async deleteProject(id: string) { this.projects.delete(id); this.memberList = this.memberList.filter((m) => m.project_id !== id); }
  async roleOf(projectId: string, email: string) { return this.memberList.find((m) => m.project_id === projectId && m.email === email)?.role ?? null; }
  async members(projectId: string) { return this.memberList.filter((m) => m.project_id === projectId); }
  async addMember(m: Member) { if (!(await this.roleOf(m.project_id, m.email))) this.memberList.push(m); }
  async removeMember(projectId: string, email: string) { this.memberList = this.memberList.filter((m) => !(m.project_id === projectId && m.email === email)); }
}
