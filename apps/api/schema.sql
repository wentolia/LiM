-- SABAKAN のメンバー表（Cloudflare D1）。起動時に自動で作られる（src/repo.ts の SCHEMA と同じ内容）
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_tokens (user_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, folder_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (project_id, email));
