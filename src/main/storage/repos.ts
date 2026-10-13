import type { GenerationParams, ImageRecord, Job, JobError, JobStatus, JobType } from '@shared/types'
import type { Db } from './db'

export interface Server { id: number; name: string; url: string; active: boolean; lastConnectedAt: number | null }
export interface ImageRow extends Omit<ImageRecord, 'url' | 'thumbUrl'> { filePath: string; thumbPath: string }

type JobPatch = Partial<Pick<Job, 'error' | 'durationMs' | 'stepsPerSec' | 'peakVram'>>
type NewImage = Pick<ImageRow, 'jobId' | 'filePath' | 'thumbPath' | 'width' | 'height' | 'seed' | 'infotext' | 'durationMs'>

interface ServerSql { id: number; name: string; url: string; active: number; last_connected_at: number | null }
interface JobSql {
  id: number; server_id: number; type: JobType; status: JobStatus; params: string; error: string | null
  created_at: number; finished_at: number | null; duration_ms: number | null
  steps_per_sec: number | null; peak_vram: number | null
}
interface ImageSql {
  id: number; job_id: number; file_path: string; thumb_path: string; width: number; height: number
  seed: number; infotext: string; created_at: number; duration_ms: number | null
  hidden: number; source_image_id: number | null
}

const FINISHED: readonly JobStatus[] = ['done', 'failed', 'interrupted', 'cancelled']

const toServer = (r: ServerSql): Server => ({
  id: r.id, name: r.name, url: r.url, active: r.active === 1, lastConnectedAt: r.last_connected_at,
})
/** A corrupt params column must not make the row unreadable; the runner fails such a job (see isGenerationParams). */
function parseParams(text: string): GenerationParams {
  try {
    const v: unknown = JSON.parse(text)
    // Anything but a plain object (null, numbers, strings, arrays) reads back as an empty object.
    return (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as GenerationParams
  } catch {
    return {} as GenerationParams
  }
}
function parseError(text: string | null): JobError | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string') return v as JobError
  } catch {
    // legacy plain-text value
  }
  return { code: 'unexpected', detail: text }
}

/** True when a stored params object has everything the request builder needs. */
export function isGenerationParams(p: unknown): p is GenerationParams {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k])
  const str = (k: string) => typeof o[k] === 'string'
  return str('family') && str('checkpoint') && Array.isArray(o.modules) && o.modules.every((m) => typeof m === 'string')
    && str('prompt') && str('negativePrompt') && num('width') && num('height') && num('steps') && num('cfgScale')
    && num('distilledCfg') && str('sampler') && str('scheduler') && num('seed') && Array.isArray(o.loras)
}

const toJob = (r: JobSql): Job => ({
  id: r.id, serverId: r.server_id, type: r.type, status: r.status,
  params: parseParams(r.params), error: parseError(r.error),
  createdAt: r.created_at, finishedAt: r.finished_at, durationMs: r.duration_ms,
  stepsPerSec: r.steps_per_sec, peakVram: r.peak_vram,
})
const toImage = (r: ImageSql): ImageRow => ({
  id: r.id, jobId: r.job_id, filePath: r.file_path, thumbPath: r.thumb_path, width: r.width, height: r.height,
  seed: r.seed, infotext: r.infotext, createdAt: r.created_at, durationMs: r.duration_ms,
  hidden: r.hidden === 1, sourceImageId: r.source_image_id,
})

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function createRepos(db: Db, now: () => number) {
  const serverByUrl = db.prepare('SELECT * FROM servers WHERE url = ?')
  const jobById = db.prepare('SELECT * FROM jobs WHERE id = ?')
  const imageById = db.prepare('SELECT * FROM images WHERE id = ?')

  const getJob = (id: number): Job | null => {
    const r = jobById.get(id) as JobSql | undefined
    return r ? toJob(r) : null
  }

  const servers = {
    active(): Server | null {
      const r = db.prepare('SELECT * FROM servers WHERE active = 1').get() as ServerSql | undefined
      return r ? toServer(r) : null
    },
    setActiveUrl(url: string): Server {
      return db.transaction((): Server => {
        db.prepare('UPDATE servers SET active = 0 WHERE active = 1').run()
        const existing = serverByUrl.get(url) as ServerSql | undefined
        if (existing) {
          db.prepare('UPDATE servers SET active = 1, last_connected_at = ? WHERE id = ?').run(now(), existing.id)
        } else {
          db.prepare('INSERT INTO servers (name, url, active, last_connected_at) VALUES (?, ?, 1, ?)')
            .run(hostOf(url), url, now())
        }
        return toServer(serverByUrl.get(url) as ServerSql)
      })()
    },
  }

  const jobs = {
    insert(serverId: number, type: JobType, params: GenerationParams): Job {
      const res = db.prepare(
        "INSERT INTO jobs (server_id, type, status, params, created_at) VALUES (?, ?, 'queued', ?, ?)",
      ).run(serverId, type, JSON.stringify(params), now())
      return getJob(Number(res.lastInsertRowid)) as Job
    },
    get: getJob,
    nextQueued(serverId: number): Job | null {
      const r = db.prepare("SELECT * FROM jobs WHERE server_id = ? AND status = 'queued' ORDER BY id LIMIT 1")
        .get(serverId) as JobSql | undefined
      return r ? toJob(r) : null
    },
    setStatus(id: number, status: JobStatus, patch: JobPatch = {}): Job {
      const sets = ['status = ?', 'finished_at = ?']
      const values: (string | number | null)[] = [status, FINISHED.includes(status) ? now() : null]
      const columns = { error: 'error', durationMs: 'duration_ms', stepsPerSec: 'steps_per_sec', peakVram: 'peak_vram' } as const
      for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
        if (patch[key] !== undefined) {
          sets.push(`${columns[key]} = ?`)
          values.push(key === 'error' ? (patch.error === null ? null : JSON.stringify(patch.error)) : (patch[key] as number | null))
        }
      }
      const res = db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
      if (res.changes === 0) throw new Error(`Job ${id} not found`)
      return getJob(id) as Job
    },
    listActive(): Job[] {
      const rows = db.prepare(
        "SELECT * FROM jobs WHERE status IN ('queued', 'running', 'failed', 'interrupted') ORDER BY id",
      ).all() as JobSql[]
      return rows.map(toJob)
    },
    markRunningInterrupted(): number {
      return db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'")
        .run(now(), JSON.stringify({ code: 'stopped' } satisfies JobError)).changes
    },
  }

  const images = {
    insert(row: NewImage): ImageRow {
      const res = db.prepare(
        `INSERT INTO images (job_id, file_path, thumb_path, width, height, seed, infotext, created_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.jobId, row.filePath, row.thumbPath, row.width, row.height, row.seed, row.infotext, now(), row.durationMs)
      return toImage(imageById.get(Number(res.lastInsertRowid)) as ImageSql)
    },
    list(opts: { limit: number; beforeId?: number }): ImageRow[] {
      const rows = (opts.beforeId === undefined
        ? db.prepare('SELECT * FROM images ORDER BY id DESC LIMIT ?').all(opts.limit)
        : db.prepare('SELECT * FROM images WHERE id < ? ORDER BY id DESC LIMIT ?').all(opts.beforeId, opts.limit)
      ) as ImageSql[]
      return rows.map(toImage)
    },
    delete(id: number): ImageRow | null {
      const r = imageById.get(id) as ImageSql | undefined
      if (!r) return null
      db.prepare('DELETE FROM images WHERE id = ?').run(id)
      return toImage(r)
    },
  }

  const settings = {
    get(key: string): string | null {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      return r ? r.value : null
    },
    set(key: string, value: string): void {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
    },
  }

  return { servers, jobs, images, settings }
}
