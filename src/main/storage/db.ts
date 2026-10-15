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
  // 3: named negative prompts the user can put back into the Negative field.
  `CREATE TABLE negative_presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  text TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  // 4: image tags; a tag no image uses is deleted by the repos.
  `CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE image_tags (image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (image_id, tag_id));
CREATE INDEX image_tags_tag ON image_tags(tag_id);`,
  // 5: what the user (or the preview cache) knows about a checkpoint or LoRA file of one server.
  // preview: NULL not looked up yet, '' none found, else the cached file's extension.
  `CREATE TABLE model_meta (server_id INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL,
  family TEXT, favorite INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', preview TEXT, triggers TEXT,
  PRIMARY KEY (server_id, kind, filename));`,
]

export function openDb(path: string): Db {
  const db = new Database(path)
  // SQLite's NOCASE and LIKE fold ASCII only; tag identity and search use this Unicode-aware fold instead.
  db.function('ulower', { deterministic: true }, (s: unknown) => (s == null ? s : String(s).toLowerCase()))
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
