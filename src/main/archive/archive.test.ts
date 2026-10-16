import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GenerationParams } from '@shared/types'
import { openDb } from '../storage/db'
import { createRepos } from '../storage/repos'
import { ArchiveError, createArchive, readArchive, restoreArchive, type CreateDeps } from './archive'

const params = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  family: 'sdxl', checkpoint: 'exampleMix_v10.safetensors [abc]', modules: [], prompt: 'a lighthouse', negativePrompt: 'n',
  width: 64, height: 64, steps: 20, cfgScale: 7, distilledCfg: 3.5, shift: null, clipSkip: null,
  sampler: 'Euler', scheduler: 'Simple', seed: -1, count: 1, loras: [], ...over,
})

let root: string
let repos: ReturnType<typeof createRepos>
let serverId: number
let time: number

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fnc-archive-'))
  mkdirSync(path.join(root, 'images'))
  time = new Date(2026, 9, 16, 12, 0, 0).getTime()
  repos = createRepos(openDb(':memory:'), () => time)
  serverId = repos.servers.add('Home', 'http://100.64.0.1:7860').id
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A saved image of a done job, with a PNG-ish file and a thumbnail on disk. */
function seed(seedValue: number, opts: { tags?: string[]; hidden?: boolean; sourceImageId?: number; jobId?: number } = {}) {
  const job = opts.jobId ? repos.jobs.get(opts.jobId)! : repos.jobs.insert(serverId, 'txt2img', params({ seed: seedValue }))
  repos.jobs.setStatus(job.id, 'done')
  const filePath = path.join(root, 'images', `${seedValue}.png`)
  const thumbPath = path.join(root, 'images', `${seedValue}.jpg`)
  writeFileSync(filePath, Buffer.from(`png-bytes-${seedValue}`))
  writeFileSync(thumbPath, Buffer.from(`thumb-${seedValue}`))
  time += 1000
  const row = repos.images.insert({
    jobId: job.id, filePath, thumbPath, width: 64, height: 64, seed: seedValue, infotext: `info ${seedValue}`, durationMs: 5,
    ...(opts.hidden ? { hidden: true } : {}), ...(opts.sourceImageId ? { sourceImageId: opts.sourceImageId } : {}),
  })
  if (opts.tags) repos.tags.add([row.id], opts.tags)
  return row
}

const deps = (over: Partial<CreateDeps> = {}): CreateDeps => ({
  repos,
  resolveManaged: async (file) => {
    if (!file.startsWith(path.join(root, 'images'))) throw new Error('outside')
    if (!existsSync(file)) throw new Error('gone')
    return file
  },
  removeImage: async (id) => {
    const row = repos.images.delete(id)
    if (!row) return false
    rmSync(row.filePath, { force: true })
    rmSync(row.thumbPath, { force: true })
    return true
  },
  now: () => time,
  ...over,
})

const archiveDir = (): string => path.join(root, 'archives')

test('archiving copies and verifies the files, writes records, then empties the gallery of those images and their jobs', async () => {
  const a = seed(11, { tags: ['harbour'] })
  const b = seed(12, { sourceImageId: a.id })
  const keep = seed(13)
  const result = await createArchive(deps(), archiveDir(), [a.id, b.id], 'Autumn portraits!')
  expect(result).toMatchObject({ archived: 2, skippedHidden: 0, unreadable: 0, notRemoved: 0 })
  expect(result.archive.name).toBe('2026-10-16-autumn-portraits')
  expect(result.removedJobIds).toHaveLength(2)
  expect(readdirSync(path.join(result.archive.path, 'images')).sort()).toEqual([`${a.id}.png`, `${b.id}.png`])
  expect(readdirSync(path.join(result.archive.path, 'thumbs')).sort()).toEqual([`${a.id}.jpg`, `${b.id}.jpg`])
  expect(readFileSync(path.join(result.archive.path, 'images', `${a.id}.png`), 'utf8')).toBe('png-bytes-11')
  const records = await readArchive(result.archive.path)
  expect(records.images.map((i) => [i.seed, i.tags, i.sourceImageId])).toEqual([[11, ['harbour'], null], [12, [], a.id]])
  expect(repos.images.get(a.id)).toBeNull()
  expect(repos.images.get(keep.id)).not.toBeNull()
  expect(repos.archives.list()).toHaveLength(1)
  expect(repos.archives.list()[0]).toMatchObject({ name: '2026-10-16-autumn-portraits', imageCount: 2 })
})

test('hidden images are never archived, files that cannot be read stay, and a second archive of the same day gets a new folder', async () => {
  const visible = seed(21)
  const hidden = seed(22, { hidden: true })
  const gone = seed(23)
  rmSync(gone.filePath)
  const first = await createArchive(deps(), archiveDir(), [visible.id, hidden.id, gone.id], '')
  expect(first).toMatchObject({ archived: 1, skippedHidden: 1, unreadable: 1 })
  expect(first.archive.name).toBe('2026-10-16-archive')
  expect(repos.images.get(hidden.id)).not.toBeNull()
  expect(repos.images.get(gone.id)).not.toBeNull()
  const next = seed(24)
  expect((await createArchive(deps(), archiveDir(), [next.id], '')).archive.name).toBe('2026-10-16-archive-2')
  await expect(createArchive(deps(), archiveDir(), [hidden.id], 'x')).rejects.toMatchObject({ code: 'nothing' })
})

test('a failure while copying leaves the gallery untouched and removes the half-written folder', async () => {
  const a = seed(31)
  const b = seed(32)
  // The second image's file turns into a directory, so reading it fails halfway through the archive.
  const broken = deps({ resolveManaged: async (file) => { if (file.endsWith('32.png')) { rmSync(file); mkdirSync(file) } return file } })
  await expect(createArchive(broken, archiveDir(), [a.id, b.id], 'x')).rejects.toThrow()
  expect(repos.images.get(a.id)).not.toBeNull()
  expect(repos.images.get(b.id)).not.toBeNull()
  expect(repos.archives.list()).toEqual([])
  expect(existsSync(archiveDir()) ? readdirSync(archiveDir()) : []).toEqual([])
})

test('restore brings images back with their jobs, times, tags and source links, and a second restore adds nothing', async () => {
  const a = seed(41, { tags: ['harbour', 'Dusk'] })
  const b = seed(42, { sourceImageId: a.id })
  const result = await createArchive(deps(), archiveDir(), [a.id, b.id], 'x')
  expect(repos.images.list({ limit: 10 })).toEqual([])
  const saved: string[] = []
  const restoreDeps = {
    repos, serverId,
    saveImage: async (base64: string, name: { jobId: number; seed: number }) => {
      const filePath = path.join(root, 'images', `restored-${name.seed}.png`)
      const thumbPath = path.join(root, 'images', `restored-${name.seed}.jpg`)
      writeFileSync(filePath, Buffer.from(base64, 'base64'))
      writeFileSync(thumbPath, 'thumb')
      saved.push(Buffer.from(base64, 'base64').toString())
      return { filePath, thumbPath, width: 64, height: 64 }
    },
  }
  expect(await restoreArchive(restoreDeps, result.archive.path)).toEqual({ restored: 2, alreadyThere: 0, damaged: 0 })
  expect(saved.sort()).toEqual(['png-bytes-41', 'png-bytes-42'])
  const rows = repos.images.list({ limit: 10 }).sort((x, y) => x.seed - y.seed)
  expect(rows.map((r) => [r.seed, r.createdAt === a.createdAt || r.createdAt === b.createdAt])).toEqual([[41, true], [42, true]])
  expect(rows[1]!.sourceImageId).toBe(rows[0]!.id)
  expect(repos.tags.forImages([rows[0]!.id]).get(rows[0]!.id)).toEqual(['Dusk', 'harbour'])
  expect(repos.jobs.get(rows[0]!.jobId)).toMatchObject({ status: 'done', serverId, params: { seed: 41 } })
  expect(await restoreArchive(restoreDeps, result.archive.path)).toEqual({ restored: 0, alreadyThere: 2, damaged: 0 })
})

test('restore skips a damaged file, and an unreadable or foreign folder is refused', async () => {
  const a = seed(51)
  const b = seed(52)
  const result = await createArchive(deps(), archiveDir(), [a.id, b.id], 'x')
  writeFileSync(path.join(result.archive.path, 'images', `${b.id}.png`), 'tampered')
  const restoreDeps = {
    repos, serverId,
    saveImage: async (_b: string, name: { seed: number }) => {
      const filePath = path.join(root, 'images', `r-${name.seed}.png`)
      writeFileSync(filePath, 'x')
      return { filePath, thumbPath: filePath, width: 64, height: 64 }
    },
  }
  expect(await restoreArchive(restoreDeps, result.archive.path)).toEqual({ restored: 1, alreadyThere: 0, damaged: 1 })
  await expect(restoreArchive(restoreDeps, path.join(root, 'nowhere'))).rejects.toBeInstanceOf(ArchiveError)
  writeFileSync(path.join(result.archive.path, 'manifest.json'), JSON.stringify({ format: 'forge-neo-client-archive', version: 2 }))
  await expect(restoreArchive(restoreDeps, result.archive.path)).rejects.toMatchObject({ code: 'version' })
  writeFileSync(path.join(result.archive.path, 'manifest.json'), JSON.stringify({ format: 'other', version: 1 }))
  await expect(readArchive(result.archive.path)).rejects.toMatchObject({ code: 'unreadable' })
})

test('records with a path in a file name are refused', async () => {
  const a = seed(61)
  const result = await createArchive(deps(), archiveDir(), [a.id], 'x')
  const recordsPath = path.join(result.archive.path, 'records.json')
  const records = JSON.parse(readFileSync(recordsPath, 'utf8')) as { images: { file: string }[] }
  records.images[0]!.file = '../../outside.png'
  writeFileSync(recordsPath, JSON.stringify(records))
  await expect(readArchive(result.archive.path)).rejects.toMatchObject({ code: 'unreadable' })
})

test('a failure while the images leave the gallery never deletes the verified archive', async () => {
  const a = seed(71)
  const b = seed(72)
  const c = seed(73)
  const failing = deps({
    removeImage: async (id) => {
      if (id === b.id) throw new Error('SQLITE_BUSY')
      const row = repos.images.delete(id)
      if (!row) return false
      rmSync(row.filePath, { force: true })
      rmSync(row.thumbPath, { force: true })
      return true
    },
  })
  const result = await createArchive(failing, archiveDir(), [a.id, b.id, c.id], 'x')
  expect(result).toMatchObject({ archived: 3, notRemoved: 1 })
  expect(existsSync(path.join(result.archive.path, 'images', `${a.id}.png`))).toBe(true)
  expect(existsSync(path.join(result.archive.path, 'images', `${b.id}.png`))).toBe(true)
  expect(repos.archives.list()).toHaveLength(1)
  expect(repos.images.get(b.id)).not.toBeNull()
  expect(repos.images.get(a.id)).toBeNull()
})

test('a failure while tidying jobs after the removal leaves the archive and the result intact', async () => {
  const a = seed(81)
  const realDelete = repos.jobs.deleteDoneWithoutImages
  repos.jobs.deleteDoneWithoutImages = () => { throw new Error('SQLITE_IOERR') }
  try {
    const result = await createArchive(deps(), archiveDir(), [a.id], 'x')
    expect(result).toMatchObject({ archived: 1, notRemoved: 0, removedJobIds: [] })
    expect(existsSync(path.join(result.archive.path, 'records.json'))).toBe(true)
  } finally {
    repos.jobs.deleteDoneWithoutImages = realDelete
  }
})
