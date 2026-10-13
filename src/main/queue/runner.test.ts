import { defaultParams } from '@shared/profiles'
import type { Catalog, GenerationParams, Job, JobProgress } from '@shared/types'
import { ForgeError, type ForgeClient, type GenerationResponse, type ProgressResponse } from '../forge/client'
import type { ProbeFindings } from '../forge/findings'
import { createOplog, type Oplog } from '../oplog/oplog'
import { openDb, type Db } from '../storage/db'
import type { createImageStore } from '../storage/image-store'
import { createRepos, type ImageRow } from '../storage/repos'
import { createRunner } from './runner'

const FINDINGS: ProbeFindings = { shiftOptionKey: 'some_shift', modulesAs: 'path', thumbRoute: false }
const CKPT = 'sd_xl_base.safetensors [abc]'
const CKPT2 = 'other.safetensors [def]'
const avail = { samplers: ['Euler a'], schedulers: ['Automatic'] }

const catalogWith = (titles: string[]): Catalog => ({
  checkpoints: titles.map((title) => ({ title, name: title, filename: title, family: 'sdxl' as const })),
  modules: [], loras: [], samplers: ['Euler a'], schedulers: ['Automatic'], upscalers: [], loadedCheckpoint: null, fetchedAt: 0,
})

const SECRET = 'SECRET-PROMPT-TEXT'
const params = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  ...defaultParams('sdxl', CKPT, avail), prompt: SECRET, negativePrompt: `${SECRET}-neg`, seed: -1, count: 1, ...over,
})

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const response = (n = 1, info: unknown = { all_seeds: [111, 222], infotexts: ['info A', 'info B'] }): GenerationResponse => ({
  images: Array.from({ length: n }, (_, i) => `png${i}`),
  info: typeof info === 'string' ? info : JSON.stringify(info),
})
const progressAt = (step: number, image: string | null = null): ProgressResponse => ({
  progress: 0, eta_relative: 0, current_image: image,
  state: { sampling_step: step, sampling_steps: 28, job_no: 0, job_count: 1 },
})

let db: Db
afterEach(() => { if (db?.open) db.close() })

function setup(opts: { catalog?: Catalog; autoComplete?: boolean; abortResolves?: boolean } = {}) {
  db = openDb(':memory:')
  let clock = 0
  const now = () => clock
  const repos = createRepos(db, now)
  const oplog: Oplog = createOplog(db, now)
  repos.servers.setActiveUrl('http://forge.test')

  const events: string[] = []
  const updates: Job[] = []
  const progress: JobProgress[] = []
  const added: ImageRow[] = []

  const gens: Deferred<GenerationResponse>[] = []
  const signals: AbortSignal[] = []
  const state = { clientOverride: null as unknown, pingOk: true, progress: progressAt(0, null) as ProgressResponse | Error, catalog: opts.catalog ?? catalogWith([CKPT, CKPT2]) as Catalog | Error }
  const client = {
    ping: vi.fn(async () => {
      if (!state.pingOk) throw new ForgeError('network', 'down')
      return 5
    }),
    txt2img: vi.fn((_body: unknown, signal?: AbortSignal) => {
      const d = deferred<GenerationResponse>()
      gens.push(d)
      if (signal) {
        signals.push(signal)
        signal.addEventListener('abort', () => {
          if (opts.abortResolves) d.resolve(response())
          else d.reject(new ForgeError('network', 'aborted'))
        })
      }
      if (opts.autoComplete) d.resolve(response())
      return d.promise
    }),
    progress: vi.fn(async () => {
      if (state.progress instanceof Error) throw state.progress
      return state.progress
    }),
    interrupt: vi.fn(async () => undefined),
  }

  const sleeps: { ms: number; d: Deferred<void>; used: boolean }[] = []
  const images = {
    save: vi.fn(async (_b64: string, n: { jobId: number; seed: number }) => ({
      filePath: `/img/${n.jobId}-${n.seed}.png`, thumbPath: `/img/t/${n.jobId}-${n.seed}.jpg`, width: 896, height: 1152,
    })),
    remove: vi.fn(async () => undefined),
  }

  const runner = createRunner({
    client: () => (state.clientOverride ?? client) as ForgeClient,
    catalog: async () => {
      if (state.catalog instanceof Error) throw state.catalog
      return state.catalog
    },
    findings: FINDINGS,
    repos,
    images: images as unknown as ReturnType<typeof createImageStore>,
    oplog,
    events: {
      jobUpdate: (j) => { updates.push(j); events.push(`update:${j.status}`) },
      jobProgress: (p) => { progress.push(p); events.push('progress') },
      imageAdded: (r) => { added.push(r); events.push('image') },
    },
    now,
    sleep: (ms) => { const d = deferred<void>(); sleeps.push({ ms, d, used: false }); return d.promise },
  })

  const at = (t: number) => { clock = t }
  /** Lets the in-flight request's progress poll fire once, with Forge reporting `step`. */
  async function poll(step: number, t: number, image: string | null = null) {
    state.progress = progressAt(step, image)
    at(t)
    const before = progress.length
    const s = sleeps.find((x) => x.ms === 1000 && !x.used)
    if (!s) throw new Error('no pending progress sleep')
    s.used = true
    s.d.resolve()
    await vi.waitFor(() => expect(progress.length).toBe(before + 1))
  }
  const started = (n = 1) => vi.waitFor(() => expect(client.txt2img).toHaveBeenCalledTimes(n))

  return { repos, oplog, client, gens, signals, sleeps, images, runner, events, updates, progress, added, state, at, poll, started }
}


const statuses = (h: ReturnType<typeof setup>) => h.repos.jobs.listActive().map((j) => j.status)
const logKeys = (h: ReturnType<typeof setup>) => h.oplog.list().reverse().map((e) => e.messageKey)

test('enqueue creates count jobs; a fixed seed increments, -1 stays -1', () => {
  const h = setup()
  const random = h.runner.enqueue(params({ count: 3 }))
  expect(random.map((j) => j.params.seed)).toEqual([-1, -1, -1])
  expect(random.every((j) => j.params.count === 1 && j.status === 'queued')).toBe(true)
  const fixed = h.runner.enqueue(params({ count: 3, seed: 100 }))
  expect(fixed.map((j) => j.params.seed)).toEqual([100, 101, 102])
  const added = h.oplog.list({ category: 'queue' })
  expect(added).toHaveLength(6)
  expect(added.every((e) => e.messageKey === 'log.queue.added' && e.jobId !== null)).toBe(true)
})

test('enqueue without an active server throws, and tick is idle', async () => {
  const h = setup()
  db.prepare('UPDATE servers SET active = 0').run()
  expect(() => h.runner.enqueue(params())).toThrow()
  expect(await h.runner.tick()).toBe('idle')
})

test('tick with an empty queue → idle', async () => {
  const h = setup()
  expect(await h.runner.tick()).toBe('idle')
  expect(h.client.ping).not.toHaveBeenCalled()
})

test('tick when ping fails → paused, job stays queued', async () => {
  const h = setup()
  h.runner.enqueue(params())
  h.state.pingOk = false
  expect(await h.runner.tick()).toBe('paused')
  expect(statuses(h)).toEqual(['queued'])
  expect(h.client.txt2img).not.toHaveBeenCalled()
  await h.runner.tick()
  expect(logKeys(h).filter((k) => k === 'log.queue.paused')).toHaveLength(1)
})

test('tick when the catalog cannot be loaded → paused, job stays queued', async () => {
  const h = setup()
  h.runner.enqueue(params())
  h.state.catalog = new ForgeError('network', 'down')
  expect(await h.runner.tick()).toBe('paused')
  expect(statuses(h)).toEqual(['queued'])
})

test('success: job goes running → done, image row saved, events fired in order', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  await h.poll(4, 1000)
  await h.poll(10, 2000)
  h.at(3500)
  h.gens[0]!.resolve(response())
  expect(await t).toBe('ran')

  expect(h.events).toEqual(['update:running', 'progress', 'progress', 'image', 'update:done'])
  const done = h.repos.jobs.get(job.id) as Job
  expect(done.status).toBe('done')
  expect(done.durationMs).toBe(3500)
  expect(done.stepsPerSec).toBe(6)
  expect(h.repos.images.list({ limit: 10 })).toHaveLength(1)
  expect(h.images.save).toHaveBeenCalledWith('png0', { jobId: job.id, seed: 111, createdAt: 3500 })
  const finish = h.oplog.list({ category: 'generation' })[0]
  expect(finish).toMatchObject({ messageKey: 'log.generation.finished', durationMs: 3500, jobId: job.id })
  expect(finish!.details).toEqual({ checkpoint: CKPT, width: 896, height: 1152, steps: 28, seed: 111, images: 1 })
})

test('progress events carry step, totalSteps, stepsPerSec and a data-URL preview', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  await h.poll(4, 1000, 'AAAA')
  await h.poll(10, 3000)
  expect(h.progress[0]).toEqual({
    jobId: job.id, step: 4, totalSteps: 28, stage: 'sampling', stepsPerSec: null, elapsedMs: 1000,
    preview: 'data:image/png;base64,AAAA',
  })
  expect(h.progress[1]).toMatchObject({ step: 10, stepsPerSec: 3, elapsedMs: 3000, preview: null })
  h.gens[0]!.resolve(response())
  await t
})

test('a failing progress poll is ignored; polling stops once the request settled', async () => {
  const h = setup()
  h.runner.enqueue(params())
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.state.progress = new Error('boom')
  h.sleeps[0]!.used = true
  h.sleeps[0]!.d.resolve()
  await vi.waitFor(() => expect(h.client.progress).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(h.sleeps).toHaveLength(2)) // it went on to wait for the next poll
  h.gens[0]!.resolve(response())
  expect(await t).toBe('ran')
  expect(h.progress).toHaveLength(0)
  h.sleeps.forEach((s) => s.d.resolve())
  await Promise.resolve()
  await Promise.resolve()
  expect(h.client.progress).toHaveBeenCalledTimes(1)
})

test('seed and infotext come from info.all_seeds[0] and info.infotexts[0]', async () => {
  const h = setup({ autoComplete: true })
  h.runner.enqueue(params())
  await h.runner.tick()
  const [row] = h.repos.images.list({ limit: 1 })
  expect(row).toMatchObject({ seed: 111, infotext: 'info A' })
})

test.each([
  ['not json', 'not json {'],
  ['json null', 'null'],
  ['empty object', '{}'],
  ['wrong types', JSON.stringify({ all_seeds: ['x'], infotexts: [5] })],
])('malformed info (%s) → image saved with seed -1 and empty infotext', async (_n, info) => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.gens[0]!.resolve({ images: ['png0'], info })
  await t
  expect(h.repos.jobs.get(job.id)?.status).toBe('done')
  expect(h.repos.images.list({ limit: 1 })[0]).toMatchObject({ seed: -1, infotext: '' })
})

test('response with no images → failed', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.gens[0]!.resolve({ images: [], info: '{}' })
  expect(await t).toBe('ran')
  expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'noImages' } })
})

test('ForgeError http → failed with detail; next tick runs the next job', async () => {
  const h = setup()
  const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(1))
  h.gens[0]!.reject(new ForgeError('http', 'HTTP 500', { status: 500, detail: 'CUDA out of memory' }))
  expect(await t).toBe('ran')
  expect(h.repos.jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'forgeHttp', status: 500, detail: 'CUDA out of memory' } })
  const err = h.oplog.list({ category: 'error' })
  expect(err).toHaveLength(1)
  expect(err[0]).toMatchObject({ level: 'error', jobId: a.id })

  const t2 = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(2))
  h.gens[1]!.resolve(response())
  await t2
  expect(h.repos.jobs.get(b.id)?.status).toBe('done')
})

test('ForgeError without detail falls back to kind and status', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.gens[0]!.reject(new ForgeError('http', 'HTTP 503', { status: 503 }))
  await t
  expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'forgeHttp', status: 503 })
})

test('ForgeError network during generation → interrupted and tick returns paused', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.gens[0]!.reject(new ForgeError('network', 'socket hang up'))
  expect(await t).toBe('paused')
  expect(h.repos.jobs.get(job.id)?.status).toBe('interrupted')
  expect(h.oplog.list({ category: 'error' })).toHaveLength(1)
})

test('image store failure → failed, error entry logged with the path, queue continues', async () => {
  const h = setup()
  const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
  h.images.save.mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { path: '/img/a.png' }))
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(1))
  h.gens[0]!.resolve(response())
  expect(await t).toBe('ran')
  expect(h.repos.jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'storage', detail: 'ENOSPC: no space left' } })
  const err = h.oplog.list({ category: 'error' })
  expect(err).toHaveLength(1)
  expect(err[0]!.details).toMatchObject({ path: '/img/a.png', detail: 'ENOSPC: no space left' })
  expect(h.repos.images.list({ limit: 10 })).toHaveLength(0)

  const t2 = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(2))
  h.gens[1]!.resolve(response())
  await t2
  expect(h.repos.jobs.get(b.id)?.status).toBe('done')
})

test('database failure while inserting an image row → failed, the stored file is removed', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const spy = vi.spyOn(h.repos.images, 'insert').mockImplementationOnce(() => { throw new Error('db locked') })
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.gens[0]!.resolve(response())
  expect(await t).toBe('ran')
  spy.mockRestore()
  expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'storage', detail: 'db locked' } })
  expect(h.images.remove).toHaveBeenCalledWith(`/img/${job.id}-111.png`, `/img/t/${job.id}-111.jpg`)
  expect(h.oplog.list({ category: 'error' })[0]!.details).toMatchObject({ path: `/img/${job.id}-111.png` })
})

test('missing checkpoint → failed before any request, error names the file', async () => {
  const h = setup({ catalog: catalogWith([CKPT2]) })
  const [job] = h.runner.enqueue(params()) as [Job]
  expect(await h.runner.tick()).toBe('ran')
  expect(h.client.txt2img).not.toHaveBeenCalled()
  const j = h.repos.jobs.get(job.id) as Job
  expect(j.status).toBe('failed')
  expect(j.error).toEqual({ code: 'missingParts', missing: [CKPT] })
  expect(h.oplog.list({ category: 'error' })).toHaveLength(1)
})

test('missing module and checkpoint are all named', async () => {
  const h = setup({ catalog: catalogWith([CKPT2]) })
  const [job] = h.runner.enqueue(params({ modules: ['/m/vae.safetensors'] })) as [Job]
  await h.runner.tick()
  expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'missingParts', missing: [CKPT, '/m/vae.safetensors'] })
})

test('cancel on a queued job → cancelled without calling interrupt', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  await h.runner.cancel(job.id)
  expect(h.repos.jobs.get(job.id)?.status).toBe('cancelled')
  expect(h.client.interrupt).not.toHaveBeenCalled()
  expect(await h.runner.tick()).toBe('idle')
  expect(h.oplog.list({ category: 'queue' })[0]!.messageKey).toBe('log.queue.cancelled')
})

test('cancel on a finished job is a no-op', async () => {
  const h = setup({ autoComplete: true })
  const [job] = h.runner.enqueue(params()) as [Job]
  await h.runner.tick()
  await h.runner.cancel(job.id)
  expect(h.repos.jobs.get(job.id)?.status).toBe('done')
  expect(h.client.interrupt).not.toHaveBeenCalled()
})

test.each([
  ['the request rejects on abort', 'reject'],
  ['Forge still returns images', 'resolve'],
])('cancel on the running job → interrupt called, status cancelled, no image saved (%s)', async (_n, how) => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  const gen = h.gens[0]!
  if (how === 'resolve') {
    h.client.interrupt.mockImplementationOnce(async () => { gen.resolve(response()) })
  }
  await h.runner.cancel(job.id)
  expect(h.client.interrupt).toHaveBeenCalledTimes(1)
  expect(h.signals[0]!.aborted).toBe(true)
  expect(await t).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.status).toBe('cancelled')
  expect(h.images.save).not.toHaveBeenCalled()
  expect(h.repos.images.list({ limit: 10 })).toHaveLength(0)
})

test('cancel still works when interrupt fails', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
  h.client.interrupt.mockRejectedValueOnce(new ForgeError('network', 'down'))
  await h.runner.cancel(job.id)
  await t
  expect(h.repos.jobs.get(job.id)?.status).toBe('cancelled')
})

test('cancel while the job is still being checked does not let it start', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const ping = deferred<number>()
  h.client.ping.mockReturnValueOnce(ping.promise)
  const t = h.runner.tick()
  await h.runner.cancel(job.id)
  ping.resolve(1)
  await t
  expect(h.client.txt2img).not.toHaveBeenCalled()
  expect(h.repos.jobs.get(job.id)?.status).toBe('cancelled')
})

test('retry clones params into a new queued job; the original stays as it was', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params({ seed: 7 })) as [Job]
  await h.runner.cancel(job.id)
  const clone = h.runner.retry(job.id)
  expect(clone.id).not.toBe(job.id)
  expect(clone).toMatchObject({ status: 'queued', serverId: job.serverId, params: job.params })
  expect(h.repos.jobs.get(job.id)?.status).toBe('cancelled')
})

test('retry works for failed and interrupted jobs and throws otherwise', () => {
  const h = setup()
  const [q] = h.runner.enqueue(params()) as [Job]
  expect(() => h.runner.retry(q.id)).toThrow()
  expect(() => h.runner.retry(9999)).toThrow()
  h.repos.jobs.setStatus(q.id, 'failed', { error: { code: 'unexpected' } })
  expect(h.runner.retry(q.id).status).toBe('queued')
  h.repos.jobs.setStatus(q.id, 'interrupted')
  expect(h.runner.retry(q.id).status).toBe('queued')
  h.repos.jobs.setStatus(q.id, 'done')
  expect(() => h.runner.retry(q.id)).toThrow()
})

test('recover marks running jobs interrupted', () => {
  const h = setup()
  const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
  h.repos.jobs.setStatus(a.id, 'running')
  h.runner.recover()
  expect(h.repos.jobs.get(a.id)?.status).toBe('interrupted')
  expect(h.repos.jobs.get(b.id)?.status).toBe('queued')
})

test('logs generation start and finish with duration; logs checkpoint change only when it differs from the previous done job', async () => {
  const h = setup({ autoComplete: true })
  h.runner.enqueue(params({ count: 2 }))
  h.runner.enqueue(params({ checkpoint: CKPT2 }))
  h.at(100)
  await h.runner.tick()
  await h.runner.tick()
  await h.runner.tick()

  const keys = logKeys(h).filter((k) => !k.startsWith('log.queue'))
  expect(keys).toEqual([
    'log.generation.started', 'log.generation.finished',
    'log.generation.started', 'log.generation.finished',
    'log.checkpoint.changed', 'log.generation.started', 'log.generation.finished',
  ])
  const changes = h.oplog.list({ category: 'checkpoint' }).reverse()
  expect(changes.map((e) => e.details)).toEqual([{ from: CKPT, to: CKPT2, modulesFrom: [], modulesTo: [] }])
  const finished = h.oplog.list({ category: 'generation' }).filter((e) => e.messageKey === 'log.generation.finished')
  expect(finished).toHaveLength(3)
  expect(finished.every((e) => e.durationMs === 0)).toBe(true)
})

test('a changed module set counts as a checkpoint change', async () => {
  const h = setup({
    autoComplete: true,
    catalog: { ...catalogWith([CKPT]), modules: [{ name: 'vae', filename: '/m/vae.safetensors' }] },
  })
  h.runner.enqueue(params())
  h.runner.enqueue(params({ modules: ['/m/vae.safetensors'] }))
  await h.runner.tick()
  await h.runner.tick()
  const [change] = h.oplog.list({ category: 'checkpoint' })
  expect(h.oplog.list({ category: 'checkpoint' })).toHaveLength(1)
  expect(change!.details).toEqual({ from: CKPT, to: CKPT, modulesFrom: [], modulesTo: ['/m/vae.safetensors'] })
})

test('no log entry contains the prompt', async () => {
  const h = setup()
  const [a, , c] = h.runner.enqueue(params({ count: 3 })) as [Job, Job, Job]
  let t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(1))
  h.gens[0]!.resolve(response())
  await t
  t = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(2))
  h.gens[1]!.reject(new ForgeError('http', 'x', { detail: 'bad request' }))
  await t
  await h.runner.cancel(c.id)
  h.runner.retry(c.id)
  expect(a.id).toBeGreaterThan(0)
  const entries = h.oplog.list({ limit: 5000 })
  expect(entries.length).toBeGreaterThan(8)
  expect(JSON.stringify(entries)).not.toContain(SECRET)
})

test('an unexpected exception in a tick is logged and tick returns paused; a throwing request just fails the job', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  h.client.txt2img.mockImplementationOnce(() => { throw new Error('sync boom') })
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'unexpected', detail: 'sync boom' } })

  h.runner.enqueue(params())
  vi.spyOn(h.repos.jobs, 'nextQueued').mockImplementationOnce(() => { throw new Error('db boom') })
  expect(await h.runner.tick()).toBe('paused')
  expect(h.oplog.list({ category: 'error' }).some((e) => e.messageKey === 'log.error.runner')).toBe(true)
  spy.mockRestore()
})

test('overlapping tick calls share one run', async () => {
  const h = setup()
  h.runner.enqueue(params({ count: 2 }))
  const t1 = h.runner.tick()
  const t2 = h.runner.tick()
  await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(1))
  expect(t1).toBe(t2)
  h.gens[0]!.resolve(response())
  await t1
  expect(h.client.txt2img).toHaveBeenCalledTimes(1)
})

describe('loop', () => {
  const sleepFor = (h: ReturnType<typeof setup>, ms: number) =>
    vi.waitFor(() => expect(h.sleeps.some((s) => s.ms === ms && !s.used)).toBe(true))
  const release = (h: ReturnType<typeof setup>, ms: number) => {
    const s = h.sleeps.find((x) => x.ms === ms && !x.used)
    if (!s) throw new Error('no such sleep')
    s.used = true
    s.d.resolve()
  }

  test('runs queued jobs back to back, idles, and wakes on enqueue', async () => {
    const h = setup({ autoComplete: true })
    h.runner.enqueue(params({ count: 2 }))
    h.runner.start()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(statuses(h)).toEqual([]))
    h.runner.enqueue(params())
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(3))
    h.runner.stop()
    expect(h.sleeps.filter((s) => s.ms === 5000)).toHaveLength(0)
  })

  test('paused: waits 5000 ms through sleep, then resumes by itself', async () => {
    const h = setup({ autoComplete: true })
    const [job] = h.runner.enqueue(params()) as [Job]
    h.state.pingOk = false
    h.runner.start()
    await sleepFor(h, 5000)
    expect(h.repos.jobs.get(job.id)?.status).toBe('queued')
    h.state.pingOk = true
    release(h, 5000)
    await vi.waitFor(() => expect(h.repos.jobs.get(job.id)?.status).toBe('done'))
    expect(logKeys(h)).toContain('log.queue.resumed')
    h.runner.stop()
  })

  test('survives an unexpected exception', async () => {
    const h = setup({ autoComplete: true })
    const [job] = h.runner.enqueue(params()) as [Job]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(h.repos.jobs, 'nextQueued').mockImplementationOnce(() => { throw new Error('boom') })
    h.runner.start()
    await sleepFor(h, 5000)
    release(h, 5000)
    await vi.waitFor(() => expect(h.repos.jobs.get(job.id)?.status).toBe('done'))
    h.runner.stop()
    spy.mockRestore()
  })

  test('stop aborts the running request and leaves the job interrupted', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    h.runner.start()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    h.runner.stop()
    await vi.waitFor(() => expect(h.repos.jobs.get(job.id)?.status).toBe('interrupted'))
    expect(h.signals[0]!.aborted).toBe(true)
    expect(h.images.save).not.toHaveBeenCalled()
    h.runner.enqueue(params())
    await Promise.resolve()
    expect(h.client.txt2img).toHaveBeenCalledTimes(1)
  })

  test('stop ends a paused wait; start twice does not run two loops', async () => {
    const h = setup()
    h.runner.enqueue(params())
    h.state.pingOk = false
    h.runner.start()
    h.runner.start()
    await sleepFor(h, 5000)
    h.runner.stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.client.ping).toHaveBeenCalledTimes(1)
  })

  test('kick wakes an idle loop', async () => {
    const h = setup({ autoComplete: true })
    h.runner.start()
    await Promise.resolve()
    const [job] = h.runner.enqueue(params()) as [Job]
    await vi.waitFor(() => expect(h.repos.jobs.get(job.id)?.status).toBe('done'))
    h.runner.stop()
  })
})

describe('review fixes', () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

  async function failProgressPolls(h: ReturnType<typeof setup>, n: number) {
    h.state.progress = new Error('link down')
    for (let i = 0; i < n; i++) {
      const before = h.client.progress.mock.calls.length
      await vi.waitFor(() => expect(h.sleeps.some((s) => s.ms === 1000 && !s.used)).toBe(true))
      const s = h.sleeps.find((x) => x.ms === 1000 && !x.used)!
      s.used = true
      s.d.resolve()
      await vi.waitFor(() => expect(h.client.progress.mock.calls.length).toBe(before + 1))
    }
  }

  test('stop(); start() in the same turn leaves a live loop', async () => {
    const h = setup({ autoComplete: true })
    h.runner.start()
    await flush()
    void h.runner.stop()
    h.runner.start()
    const [job] = h.runner.enqueue(params()) as [Job]
    await vi.waitFor(() => expect(h.repos.jobs.get(job.id)?.status).toBe('done'))
    await h.runner.stop()
  })

  test('start() while the old tick is still in flight → new loop takes over after it', async () => {
    const h = setup()
    const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
    h.runner.start()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(1))
    const stopping = h.runner.stop()
    h.runner.start()
    await vi.waitFor(() => expect(h.repos.jobs.get(a.id)?.status).toBe('interrupted'))
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(2))
    expect(h.repos.jobs.get(b.id)?.status).toBe('running')
    await stopping
    await h.runner.stop()
    expect(h.repos.jobs.get(b.id)?.status).toBe('interrupted')
  })

  test('stop() resolves once the loop and the tick are gone; running job gets code stopped', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    h.runner.start()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    await h.runner.stop()
    expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
  })

  test('stop(): if Forge answered before the abort took effect the result is kept', async () => {
    const h = setup({ abortResolves: true })
    const [job] = h.runner.enqueue(params()) as [Job]
    h.runner.start()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    await h.runner.stop()
    expect(h.repos.jobs.get(job.id)?.status).toBe('done')
    expect(h.repos.images.list({ limit: 5 })).toHaveLength(1)
  })

  test('tick() after stop() without start() is a normal single pass', async () => {
    const h = setup({ autoComplete: true })
    const [job] = h.runner.enqueue(params()) as [Job]
    await h.runner.stop()
    expect(await h.runner.tick()).toBe('ran')
    expect(h.repos.jobs.get(job.id)?.status).toBe('done')
  })

  test.each([
    ['unparsable params', 'not json {'],
    ['params lacking required fields', '{"prompt":"x"}'],
  ])('a stored job with %s fails as corruptJob and the queue moves on', async (_n, text) => {
    const h = setup({ autoComplete: true })
    const [bad, good] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
    db.prepare('UPDATE jobs SET params = ? WHERE id = ?').run(text, bad.id)
    expect(await h.runner.tick()).toBe('ran')
    expect(h.repos.jobs.get(bad.id)).toMatchObject({ status: 'failed', error: { code: 'corruptJob' } })
    expect(h.updates.some((u) => u.id === bad.id && u.status === 'failed')).toBe(true)
    expect(await h.runner.tick()).toBe('ran')
    expect(h.repos.jobs.get(good.id)?.status).toBe('done')
  })

  test('a job that throws before running is failed, not retried forever', async () => {
    const h = setup({ autoComplete: true })
    const [bad, good] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.state.catalog = { get checkpoints(): never { throw new Error('catalog exploded') }, get modules(): never { throw new Error('catalog exploded') } } as unknown as Catalog
    expect(await h.runner.tick()).toBe('paused')
    expect(h.repos.jobs.get(bad.id)).toMatchObject({ status: 'failed', error: { code: 'unexpected', detail: 'catalog exploded' } })
    h.state.catalog = catalogWith([CKPT])
    expect(await h.runner.tick()).toBe('ran')
    expect(h.repos.jobs.get(good.id)?.status).toBe('done')
    const entry = h.oplog.list({ category: 'error' }).find((e) => e.messageKey === 'log.error.runner')
    expect(typeof entry?.details.stack).toBe('string')
    spy.mockRestore()
  })

  test('watchdog: 15 consecutive failed progress polls → interrupted (network), tick paused', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    await failProgressPolls(h, 15)
    expect(await t).toBe('paused')
    expect(h.signals[0]!.aborted).toBe(true)
    expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'interrupted', error: { code: 'network' } })
  })

  test('watchdog: 14 failures then a success keeps the job going', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    await failProgressPolls(h, 14)
    await h.poll(3, 1000)
    await failProgressPolls(h, 14)
    expect(h.signals[0]!.aborted).toBe(false)
    h.gens[0]!.resolve(response())
    expect(await t).toBe('ran')
    expect(h.repos.jobs.get(job.id)?.status).toBe('done')
  })

  test('forge error text containing the prompt is kept out of the log but stays in job.error', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    h.gens[0]!.reject(new ForgeError('http', 'x', { status: 422, detail: `bad prompt: ${SECRET} here` }))
    await t
    expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'forgeHttp', status: 422, detail: `bad prompt: ${SECRET} here` })
    const entry = h.oplog.list({ category: 'error' })[0]!
    expect(entry.details).toMatchObject({ kind: 'http', status: 422, detailOmitted: true })
    expect(entry.details).not.toHaveProperty('detail')
  })

  test('forge error text is logged truncated to 300 characters', async () => {
    const h = setup()
    h.runner.enqueue(params())
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    h.gens[0]!.reject(new ForgeError('http', 'x', { status: 500, detail: 'e'.repeat(500) }))
    await t
    expect(h.oplog.list({ category: 'error' })[0]!.details.detail).toBe('e'.repeat(300))
  })

  test('cancel interrupts through the client that runs the job', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    const other = { interrupt: vi.fn(async () => undefined) }
    h.state.clientOverride = other
    await h.runner.cancel(job.id)
    expect(h.client.interrupt).toHaveBeenCalledTimes(1)
    expect(other.interrupt).not.toHaveBeenCalled()
    await t
  })

  test.each([0, 9, 1.5, Number.NaN, -1])('enqueue with count %s throws RangeError', (count) => {
    const h = setup()
    expect(() => h.runner.enqueue(params({ count }))).toThrow(RangeError)
    expect(statuses(h)).toEqual([])
  })

  test('the pause is cleared when a ping succeeds even if the queue is empty by then', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    h.state.pingOk = false
    expect(await h.runner.tick()).toBe('paused')
    await h.runner.cancel(job.id)
    h.state.pingOk = true
    expect(await h.runner.tick()).toBe('idle')
    expect(logKeys(h)).toContain('log.queue.resumed')
  })
})
