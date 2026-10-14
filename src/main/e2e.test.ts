// End-to-end check of the main process without Electron: the real database (a temp file), the real
// image store (a temp folder, thumbnails stubbed), the real Forge client and catalog, and the real
// runner, all against the mock Forge.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultParams } from '@shared/profiles'
import type { GenerationParams, Job } from '@shared/types'
import { startMockForge, type MockForge } from '../../tools/mock-forge/server'
import { createActiveForge } from './forge/active-forge'
import { ForgeError, type ForgeClient } from './forge/client'
import { FINDINGS } from './forge/findings'
import { createOplog } from './oplog/oplog'
import { createRunner } from './queue/runner'
import { openDb, type Db } from './storage/db'
import { createImageStore, type MakeThumb } from './storage/image-store'
import { createRepos } from './storage/repos'

const WAIT = { timeout: 10_000, interval: 10 }

/** The mock's PNGs are 64×64; a real thumbnail needs Electron's nativeImage, so this stands in. */
const makeThumb: MakeThumb = (png) => ({ thumb: png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

/** Real timers, shortened so the 5 s pause between reconnect attempts does not slow the suite. */
const fastSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)))

let dir: string
const mocks: MockForge[] = []
const cleanups: (() => Promise<void> | void)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fnc-e2e-'))
})

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const m of mocks.splice(0)) await m.close()
  rmSync(dir, { recursive: true, force: true })
})

async function mockForge(port?: number): Promise<MockForge> {
  const m = await startMockForge({ stepMs: 5, ...(port !== undefined ? { port } : {}) })
  mocks.push(m)
  return m
}

/** One "launch" of the app's main side on the database file in `dir`. */
function launch(serverUrl: string, opts: { client?: (real: ForgeClient) => ForgeClient } = {}) {
  const db: Db = openDb(join(dir, 'fnc.db'))
  const now = (): number => Date.now()
  const repos = createRepos(db, now)
  const oplog = createOplog(db, now)
  repos.servers.setActiveUrl(serverUrl)
  const forge = createActiveForge({ activeUrl: () => repos.servers.active()?.url ?? null, familyOverride: () => null, oplog, now })
  const images = createImageStore(() => join(dir, 'images'), makeThumb)
  const runner = createRunner({
    client: () => (opts.client ? opts.client(forge.client()) : forge.client()),
    catalog: () => forge.catalog().get(),
    findings: FINDINGS,
    repos,
    images,
    oplog,
    events: { jobUpdate: () => undefined, jobProgress: () => undefined, imageAdded: () => undefined },
    now,
    sleep: fastSleep,
  })
  let closed = false
  const quit = async (): Promise<void> => {
    if (closed) return
    closed = true
    await runner.stop()
    db.close()
  }
  cleanups.push(quit)

  async function params(over: Partial<GenerationParams> = {}): Promise<GenerationParams> {
    const catalog = await forge.catalog().get()
    const ckpt = catalog.checkpoints.find((c) => c.family === 'sdxl')
    if (!ckpt) throw new Error('the mock has no SDXL checkpoint')
    return { ...defaultParams('sdxl', ckpt.title, catalog), prompt: 'a lighthouse at dusk', steps: 8, ...over }
  }
  const job = (id: number): Job => {
    const j = repos.jobs.get(id)
    if (!j) throw new Error(`job ${id} is gone`)
    return j
  }

  return { db, repos, oplog, runner, params, job, quit }
}

test('enqueue two images → both done, two files on disk, log has start/finish pairs with durations', async () => {
  const mock = await mockForge()
  const app = launch(mock.url)
  app.runner.start()
  const [a, b] = app.runner.enqueue(await app.params({ count: 2 }))
  if (!a || !b) throw new Error('expected two jobs')

  await vi.waitFor(() => {
    expect(app.job(a.id).status).toBe('done')
    expect(app.job(b.id).status).toBe('done')
  }, WAIT)

  const rows = app.repos.images.list({ limit: 10 })
  expect(rows.map((r) => r.jobId).sort()).toEqual([a.id, b.id].sort())
  for (const r of rows) {
    expect(existsSync(r.filePath)).toBe(true)
    expect(existsSync(r.thumbPath)).toBe(true)
    expect(r.filePath.startsWith(join(dir, 'images'))).toBe(true)
    expect([r.width, r.height]).toEqual([64, 64])
  }

  const txt2img = mock.requests.filter((r) => r.path === '/sdapi/v1/txt2img')
  expect(txt2img).toHaveLength(2)
  for (const r of txt2img) {
    expect(r.body).toMatchObject({ batch_size: 1, n_iter: 1, save_images: false, override_settings_restore_afterwards: false })
  }

  for (const id of [a.id, b.id]) {
    const entries = app.oplog.list({ category: 'generation' }).filter((e) => e.jobId === id)
    expect(entries.map((e) => e.messageKey).sort()).toEqual(['log.generation.finished', 'log.generation.started'])
    const finished = entries.find((e) => e.messageKey === 'log.generation.finished')
    expect(finished?.durationMs).toBeGreaterThan(0)
    expect(app.job(id).durationMs).toBe(finished?.durationMs)
  }
  expect(JSON.stringify(app.oplog.list())).not.toContain('lighthouse')
})

test('server goes down mid-queue → first job interrupted, second stays queued; after restart the second completes', async () => {
  const mock = await mockForge()
  const port = Number(new URL(mock.url).port)
  const app = launch(mock.url)
  app.runner.start()
  // The first generation is long enough to still be running when the server goes away.
  const [first] = app.runner.enqueue(await app.params({ steps: 400 }))
  const [second] = app.runner.enqueue(await app.params())
  if (!first || !second) throw new Error('expected two jobs')

  await vi.waitFor(() => {
    expect(app.job(first.id).status).toBe('running')
    expect(mock.requests.some((r) => r.path === '/sdapi/v1/txt2img')).toBe(true)
  }, WAIT)
  await mock.close()

  await vi.waitFor(() => {
    expect(app.job(first.id).status).toBe('interrupted')
    expect(app.oplog.list().map((e) => e.messageKey)).toContain('log.queue.paused')
  }, WAIT)
  expect(app.job(first.id).error).toMatchObject({ code: 'network' })
  // Several reconnect attempts pass while the server is down; the second job never starts.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(app.job(second.id).status).toBe('queued')

  await mockForge(port)
  await vi.waitFor(() => expect(app.job(second.id).status).toBe('done'), WAIT)
  expect(app.job(first.id).status).toBe('interrupted')
  expect(app.repos.images.list({ limit: 10 }).map((r) => r.jobId)).toEqual([second.id])
  expect(app.oplog.list().map((e) => e.messageKey)).toContain('log.queue.resumed')
})

test('restart of the app with a running job → recover() marks it interrupted and the queue continues', async () => {
  const mock = await mockForge()

  // First launch: the generation request never answers, as if the app died while it ran.
  const hanging = (real: ForgeClient): ForgeClient => ({
    ...real,
    txt2img: (_body, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new ForgeError('network', 'aborted', { detail: 'aborted' })))
    }),
  })
  const before = launch(mock.url, { client: hanging })
  before.runner.start()
  const [first, second] = before.runner.enqueue(await before.params({ count: 2 }))
  if (!first || !second) throw new Error('expected two jobs')
  await vi.waitFor(() => expect(before.job(first.id).status).toBe('running'), WAIT)

  // Second launch on the same database file, before the first one has written anything more.
  const after = launch(mock.url)
  expect(after.job(first.id).status).toBe('running')
  after.runner.recover()
  expect(after.job(first.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
  expect(after.oplog.list().map((e) => e.messageKey)).toContain('log.queue.recovered')

  after.runner.start()
  await vi.waitFor(() => expect(after.job(second.id).status).toBe('done'), WAIT)
  expect(after.job(first.id).status).toBe('interrupted')
  expect(after.repos.images.list({ limit: 10 }).map((r) => r.jobId)).toEqual([second.id])

  // The dead launch is shut down only now so it cannot touch the queue during the check.
  await after.quit()
  await before.quit()
})
