import Database from 'better-sqlite3'

export type Db = Database.Database

// Ordered migrations: index i upgrades user_version i to i + 1. Append new ones, never edit applied ones.
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0, last_connected_at INTEGER);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id),
  type TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER, steps_per_sec REAL, peak_vram INTEGER);
CREATE INDEX jobs_queue ON jobs(server_id, status, id);
CREATE TABLE images (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
  file_path TEXT NOT NULL, thumb_path TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  seed INTEGER NOT NULL, infotext TEXT NOT NULL, created_at INTEGER NOT NULL, duration_ms INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0, source_image_id INTEGER REFERENCES images(id));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE checkpoint_meta (server_id INTEGER NOT NULL, filename TEXT NOT NULL, family TEXT NOT NULL,
  preview_path TEXT, PRIMARY KEY (server_id, filename));
CREATE TABLE oplog (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL,
  message_key TEXT NOT NULL, duration_ms INTEGER, job_id INTEGER, details TEXT NOT NULL);
CREATE INDEX oplog_time ON oplog(time);
`,
  // 2: saved servers are soft-deleted (jobs and images keep pointing at them).
  `ALTER TABLE servers ADD COLUMN removed_at INTEGER;`,
]

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}
