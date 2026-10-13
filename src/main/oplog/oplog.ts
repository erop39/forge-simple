import type { OplogCategory, OplogEntry, OplogLevel } from '@shared/types'
import type { Db } from '../storage/db'

export interface OplogWrite {
  level: OplogLevel; category: OplogCategory; messageKey: string
  durationMs?: number; jobId?: number; details?: Record<string, unknown>
}
export interface OplogFilter {
  level?: OplogLevel; category?: OplogCategory; from?: number; to?: number; text?: string; limit?: number
}
export interface Oplog {
  write(e: OplogWrite): void
  list(f?: OplogFilter): OplogEntry[]
  purgeOlderThan(days: number): number
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5000
const DAY_MS = 86_400_000
const FORBIDDEN_KEYS = new Set(['prompt', 'negativePrompt'])

interface Row {
  id: number; time: number; level: OplogLevel; category: OplogCategory; message_key: string
  duration_ms: number | null; job_id: number | null; details: string
}

// Copies `value` without the prompt keys at any depth. A cycle is kept as-is so that
// serialisation fails later and the caller falls back to `{}`.
function stripPrompts(value: unknown, ancestors: unknown[] = []): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.includes(value)) return value
  const path = [...ancestors, value]
  if (Array.isArray(value)) return value.map((v) => stripPrompts(v, path))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!FORBIDDEN_KEYS.has(k)) out[k] = stripPrompts(v, path)
  }
  return out
}

function serialiseDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return '{}'
  try {
    return JSON.stringify(stripPrompts(details)) ?? '{}'
  } catch (err) {
    console.error('oplog: details could not be serialised, storing {}', err)
    return '{}'
  }
}

const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`)

const toEntry = (r: Row): OplogEntry => ({
  id: r.id, time: r.time, level: r.level, category: r.category, messageKey: r.message_key,
  durationMs: r.duration_ms, jobId: r.job_id, details: JSON.parse(r.details) as Record<string, unknown>,
})

export function createOplog(db: Db, now: () => number): Oplog {
  return {
    write(e) {
      try {
        db.prepare(
          'INSERT INTO oplog (time, level, category, message_key, duration_ms, job_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(now(), e.level, e.category, e.messageKey, e.durationMs ?? null, e.jobId ?? null, serialiseDetails(e.details))
      } catch (err) {
        console.error('oplog: write failed', err)
      }
    },

    list(f = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (f.level !== undefined) { where.push('level = ?'); args.push(f.level) }
      if (f.category !== undefined) { where.push('category = ?'); args.push(f.category) }
      if (f.from !== undefined) { where.push('time >= ?'); args.push(f.from) }
      if (f.to !== undefined) { where.push('time <= ?'); args.push(f.to) }
      if (f.text) {
        const like = `%${escapeLike(f.text)}%`
        where.push("(message_key LIKE ? ESCAPE '!' OR details LIKE ? ESCAPE '!')")
        args.push(like, like)
      }
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(f.limit ?? DEFAULT_LIMIT)))
      const sql = `SELECT * FROM oplog ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY time DESC, id DESC LIMIT ?`
      return (db.prepare(sql).all(...args, limit) as Row[]).map(toEntry)
    },

    purgeOlderThan(days) {
      return db.prepare('DELETE FROM oplog WHERE time < ?').run(now() - days * DAY_MS).changes
    },
  }
}
