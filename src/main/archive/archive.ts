import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, statfs, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerationParams, JobType } from '@shared/types'
import { isGenerationParams, type ArchiveRow, type createRepos } from '../storage/repos'

type Repos = ReturnType<typeof createRepos>

export const ARCHIVE_FORMAT = 'forge-neo-client-archive'
export const ARCHIVE_VERSION = 1
const MAX_LABEL = 60

/** Why an archive could not be made or restored (the IPC layer maps these to error keys). */
export class ArchiveError extends Error {
  constructor(readonly code: 'nothing' | 'noSpace' | 'unreadable' | 'version' | 'noServer') {
    super(code)
  }
}

interface RecordJob { key: number; type: JobType; params: GenerationParams; createdAt: number; finishedAt: number | null; durationMs: number | null }
interface RecordImage {
  id: number; jobKey: number; file: string; thumb: string | null; sha256: string; bytes: number
  width: number; height: number; seed: number; infotext: string; durationMs: number | null; createdAt: number
  sourceImageId: number | null; tags: string[]
}
export interface ArchiveRecords { jobs: RecordJob[]; images: RecordImage[] }

export interface CreateDeps {
  repos: Repos
  /** The real path of a managed file; throws when it is outside the approved folders or gone. */
  resolveManaged(file: string): Promise<string>
  /** Removes one image from the gallery (files, row, events); false when that did not happen. */
  removeImage(id: number): Promise<boolean>
  now(): number
}

export interface CreateResult {
  archive: ArchiveRow
  archived: number
  skippedHidden: number
  /** Images whose file could not be read: they were left in the gallery. */
  unreadable: number
  /** Archived images that could not be removed from the gallery afterwards (the copy is safe). */
  notRemoved: number
  removedJobIds: number[]
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const day = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

/**
 * Moves images out of the gallery into a new archive folder under `archiveDir`: every file is copied and checked
 * (size and SHA-256 read back from the copy), the records and manifest are written, and only then are the images removed
 * from the gallery. Hidden images are never archived. Any failure before that removes the half-written folder and
 * leaves the gallery untouched.
 */
export async function createArchive(deps: CreateDeps, archiveDir: string, ids: number[], label: string): Promise<CreateResult> {
  const { repos } = deps
  const rows = [...new Set(ids)].flatMap((id) => { const r = repos.images.get(id); return r ? [r] : [] }).sort((a, b) => a.id - b.id)
  const visible = rows.filter((r) => !r.hidden)
  const skippedHidden = rows.length - visible.length

  // Files that cannot be read (gone, or outside the approved folders) stay where they are.
  const sources: { row: (typeof rows)[number]; file: string; thumb: string | null; bytes: number }[] = []
  let unreadable = 0
  for (const row of visible) {
    try {
      const file = await deps.resolveManaged(row.filePath)
      const thumb = await deps.resolveManaged(row.thumbPath).catch(() => null)
      sources.push({ row, file, thumb, bytes: (await stat(file)).size })
    } catch {
      unreadable++
    }
  }
  if (sources.length === 0) throw new ArchiveError('nothing')

  await mkdir(archiveDir, { recursive: true })
  const need = sources.reduce((sum, s) => sum + s.bytes, 0)
  const free = await statfs(archiveDir).then((s) => s.bavail * s.bsize, () => Number.POSITIVE_INFINITY)
  if (free < need * 1.05 + 1_000_000) throw new ArchiveError('noSpace')

  const base = `${day(deps.now())}-${slug(label.trim().slice(0, MAX_LABEL)) || 'archive'}`
  let name = base
  for (let n = 2; await exists(path.join(archiveDir, name)); n++) name = `${base}-${n}`
  const folder = path.join(archiveDir, name)

  try {
    await mkdir(path.join(folder, 'images'), { recursive: true })
    await mkdir(path.join(folder, 'thumbs'), { recursive: true })
    const tags = repos.tags.forImages(sources.map((s) => s.row.id))
    const jobs = new Map<number, RecordJob>()
    const images: RecordImage[] = []
    let bytes = 0
    for (const { row, file, thumb } of sources) {
      const job = repos.jobs.get(row.jobId)
      if (!job) throw new ArchiveError('unreadable')
      if (!jobs.has(job.id)) {
        jobs.set(job.id, { key: job.id, type: job.type, params: job.params, createdAt: job.createdAt, finishedAt: job.finishedAt, durationMs: job.durationMs })
      }
      const data = await readFile(file)
      const hash = sha256(data)
      const fileName = `${row.id}.png`
      await writeFile(path.join(folder, 'images', fileName), data)
      const copy = await readFile(path.join(folder, 'images', fileName))
      if (copy.length !== data.length || sha256(copy) !== hash) throw new ArchiveError('unreadable')
      let thumbName: string | null = null
      if (thumb) {
        thumbName = `${row.id}.jpg`
        await copyFile(thumb, path.join(folder, 'thumbs', thumbName))
      }
      bytes += data.length
      images.push({
        id: row.id, jobKey: job.id, file: fileName, thumb: thumbName, sha256: hash, bytes: data.length, width: row.width, height: row.height,
        seed: row.seed, infotext: row.infotext, durationMs: row.durationMs, createdAt: row.createdAt,
        sourceImageId: row.sourceImageId, tags: tags.get(row.id) ?? [],
      })
    }
    const records: ArchiveRecords = { jobs: [...jobs.values()], images }
    await writeFile(path.join(folder, 'records.json'), JSON.stringify(records), 'utf8')
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
      format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: new Date(deps.now()).toISOString(), images: images.length, bytes,
    }, null, 2), 'utf8')
    const archive = repos.archives.add(name, folder, images.length, bytes)

    // The copy is complete and verified: now the gallery lets go of the images.
    let notRemoved = 0
    for (const s of sources) if (!(await deps.removeImage(s.row.id))) notRemoved++
    const removedJobIds = repos.jobs.deleteDoneWithoutImages([...jobs.keys()])
    return { archive, archived: images.length, skippedHidden, unreadable, notRemoved, removedJobIds }
  } catch (err) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const plainName = (v: unknown): v is string => typeof v === 'string' && v !== '' && path.basename(v) === v && v !== '..' && v !== '.'
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/** Reads an archive folder's records; any fault is `ArchiveError('unreadable')`, an unknown format version `'version'`. */
export async function readArchive(folder: string): Promise<ArchiveRecords> {
  let manifest: unknown
  let records: unknown
  try {
    manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'))
    records = JSON.parse(await readFile(path.join(folder, 'records.json'), 'utf8'))
  } catch {
    throw new ArchiveError('unreadable')
  }
  if (!isObject(manifest) || manifest.format !== ARCHIVE_FORMAT) throw new ArchiveError('unreadable')
  if (manifest.version !== ARCHIVE_VERSION) throw new ArchiveError('version')
  if (!isObject(records) || !Array.isArray(records.jobs) || !Array.isArray(records.images)) throw new ArchiveError('unreadable')
  const bad = (): never => { throw new ArchiveError('unreadable') }
  const jobs = records.jobs.map((j: unknown): RecordJob => {
    if (!isObject(j) || !isInt(j.key) || (j.type !== 'txt2img' && j.type !== 'img2img' && j.type !== 'upscale') || !isGenerationParams(j.params)
      || !isInt(j.createdAt) || !(j.finishedAt === null || isInt(j.finishedAt)) || !(j.durationMs === null || isInt(j.durationMs))) return bad()
    return { key: j.key, type: j.type, params: j.params, createdAt: j.createdAt, finishedAt: j.finishedAt, durationMs: j.durationMs }
  })
  const keys = new Set(jobs.map((j) => j.key))
  const images = records.images.map((i: unknown): RecordImage => {
    if (!isObject(i) || !isInt(i.id) || !isInt(i.jobKey) || !keys.has(i.jobKey) || !plainName(i.file) || !(i.thumb === null || plainName(i.thumb))
      || typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256) || !isInt(i.bytes) || !isInt(i.width) || !isInt(i.height) || !isInt(i.seed)
      || typeof i.infotext !== 'string' || !(i.durationMs === null || isInt(i.durationMs)) || !isInt(i.createdAt)
      || !(i.sourceImageId === null || isInt(i.sourceImageId)) || !Array.isArray(i.tags) || !i.tags.every((t: unknown) => typeof t === 'string')) return bad()
    return {
      id: i.id, jobKey: i.jobKey, file: i.file, thumb: i.thumb, sha256: i.sha256, bytes: i.bytes, width: i.width, height: i.height, seed: i.seed,
      infotext: i.infotext, durationMs: i.durationMs, createdAt: i.createdAt, sourceImageId: i.sourceImageId, tags: i.tags as string[],
    }
  })
  return { jobs, images }
}

export interface RestoreDeps {
  repos: Repos
  serverId: number
  /** Writes a PNG (base64) into the images folder and makes its thumbnail. */
  saveImage(pngBase64: string, name: { jobId: number; seed: number; createdAt: number }): Promise<{ filePath: string; thumbPath: string; width: number; height: number }>
}
export interface RestoreResult { restored: number; alreadyThere: number; damaged: number }

/**
 * Puts an archive's images back into the gallery: each file is checked against its SHA-256, copied to the images folder,
 * and its job, row, original times and tags are recreated. An image already in the gallery (same seed and time) is
 * skipped, so restoring twice adds nothing.
 */
export async function restoreArchive(deps: RestoreDeps, folder: string): Promise<RestoreResult> {
  const records = await readArchive(folder)
  const jobIds = new Map<number, number>()
  const newIds = new Map<number, number>()
  const result: RestoreResult = { restored: 0, alreadyThere: 0, damaged: 0 }
  for (const image of [...records.images].sort((a, b) => a.id - b.id)) {
    if (deps.repos.images.exists(image.seed, image.createdAt)) { result.alreadyThere++; continue }
    let data: Buffer
    try {
      data = await readFile(path.join(folder, 'images', image.file))
    } catch {
      result.damaged++
      continue
    }
    if (data.length !== image.bytes || sha256(data) !== image.sha256) { result.damaged++; continue }
    const jobRecord = records.jobs.find((j) => j.key === image.jobKey)!
    let jobId = jobIds.get(jobRecord.key)
    if (jobId === undefined) {
      jobId = deps.repos.jobs.insertFinished(deps.serverId, jobRecord.type, jobRecord.params,
        { createdAt: jobRecord.createdAt, finishedAt: jobRecord.finishedAt, durationMs: jobRecord.durationMs }).id
      jobIds.set(jobRecord.key, jobId)
    }
    const saved = await deps.saveImage(data.toString('base64'), { jobId, seed: image.seed, createdAt: image.createdAt })
    const row = deps.repos.images.insert({
      jobId, filePath: saved.filePath, thumbPath: saved.thumbPath, width: saved.width, height: saved.height, seed: image.seed,
      infotext: image.infotext, durationMs: image.durationMs, createdAt: image.createdAt,
      sourceImageId: image.sourceImageId === null ? null : newIds.get(image.sourceImageId) ?? null,
    })
    newIds.set(image.id, row.id)
    if (image.tags.length > 0) deps.repos.tags.add([row.id], image.tags)
    result.restored++
  }
  return result
}
