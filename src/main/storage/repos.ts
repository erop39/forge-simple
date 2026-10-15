import type {
  GenerationParams, HiresSettings, Img2ImgSettings, UpscaleSettings, ImageQuery, ImageRecord, Job, JobError, JobStatus, JobType, NegativePreset, ServerInfo, Family, ModelKind,
} from '@shared/types'
import { PROFILES } from '@shared/profiles'
import type { Db } from './db'
import { buildImageQuery, ENHANCED_SQL, escapeLike } from './image-query'

export interface Server extends ServerInfo { lastConnectedAt: number | null }
export interface ImageRow extends Omit<ImageRecord, 'url' | 'thumbUrl' | 'tags' | 'locked'> { filePath: string; thumbPath: string }

type JobPatch = Partial<Pick<Job, 'error' | 'durationMs' | 'stepsPerSec' | 'peakVram'>>
type NewImage = Pick<ImageRow, 'jobId' | 'filePath' | 'thumbPath' | 'width' | 'height' | 'seed' | 'infotext' | 'durationMs'> & { sourceImageId?: number | null; hidden?: boolean }

/** Another saved (not removed) server already has that address. */
export class DuplicateServerError extends Error {
  constructor() {
    super('A saved server already has this address')
    this.name = 'DuplicateServerError'
  }
}

/** Another negative preset already has that name (names compare without case). */
export class DuplicatePresetError extends Error {
  constructor() {
    super('A negative preset already has this name')
    this.name = 'DuplicatePresetError'
  }
}

interface PresetSql { id: number; name: string; text: string; created_at: number }
const toPreset = (r: PresetSql): NegativePreset => ({ id: r.id, name: r.name, text: r.text, createdAt: r.created_at })
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'

interface ServerSql {
  id: number; name: string; url: string; active: number; last_connected_at: number | null; removed_at: number | null
}
interface JobSql {
  id: number; server_id: number; type: JobType; status: JobStatus; params: string; error: string | null
  created_at: number; finished_at: number | null; duration_ms: number | null
  steps_per_sec: number | null; peak_vram: number | null
}
export interface ModelMetaRow {
  family: Family | null; favorite: boolean; note: string; preview: string | null; triggers: string[] | null
}
interface ModelMetaSql {
  server_id: number; kind: string; filename: string; family: string | null; favorite: number
  note: string; preview: string | null; triggers: string | null
}
function toModelMeta(r: ModelMetaSql): ModelMetaRow {
  let triggers: string[] | null = null
  if (r.triggers !== null) {
    try {
      const parsed: unknown = JSON.parse(r.triggers)
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) triggers = parsed
    } catch { /* a damaged value counts as unset */ }
  }
  return { family: r.family && Object.hasOwn(PROFILES, r.family) ? (r.family as Family) : null, favorite: r.favorite === 1,
    note: r.note, preview: r.preview, triggers }
}

interface ImageSql {
  id: number; job_id: number; file_path: string; thumb_path: string; width: number; height: number
  seed: number; infotext: string; created_at: number; duration_ms: number | null
  hidden: number; source_image_id: number | null; enhanced: number
}

const FINISHED: readonly JobStatus[] = ['done', 'failed', 'interrupted', 'cancelled']

/** The SQL row maps to the domain type; `removed_at` stays inside the repo. */
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
export function isHiresSettings(value: unknown, width: number, height: number): value is HiresSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const h = value as Record<string, unknown>
  const scale = h.scale
  return typeof scale === 'number' && [1, 1.5, 2, 4].includes(scale)
    && typeof h.upscaler === 'string' && h.upscaler.trim() !== '' && h.upscaler.length <= 200
    && typeof h.secondPassSteps === 'number' && Number.isInteger(h.secondPassSteps)
    && h.secondPassSteps >= 1 && h.secondPassSteps <= 150
    && typeof h.denoisingStrength === 'number' && Number.isFinite(h.denoisingStrength)
    && h.denoisingStrength >= 0 && h.denoisingStrength <= 1
    && (h.cfgScale === undefined || (typeof h.cfgScale === 'number' && Number.isFinite(h.cfgScale) && h.cfgScale >= 0 && h.cfgScale <= 30))
    && Number.isFinite(width) && Number.isFinite(height)
    && width * scale <= 4096 && height * scale <= 4096
}

export function isImg2ImgSettings(value: unknown): value is Img2ImgSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return typeof o.sourceImageId === 'number' && Number.isSafeInteger(o.sourceImageId) && o.sourceImageId > 0
    && typeof o.denoisingStrength === 'number' && Number.isFinite(o.denoisingStrength)
    && o.denoisingStrength >= 0 && o.denoisingStrength <= 1
    && typeof o.resizeMode === 'number' && [0, 1, 2, 3].includes(o.resizeMode)
}

export function isUpscaleSettings(value: unknown): value is UpscaleSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return typeof o.sourceImageId === 'number' && Number.isSafeInteger(o.sourceImageId) && o.sourceImageId > 0
    && typeof o.upscaler === 'string' && o.upscaler.trim() !== '' && o.upscaler.length <= 200
    && typeof o.scale === 'number' && [1.5, 2, 4].includes(o.scale)
}

export function isGenerationParams(p: unknown): p is GenerationParams {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k])
  const str = (k: string) => typeof o[k] === 'string'
  return str('family') && str('checkpoint') && Array.isArray(o.modules) && o.modules.every((m) => typeof m === 'string')
    && str('prompt') && str('negativePrompt') && num('width') && num('height') && num('steps') && num('cfgScale')
    && num('distilledCfg') && str('sampler') && str('scheduler') && num('seed') && Array.isArray(o.loras)
    && (o.hires === undefined || isHiresSettings(o.hires, o.width as number, o.height as number))
    && (o.img2img === undefined || isImg2ImgSettings(o.img2img))
    && (o.upscale === undefined || isUpscaleSettings(o.upscale))
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
  hidden: r.hidden === 1, sourceImageId: r.source_image_id, enhanced: r.enhanced === 1,
})

export const TAG_MAX = 40
/** One tag name as stored: trimmed, inner whitespace collapsed; null when empty or longer than TAG_MAX. */
export function normalizeTag(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ')
  return name.length >= 1 && name.length <= TAG_MAX ? name : null
}
/** Normalised names (see normalizeTag); invalid ones dropped, duplicates in any case merged. */
export function normalizeTags(names: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of names) {
    const name = normalizeTag(raw)
    if (name === null) continue
    const key = name.toLowerCase()
    if (!seen.has(key)) seen.set(key, name)
  }
  return [...seen.values()]
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function createRepos(db: Db, now: () => number) {
  const serverByUrl = db.prepare('SELECT * FROM servers WHERE url = ?')
  const jobById = db.prepare('SELECT * FROM jobs WHERE id = ?')
  const imageById = db.prepare(`SELECT images.*, ${ENHANCED_SQL} FROM images WHERE id = ?`)

  const getJob = (id: number): Job | null => {
    const r = jobById.get(id) as JobSql | undefined
    return r ? toJob(r) : null
  }

  const liveById = db.prepare('SELECT * FROM servers WHERE id = ? AND removed_at IS NULL')
  const getServer = (id: number): Server | null => {
    const r = liveById.get(id) as ServerSql | undefined
    return r ? toServer(r) : null
  }
  /** The row holding `url`, live or removed. */
  const rowByUrl = (url: string): ServerSql | undefined => serverByUrl.get(url) as ServerSql | undefined

  function activate(id: number): Server | null {
    if (!getServer(id)) return null
    db.prepare('UPDATE servers SET active = 0 WHERE active = 1').run()
    db.prepare('UPDATE servers SET active = 1, last_connected_at = ? WHERE id = ?').run(now(), id)
    return getServer(id)
  }

  // Removed servers keep their row (jobs and images reference it) and are invisible everywhere else.
  // Their url still holds the UNIQUE slot: adding it again revives the row; another server taking it
  // over moves the removed row's url aside.
  const servers = {
    active(): Server | null {
      const r = db.prepare('SELECT * FROM servers WHERE active = 1 AND removed_at IS NULL').get() as ServerSql | undefined
      return r ? toServer(r) : null
    },
    /** A live (not removed) server, or null. */
    get: getServer,
    list(): Server[] {
      const rows = db.prepare('SELECT * FROM servers WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE, id')
        .all() as ServerSql[]
      return rows.map(toServer)
    },
    /** Adds an inactive server. Throws DuplicateServerError when a live server already has this url. */
    add(name: string, url: string): Server {
      return db.transaction((): Server => {
        const existing = rowByUrl(url)
        if (existing && existing.removed_at === null) throw new DuplicateServerError()
        if (existing) {
          db.prepare('UPDATE servers SET name = ?, active = 0, removed_at = NULL WHERE id = ?').run(name, existing.id)
          return getServer(existing.id) as Server
        }
        const res = db.prepare('INSERT INTO servers (name, url, active) VALUES (?, ?, 0)').run(name, url)
        return getServer(Number(res.lastInsertRowid)) as Server
      })()
    },
    /** Null when there is no such live server; throws DuplicateServerError when another live server has the url. */
    update(id: number, patch: { name: string; url: string }): Server | null {
      return db.transaction((): Server | null => {
        if (!getServer(id)) return null
        const holder = rowByUrl(patch.url)
        if (holder && holder.id !== id) {
          if (holder.removed_at === null) throw new DuplicateServerError()
          db.prepare('UPDATE servers SET url = ? WHERE id = ?').run(`${holder.url}#removed-${holder.id}`, holder.id)
        }
        db.prepare('UPDATE servers SET name = ?, url = ? WHERE id = ?').run(patch.name, patch.url, id)
        return getServer(id)
      })()
    },
    /** Makes `id` the only active server; null when there is no such live server. */
    activate(id: number): Server | null {
      return db.transaction(() => activate(id))()
    },
    /**
     * Soft-deletes a server and deletes its queued jobs and stored checkpoint families; finished jobs
     * and images stay. Null when there is no such live server.
     */
    remove(id: number): { server: Server; deletedJobIds: number[] } | null {
      return db.transaction(() => {
        const server = getServer(id)
        if (!server) return null
        const queued = db.prepare("SELECT id FROM jobs WHERE server_id = ? AND status = 'queued' ORDER BY id")
          .all(id) as { id: number }[]
        db.prepare("DELETE FROM jobs WHERE server_id = ? AND status = 'queued'").run(id)
        db.prepare('DELETE FROM checkpoint_meta WHERE server_id = ?').run(id)
        db.prepare('UPDATE servers SET active = 0, removed_at = ? WHERE id = ?').run(now(), id)
        return { server, deletedJobIds: queued.map((r) => r.id) }
      })()
    },
    /** Activates the server with `url`, adding it (named after its host) or reviving it as needed. */
    setActiveUrl(url: string): Server {
      return db.transaction((): Server => {
        const existing = rowByUrl(url)
        let id: number
        if (existing) {
          id = existing.id
          db.prepare('UPDATE servers SET removed_at = NULL WHERE id = ?').run(id)
        } else {
          id = Number(db.prepare('INSERT INTO servers (name, url, active) VALUES (?, ?, 0)').run(hostOf(url), url).lastInsertRowid)
        }
        return activate(id) as Server
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
    hasRunning(): boolean {
      return db.prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1").get() !== undefined
    },
    listActive(): Job[] {
      const rows = db.prepare(
        "SELECT * FROM jobs WHERE status IN ('queued', 'running', 'failed', 'interrupted') ORDER BY id",
      ).all() as JobSql[]
      return rows.map(toJob)
    },
    /** Deletes failed and interrupted jobs that left no image behind; returns their ids. */
    clearUnfinished(): number[] {
      return db.transaction(() => {
        const ids = (db.prepare(
          `SELECT id FROM jobs WHERE status IN ('failed', 'interrupted')
             AND NOT EXISTS (SELECT 1 FROM images WHERE images.job_id = jobs.id) ORDER BY id`,
        ).all() as { id: number }[]).map((r) => r.id)
        const remove = db.prepare('DELETE FROM jobs WHERE id = ?')
        for (const id of ids) remove.run(id)
        return ids
      })()
    },
    markRunningInterrupted(): number {
      return db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'")
        .run(now(), JSON.stringify({ code: 'stopped' } satisfies JobError)).changes
    },
  }

  const images = {
    get(id: number): ImageRow | null {
      const row = imageById.get(id) as ImageSql | undefined
      return row ? toImage(row) : null
    },
    insert(row: NewImage): ImageRow {
      const res = db.prepare(
        `INSERT INTO images (job_id, file_path, thumb_path, width, height, seed, infotext, created_at, duration_ms, source_image_id, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.jobId, row.filePath, row.thumbPath, row.width, row.height, row.seed, row.infotext, now(), row.durationMs, row.sourceImageId ?? null, row.hidden ? 1 : 0)
      return toImage(imageById.get(Number(res.lastInsertRowid)) as ImageSql)
    },
    list(opts: { limit: number; beforeId?: number }): ImageRow[] {
      const rows = (opts.beforeId === undefined
        ? db.prepare(`SELECT images.*, ${ENHANCED_SQL} FROM images ORDER BY id DESC LIMIT ?`).all(opts.limit)
        : db.prepare(`SELECT images.*, ${ENHANCED_SQL} FROM images WHERE id < ? ORDER BY id DESC LIMIT ?`).all(opts.beforeId, opts.limit)
      ) as ImageSql[]
      return rows.map(toImage)
    },
    /** Filtered, newest-first page; hidden images are left out of text/tag matches unless `revealHidden`. */
    query(q: ImageQuery, opts: { revealHidden: boolean }): ImageRow[] {
      const { sql, args } = buildImageQuery(q, opts.revealHidden)
      return (db.prepare(sql).all(...args) as ImageSql[]).map(toImage)
    },
    /** Sets the flag on the given ids; returns how many images exist among them. */
    setHidden(ids: number[], hidden: boolean): number {
      return db.transaction(() => {
        const stmt = db.prepare('UPDATE images SET hidden = ? WHERE id = ?')
        let n = 0
        for (const id of ids) n += stmt.run(hidden ? 1 : 0, id).changes
        return n
      })()
    },
    /** The stored file and thumbnail paths of every hidden image, as written (compare them normalised). */
    hiddenFilePaths(): string[] {
      const rows = db.prepare('SELECT file_path, thumb_path FROM images WHERE hidden = 1').all() as
        { file_path: string; thumb_path: string }[]
      return rows.flatMap((r) => [r.file_path, r.thumb_path])
    },
    /** True when the job made an image that is hidden now. */
    jobHasHidden(jobId: number): boolean {
      return db.prepare('SELECT 1 FROM images WHERE job_id = ? AND hidden = 1 LIMIT 1').get(jobId) !== undefined
    },
    delete(id: number): ImageRow | null {
      return db.transaction(() => {
        const r = imageById.get(id) as ImageSql | undefined
        if (!r) return null
        // A derivative remains a usable image when its original is removed.
        db.prepare('UPDATE images SET source_image_id = NULL WHERE source_image_id = ?').run(id)
        db.prepare('DELETE FROM images WHERE id = ?').run(id)
        deleteOrphanTags()
        return toImage(r)
      })()
    },
  }

  /** A tag no image uses is deleted. */
  function deleteOrphanTags(): void {
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM image_tags)').run()
  }
  const tags = {
    /** Tag names per image id, sorted; ids without tags are absent. */
    forImages(ids: number[]): Map<number, string[]> {
      const out = new Map<number, string[]>()
      if (ids.length === 0) return out
      const rows = db.prepare(
        `SELECT it.image_id AS image_id, t.name AS name FROM image_tags it JOIN tags t ON t.id = it.tag_id
         WHERE it.image_id IN (${ids.map(() => '?').join(',')}) ORDER BY ulower(t.name), t.id`,
      ).all(...ids) as { image_id: number; name: string }[]
      for (const r of rows) {
        const list = out.get(r.image_id)
        if (list) list.push(r.name)
        else out.set(r.image_id, [r.name])
      }
      return out
    },
    /**
     * Attaches the tags to every existing image in `imageIds`. A tag that exists in another case (any script,
     * see `ulower` in db.ts) is reused with its stored spelling; a missing one is created.
     */
    add(imageIds: number[], names: string[]): void {
      const clean = normalizeTags(names)
      if (clean.length === 0) return
      db.transaction(() => {
        const findTag = db.prepare('SELECT id FROM tags WHERE ulower(name) = ulower(?) ORDER BY id LIMIT 1')
        const insertTag = db.prepare('INSERT INTO tags (name) VALUES (?)')
        const link = db.prepare(
          'INSERT OR IGNORE INTO image_tags (image_id, tag_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM images WHERE id = ?)',
        )
        for (const name of clean) {
          const found = findTag.get(name) as { id: number } | undefined
          const id = found ? found.id : Number(insertTag.run(name).lastInsertRowid)
          for (const imageId of imageIds) link.run(imageId, id, imageId)
        }
        deleteOrphanTags()
      })()
    },
    /** Detaches the tags from the images, then deletes tags no image uses. */
    remove(imageIds: number[], names: string[]): void {
      const clean = normalizeTags(names)
      db.transaction(() => {
        const unlink = db.prepare(
          'DELETE FROM image_tags WHERE image_id = ? AND tag_id IN (SELECT id FROM tags WHERE ulower(name) = ulower(?))',
        )
        for (const name of clean) for (const imageId of imageIds) unlink.run(imageId, name)
        deleteOrphanTags()
      })()
    },
    /**
     * Tags starting with `prefix` (trimmed; case folded in any script), most used first; without `revealHidden`
     * only visible images count.
     */
    suggest(prefix: string, limit: number, opts: { revealHidden: boolean }): string[] {
      const like = `${escapeLike(prefix.trim())}%`
      const visible = opts.revealHidden ? '' : 'AND i.hidden = 0'
      const rows = db.prepare(
        `SELECT t.name AS name FROM tags t JOIN image_tags it ON it.tag_id = t.id JOIN images i ON i.id = it.image_id
         WHERE ulower(t.name) LIKE ulower(?) ESCAPE '\\' ${visible}
         GROUP BY t.id ORDER BY COUNT(*) DESC, ulower(t.name) LIMIT ?`,
      ).all(like, limit) as { name: string }[]
      return rows.map((r) => r.name)
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

  const presetById = db.prepare('SELECT * FROM negative_presets WHERE id = ?')
  const getPreset = (id: number): NegativePreset | null => {
    const r = presetById.get(id) as PresetSql | undefined
    return r ? toPreset(r) : null
  }
  /** Runs a write, turning a name clash into DuplicatePresetError. */
  const uniqueName = <T>(write: () => T): T => {
    try {
      return write()
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicatePresetError()
      throw err
    }
  }

  const negativePresets = {
    list(): NegativePreset[] {
      return (db.prepare('SELECT * FROM negative_presets ORDER BY name COLLATE NOCASE, id').all() as PresetSql[]).map(toPreset)
    },
    get: getPreset,
    /** Throws DuplicatePresetError when the name is taken (ignoring case). */
    add(name: string, text: string): NegativePreset {
      const res = uniqueName(() =>
        db.prepare('INSERT INTO negative_presets (name, text, created_at) VALUES (?, ?, ?)').run(name, text, now()))
      return getPreset(Number(res.lastInsertRowid)) as NegativePreset
    },
    /** Null when there is no such preset; throws DuplicatePresetError when another preset has the name. */
    update(id: number, patch: { name?: string; text?: string }): NegativePreset | null {
      const before = getPreset(id)
      if (!before) return null
      const next = { name: patch.name ?? before.name, text: patch.text ?? before.text }
      uniqueName(() => db.prepare('UPDATE negative_presets SET name = ?, text = ? WHERE id = ?').run(next.name, next.text, id))
      return getPreset(id)
    },
    /** The deleted preset, or null when there was none. */
    remove(id: number): NegativePreset | null {
      const before = getPreset(id)
      if (!before) return null
      db.prepare('DELETE FROM negative_presets WHERE id = ?').run(id)
      return before
    },
  }

  const metaGet = db.prepare('SELECT * FROM model_meta WHERE server_id = ? AND kind = ? AND filename = ?')
  const metaUpsert = (column: 'family' | 'favorite' | 'note' | 'preview' | 'triggers', value: string | number | null) =>
    (serverId: number, kind: ModelKind, filename: string): void => {
      db.prepare(`INSERT INTO model_meta (server_id, kind, filename, ${column}) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_id, kind, filename) DO UPDATE SET ${column} = excluded.${column}`).run(serverId, kind, filename, value)
    }
  const modelMeta = {
    /** Every stored row of one server and kind, by file name. */
    list(serverId: number, kind: ModelKind): Map<string, ModelMetaRow> {
      const rows = db.prepare('SELECT * FROM model_meta WHERE server_id = ? AND kind = ?').all(serverId, kind) as ModelMetaSql[]
      return new Map(rows.map((r) => [r.filename, toModelMeta(r)]))
    },
    get(serverId: number, kind: ModelKind, filename: string): ModelMetaRow | null {
      const r = metaGet.get(serverId, kind, filename) as ModelMetaSql | undefined
      return r ? toModelMeta(r) : null
    },
    setFamily: (serverId: number, kind: ModelKind, filename: string, family: Family | null): void =>
      metaUpsert('family', family)(serverId, kind, filename),
    setFavorite: (serverId: number, kind: ModelKind, filename: string, favorite: boolean): void =>
      metaUpsert('favorite', favorite ? 1 : 0)(serverId, kind, filename),
    setNote: (serverId: number, kind: ModelKind, filename: string, note: string): void =>
      metaUpsert('note', note)(serverId, kind, filename),
    setPreview: (serverId: number, kind: ModelKind, filename: string, preview: string): void =>
      metaUpsert('preview', preview)(serverId, kind, filename),
    /** null returns to the words found in the file's metadata. */
    setTriggers: (serverId: number, kind: ModelKind, filename: string, triggers: string[] | null): void =>
      metaUpsert('triggers', triggers === null ? null : JSON.stringify(triggers))(serverId, kind, filename),
    /** Forgets looked-up previews (a refreshed catalog may have new ones); the user's own marks stay. */
    clearPreviews(serverId: number): void {
      db.prepare('UPDATE model_meta SET preview = NULL WHERE server_id = ?').run(serverId)
    },
  }

  return { servers, jobs, images, tags, settings, negativePresets, modelMeta }
}
