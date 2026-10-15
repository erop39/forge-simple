import { defaultParams } from '@shared/profiles'
import type { Catalog, GenerationParams, Job, JobProgress } from '@shared/types'
import {
  ForgeError, type ForgeClient, type GenerationResponse, type ProgressResponse, type RestartOutcome,
} from '../forge/client'
import type { ProbeFindings } from '../forge/findings'
import { createOplog, type Oplog } from '../oplog/oplog'
import { openDb, type Db } from '../storage/db'
import type { createImageStore } from '../storage/image-store'
import { SourceImageError } from '../storage/image-store'
import { createRepos, type ImageRow } from '../storage/repos'
import { createRunner, RECOVERY_UNLOAD_TIMEOUT_MS } from './runner'

const FINDINGS: ProbeFindings = { shiftField: 'distilled_cfg_scale', modulesAs: 'path', thumbRoute: true }
const CKPT = 'sd_xl_base.safetensors [abc]'
const CKPT2 = 'other.safetensors [def]'
const avail = { samplers: ['Euler a'], schedulers: ['Automatic'] }

const catalogWith = (titles: string[]): Catalog => ({
  checkpoints: titles.map((title) => ({ title, name: title, filename: title, family: 'sdxl' as const })),
  modules: [], loras: [], samplers: ['Euler a'], schedulers: ['Automatic'], upscalers: ['Latent', 'R-ESRGAN 4x+'], loadedCheckpoint: null, fetchedAt: 0, familyModules: {},
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

function setup(opts: { catalog?: Catalog; autoComplete?: boolean; abortResolves?: boolean; peakVram?: number } = {}) {
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
  const health: boolean[] = []
  const state = { unloadFails: false, restart: 'restarting' as RestartOutcome | Error, clientOverride: null as unknown, pingOk: true, lockOpen: false, progress: progressAt(0, null) as ProgressResponse | Error, catalog: opts.catalog ?? catalogWith([CKPT, CKPT2]) as Catalog | Error }
  const generate = (_body: unknown, signal?: AbortSignal) => {
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
  }
  const client = {
    ping: vi.fn(async () => {
      if (!state.pingOk) throw new ForgeError('network', 'down')
      return 5
    }),
    txt2img: vi.fn(generate),
    img2img: vi.fn(generate),
    upscale: vi.fn(generate),
    progress: vi.fn(async () => {
      if (state.progress instanceof Error) throw state.progress
      return state.progress
    }),
    interrupt: vi.fn(async () => undefined),
    unloadCheckpoint: vi.fn(async () => {
      if (state.unloadFails) throw new ForgeError('network', 'down')
    }),
    restartServer: vi.fn(async (): Promise<RestartOutcome> => {
      if (state.restart instanceof Error) throw state.restart
      return state.restart
    }),
  }

  const sleeps: { ms: number; d: Deferred<void>; used: boolean }[] = []
  const images = {
    save: vi.fn(async (_b64: string, n: { jobId: number; seed: number }) => ({
      filePath: `/img/${n.jobId}-${n.seed}.png`, thumbPath: `/img/t/${n.jobId}-${n.seed}.jpg`, width: 896, height: 1152,
    })),
    remove: vi.fn(async () => undefined),
    readSource: vi.fn(async () => 'cG5n'),
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
    lock: { isOpen: () => state.lockOpen },
    oplog,
    events: {
      jobUpdate: (j) => { updates.push(j); events.push(`update:${j.status}`) },
      jobProgress: (p) => { progress.push(p); events.push('progress') },
      imageAdded: (r) => { added.push(r); events.push('image') },
      forgeHealth: (unhealthy) => { health.push(unhealthy); events.push(`health:${unhealthy}`) },
    },
    now,
    sleep: (ms) => { const d = deferred<void>(); sleeps.push({ ms, d, used: false }); return d.promise },
    peakVram: () => opts.peakVram ?? null,
  })

  const at = (t: number) => { clock = t }
  /** Lets the in-flight request's progress poll fire once, with Forge reporting `step`. */
  async function poll(step: number, t: number, image: string | null = null, jobNo = 0) {
    const reported = progressAt(step, image)
    state.progress = { ...reported, state: { ...reported.state, job_no: jobNo, job_count: jobNo > 0 ? 2 : 1 } }
    at(t)
    const before = progress.length
    const s = sleeps.find((x) => x.ms === 1000 && !x.used)
    if (!s) throw new Error('no pending progress sleep')
    s.used = true
    s.d.resolve()
    await vi.waitFor(() => expect(progress.length).toBe(before + 1))
  }
  const started = (n = 1) => vi.waitFor(() => expect(client.txt2img).toHaveBeenCalledTimes(n))

  return { health, repos, oplog, client, gens, signals, sleeps, images, runner, events, updates, progress, added, state, at, poll, started }
}


const statuses = (h: ReturnType<typeof setup>) => h.repos.jobs.listActive().map((j) => j.status)
const logKeys = (h: ReturnType<typeof setup>) => h.oplog.list().reverse().map((e) => e.messageKey)

function sourceFor(h: ReturnType<typeof setup>): ImageRow {
  const original = h.repos.jobs.insert(h.repos.servers.active()!.id, 'txt2img', params())
  h.repos.jobs.setStatus(original.id, 'done')
  return h.repos.images.insert({ jobId: original.id, filePath: '/img/original.png', thumbPath: '/img/t/original.jpg',
    width: 64, height: 64, seed: 5, infotext: '', durationMs: 10 })
}

const imgParams = (id: number): GenerationParams => params({
  img2img: { sourceImageId: id, denoisingStrength: 0.5, resizeMode: 1 },
})

test('img2img dispatches from a managed source and keeps its job type on retry', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  const job = h.runner.enqueue(imgParams(source.id))[0]!
  expect(job.type).toBe('img2img')
  expect(await h.runner.tick()).toBe('ran')
  expect(h.client.txt2img).not.toHaveBeenCalled()
  expect(h.client.img2img).toHaveBeenCalledWith(expect.objectContaining({ init_images: ['cG5n'], resize_mode: 1 }), expect.any(AbortSignal))
  expect(h.repos.jobs.get(job.id)?.status).toBe('done')
  expect(JSON.stringify(h.oplog.list())).not.toContain('cG5n')
  const failed = h.repos.jobs.insert(job.serverId, 'img2img', imgParams(source.id))
  h.repos.jobs.setStatus(failed.id, 'failed')
  expect(h.runner.retry(failed.id).type).toBe('img2img')
})

test('img2img refuses missing, locked, and unreadable sources before Forge receives bytes', async () => {
  const h = setup()
  const deletedSource = sourceFor(h)
  const missing = h.runner.enqueue(imgParams(deletedSource.id))[0]!
  h.repos.images.delete(deletedSource.id)
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(missing.id)?.error?.code).toBe('sourceMissing')
  const source = sourceFor(h)
  h.repos.images.setHidden([source.id], true)
  h.state.lockOpen = true
  const locked = h.runner.enqueue(imgParams(source.id))[0]!
  h.state.lockOpen = false
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(locked.id)?.error?.code).toBe('sourceLocked')
  h.state.lockOpen = true
  h.images.readSource.mockRejectedValueOnce(new SourceImageError('corrupt'))
  const corrupt = h.runner.enqueue(imgParams(source.id))[0]!
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(corrupt.id)?.error?.code).toBe('sourceCorrupt')
  expect(h.client.img2img).not.toHaveBeenCalled()
})

test('img2img cancellation and link loss use the same queue semantics as txt2img', async () => {
  const h = setup()
  const source = sourceFor(h)
  const first = h.runner.enqueue(imgParams(source.id))[0]!
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.client.img2img).toHaveBeenCalledTimes(1))
  await h.runner.cancel(first.id)
  expect(await ticking).toBe('ran')
  expect(h.repos.jobs.get(first.id)?.status).toBe('cancelled')
  const second = h.runner.enqueue(imgParams(source.id))[0]!
  const next = h.runner.tick()
  await vi.waitFor(() => expect(h.client.img2img).toHaveBeenCalledTimes(2))
  h.gens.at(-1)!.reject(new ForgeError('network', 'offline'))
  expect(await next).toBe('paused')
  expect(h.repos.jobs.get(second.id)?.status).toBe('interrupted')
})

test('img2img does not dispatch to the old server after a switch during source read', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  const job = h.runner.enqueue(imgParams(source.id))[0]!
  const read = deferred<string>()
  h.images.readSource.mockImplementationOnce(() => read.promise)
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.images.readSource).toHaveBeenCalledTimes(1))
  h.repos.servers.setActiveUrl('http://another.test')
  read.resolve('cG5n')
  expect(await ticking).toBe('idle')
  expect(h.client.img2img).not.toHaveBeenCalled()
  expect(h.repos.jobs.get(job.id)?.status).toBe('queued')
})

test('img2img does not dispatch after stop while source bytes are being read', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  h.runner.enqueue(imgParams(source.id))
  const read = deferred<string>()
  h.images.readSource.mockImplementationOnce(() => read.promise)
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.images.readSource).toHaveBeenCalledTimes(1))
  const stopping = h.runner.stop()
  read.resolve('cG5n')
  expect(await ticking).toBe('idle')
  await stopping
  expect(h.client.img2img).not.toHaveBeenCalled()
})

test('img2img rejects persisted hires settings before dispatch', async () => {
  const h = setup()
  const source = sourceFor(h)
  const job = h.repos.jobs.insert(h.repos.servers.active()!.id, 'img2img', imgParams(source.id))
  db.prepare('UPDATE jobs SET params = ? WHERE id = ?').run(JSON.stringify(params({
    img2img: imgParams(source.id).img2img,
    hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 },
  })), job.id)
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.error?.code).toBe('corruptJob')
  expect(h.client.img2img).not.toHaveBeenCalled()
})

test('img2img never persists Forge error text that echoes source bytes', async () => {
  const h = setup()
  const source = sourceFor(h)
  const job = h.runner.enqueue(imgParams(source.id))[0]!
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.client.img2img).toHaveBeenCalledOnce())
  h.gens[0]!.reject(new ForgeError('http', 'invalid image', { status: 422, detail: 'init_images: cG5n' }))
  expect(await ticking).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'forgeHttp', status: 422 })
  expect(JSON.stringify(h.repos.jobs.get(job.id))).not.toContain('cG5n')
  expect(JSON.stringify(h.oplog.list())).not.toContain('cG5n')
})

test('upscale runs the extras request and links its result to the source', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  const job = h.runner.enqueue(params({ prompt: '', upscale: {
    sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2,
  } }))[0]!
  expect(job.type).toBe('upscale')
  expect(await h.runner.tick()).toBe('ran')
  expect(h.client.upscale).toHaveBeenCalledWith(expect.objectContaining({ image: 'cG5n', upscaling_resize: 2 }), expect.any(AbortSignal))
  expect(h.repos.images.list({ limit: 1 })[0]?.sourceImageId).toBe(source.id)
})

test('upscale refuses a locked source and cancellation interrupts an active extras request', async () => {
  const h = setup()
  const source = sourceFor(h)
  h.repos.images.setHidden([source.id], true)
  h.state.lockOpen = true
  const locked = h.runner.enqueue(params({ upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } }))[0]!
  h.state.lockOpen = false
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(locked.id)?.error?.code).toBe('sourceLocked')
  h.state.lockOpen = true
  const running = h.runner.enqueue(params({ upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } }))[0]!
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.client.upscale).toHaveBeenCalledOnce())
  await h.runner.cancel(running.id)
  expect(await ticking).toBe('ran')
  expect(h.repos.jobs.get(running.id)?.status).toBe('cancelled')
})

test('an upscale HTTP 500 fails the job without unloading the checkpoint or storing echoed bytes', async () => {
  const h = setup()
  const source = sourceFor(h)
  const job = h.runner.enqueue(params({ upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } }))[0]!
  const ticking = h.runner.tick()
  await vi.waitFor(() => expect(h.client.upscale).toHaveBeenCalledOnce())
  h.gens[0]!.reject(new ForgeError('http', 'HTTP 500', { status: 500, detail: 'image: cG5n' }))
  expect(await ticking).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'forgeHttp', status: 500 })
  expect(h.client.unloadCheckpoint).not.toHaveBeenCalled()
  expect(h.runner.unhealthy()).toBe(false)
  expect(JSON.stringify(h.oplog.list())).not.toContain('cG5n')
})

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

test('a sampled VRAM peak is saved on the job and its completion log', async () => {
  const h = setup({ autoComplete: true, peakVram: 14 * 1024 ** 3 })
  const [job] = h.runner.enqueue(params()) as [Job]
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.peakVram).toBe(14 * 1024 ** 3)
  expect(h.oplog.list({ category: 'generation' })[0]?.details.peakVram).toBe(14 * 1024 ** 3)
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

test('hires second pass changes the stage and resets the speed sample window', async () => {
  const h = setup()
  h.runner.enqueue(params({ hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }))
  const t = h.runner.tick()
  await h.started()
  await h.poll(4, 1000)
  await h.poll(10, 2000)
  expect(h.progress[1]?.stepsPerSec).toBe(6)
  await h.poll(2, 3000, null, 1)
  expect(h.progress[2]).toMatchObject({ stage: 'hires', step: 2, stepsPerSec: null })
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

test('a switch to another server while the job is being checked leaves the job queued for its own server', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  const ping = deferred<number>()
  h.client.ping.mockReturnValueOnce(ping.promise)
  const t = h.runner.tick()
  h.repos.servers.activate(h.repos.servers.add('other', 'http://other.test').id)
  ping.resolve(1)
  expect(await t).toBe('idle')
  expect(h.client.txt2img).not.toHaveBeenCalled()
  expect(h.repos.jobs.get(job.id)?.status).toBe('queued')
})

test('retry of a job whose server was removed queues the clone on the active server', async () => {
  const h = setup()
  const [job] = h.runner.enqueue(params()) as [Job]
  h.repos.jobs.setStatus(job.id, 'failed', { error: { code: 'unexpected' } })
  const other = h.repos.servers.add('other', 'http://other.test')
  h.repos.servers.activate(other.id)
  h.repos.servers.remove(job.serverId)
  expect(h.runner.retry(job.id).serverId).toBe(other.id)
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

test('recover marks running jobs interrupted with code stopped', () => {
  const h = setup()
  const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
  h.repos.jobs.setStatus(a.id, 'running')
  h.runner.recover()
  expect(h.repos.jobs.get(a.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
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

  test('forge error detail never reaches the log; job.error keeps it', async () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `word"${i}" a\b
line`).join(' ')
    const variants = [
      `bad prompt: ${prompt}`,
      JSON.stringify(prompt),
      prompt.slice(0, 200),
      'e'.repeat(500),
    ]
    for (const detail of variants) {
      const h = setup()
      const [job] = h.runner.enqueue(params({ prompt, negativePrompt: 'neg-' + prompt })) as [Job]
      const t = h.runner.tick()
      await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
      h.gens[0]!.reject(new ForgeError('http', 'x', { status: 422, detail }))
      await t
      expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'forgeHttp', status: 422, detail })
      const entries = h.oplog.list({ limit: 5000 })
      const entry = entries.find((e) => e.category === 'error')!
      expect(entry.details).toEqual({ kind: 'http', status: 422 })
      const logged = JSON.stringify(entries)
      for (let i = 0; i + 12 <= prompt.length; i += 7) expect(logged).not.toContain(prompt.slice(i, i + 12))
      db.close()
    }
  })

  test('a network failure entry carries only kind', async () => {
    const h = setup()
    h.runner.enqueue(params())
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalled())
    h.gens[0]!.reject(new ForgeError('network', 'x', { detail: 'secret echo' }))
    await t
    expect(h.oplog.list({ category: 'error' })[0]!.details).toEqual({ kind: 'network', status: null })
  })

  test('ping ok but catalog failing: one paused entry, no resumed, across cycles', async () => {
    const h = setup()
    h.runner.enqueue(params())
    h.state.catalog = new ForgeError('network', 'down')
    for (let i = 0; i < 3; i++) expect(await h.runner.tick()).toBe('paused')
    const keys = logKeys(h)
    expect(keys.filter((k) => k === 'log.queue.paused')).toHaveLength(1)
    expect(keys).not.toContain('log.queue.resumed')
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

describe('recovery after Forge 500s', () => {
  const http500 = () => new ForgeError('http', 'HTTP 500', { status: 500, detail: 'TypeError: NoneType object is not callable' })

  /** Runs the next queued job and settles its request with `outcome`. */
  async function runOne(h: ReturnType<typeof setup>, outcome: Error | GenerationResponse) {
    const n = h.gens.length
    const t = h.runner.tick()
    await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(n + 1))
    if (outcome instanceof Error) h.gens[n]!.reject(outcome)
    else h.gens[n]!.resolve(outcome)
    return t
  }

  test('a 500 fails the job, unloads the checkpoint before the next job, and the next job runs', async () => {
    const h = setup()
    const [a, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
    expect(await runOne(h, http500())).toBe('ran')
    expect(h.repos.jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'forgeHttp', status: 500 } })
    expect(h.client.unloadCheckpoint).toHaveBeenCalledTimes(1)
    expect(h.client.unloadCheckpoint).toHaveBeenCalledWith(RECOVERY_UNLOAD_TIMEOUT_MS)
    const unloaded = h.oplog.list().find((e) => e.messageKey === 'log.recovery.unloaded')
    expect(unloaded).toMatchObject({ level: 'info', category: 'checkpoint', jobId: a.id })
    expect(JSON.stringify(unloaded?.details)).not.toContain('NoneType')
    await runOne(h, response())
    expect(h.repos.jobs.get(b.id)?.status).toBe('done')
    expect(h.client.unloadCheckpoint).toHaveBeenCalledTimes(1)
  })

  test('other HTTP errors do not unload', async () => {
    const h = setup()
    h.runner.enqueue(params())
    await runOne(h, new ForgeError('http', 'HTTP 422', { status: 422 }))
    expect(h.client.unloadCheckpoint).not.toHaveBeenCalled()
  })

  test('a failed unload is logged and does not block the queue', async () => {
    const h = setup()
    h.state.unloadFails = true
    const [, b] = h.runner.enqueue(params({ count: 2 })) as [Job, Job]
    expect(await runOne(h, http500())).toBe('ran')
    expect(h.oplog.list().find((e) => e.messageKey === 'log.recovery.unloadFailed'))
      .toMatchObject({ level: 'warn', details: { kind: 'network' } })
    await runOne(h, response())
    expect(h.repos.jobs.get(b.id)?.status).toBe('done')
  })

  test('two 500s in a row raise the unhealthy flag once; a success clears it', async () => {
    const h = setup()
    h.runner.enqueue(params({ count: 4 }))
    await runOne(h, http500())
    expect(h.runner.unhealthy()).toBe(false)
    expect(h.health).toEqual([])
    await runOne(h, http500())
    expect(h.runner.unhealthy()).toBe(true)
    expect(h.health).toEqual([true])
    expect(h.oplog.list().find((e) => e.messageKey === 'log.recovery.unhealthy'))
      .toMatchObject({ level: 'warn', category: 'server', details: { count: 2 } })
    await runOne(h, http500())
    expect(h.health).toEqual([true])
    await runOne(h, response())
    expect(h.runner.unhealthy()).toBe(false)
    expect(h.health).toEqual([true, false])
  })

  test('a success between two 500s resets the count', async () => {
    const h = setup()
    h.runner.enqueue(params({ count: 3 }))
    await runOne(h, http500())
    await runOne(h, response())
    await runOne(h, http500())
    expect(h.runner.unhealthy()).toBe(false)
  })

  test('resetHealth() (server switch, restart) clears the flag and the count', async () => {
    const h = setup()
    h.runner.enqueue(params({ count: 3 }))
    await runOne(h, http500())
    await runOne(h, http500())
    h.runner.resetHealth()
    expect(h.runner.unhealthy()).toBe(false)
    expect(h.health).toEqual([true, false])
    await runOne(h, http500())
    expect(h.runner.unhealthy()).toBe(false)
  })

  test('500s on another server do not add up with this one', async () => {
    const h = setup()
    h.runner.enqueue(params())
    await runOne(h, http500())
    h.repos.servers.activate(h.repos.servers.add('other', 'http://other.test').id)
    h.runner.enqueue(params())
    await runOne(h, http500())
    expect(h.runner.unhealthy()).toBe(false)
  })
})

describe('restartForge', () => {
  test('interrupts the running job with code stopped, pauses the queue', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await h.started()
    expect(await h.runner.restartForge()).toBe('restarting')
    expect(await t).toBe('paused')
    expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
    expect(h.oplog.list().find((e) => e.messageKey === 'log.queue.paused')?.details).toEqual({ reason: 'restart' })
    expect(logKeys(h)).not.toContain('log.error.connectionLost')
  })

  test('a job whose request drops while the restart is being sent is still interrupted as stopped', async () => {
    const h = setup()
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await h.started()
    h.client.restartServer.mockImplementationOnce(async () => {
      h.gens[0]!.reject(new ForgeError('network', 'Could not reach Forge', { detail: 'other side closed' }))
      await new Promise((r) => setTimeout(r, 0))
      return 'restarting'
    })
    await h.runner.restartForge()
    await t
    expect(h.repos.jobs.get(job.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
    expect(logKeys(h)).not.toContain('log.error.connectionLost')
  })

  test('a refused restart leaves the job running and the queue as it was', async () => {
    const h = setup()
    h.state.restart = 'notAllowed'
    const [job] = h.runner.enqueue(params()) as [Job]
    const t = h.runner.tick()
    await h.started()
    expect(await h.runner.restartForge()).toBe('notAllowed')
    expect(h.repos.jobs.get(job.id)?.status).toBe('running')
    h.gens[0]!.resolve(response())
    expect(await t).toBe('ran')
    expect(h.repos.jobs.get(job.id)?.status).toBe('done')
    expect(logKeys(h)).not.toContain('log.queue.paused')
  })

  test('a restart that could not be sent rejects and changes nothing', async () => {
    const h = setup()
    h.state.restart = new ForgeError('network', 'Could not reach Forge', { detail: 'connect ECONNREFUSED' })
    await expect(h.runner.restartForge()).rejects.toBeInstanceOf(ForgeError)
    expect(logKeys(h)).not.toContain('log.queue.paused')
  })

  test('a restart clears the unhealthy flag', async () => {
    const h = setup()
    h.runner.enqueue(params({ count: 2 }))
    for (let i = 0; i < 2; i++) {
      const n = h.gens.length
      const t = h.runner.tick()
      await vi.waitFor(() => expect(h.client.txt2img).toHaveBeenCalledTimes(n + 1))
      h.gens[n]!.reject(new ForgeError('http', 'HTTP 500', { status: 500 }))
      await t
    }
    expect(h.runner.unhealthy()).toBe(true)
    await h.runner.restartForge()
    expect(h.runner.unhealthy()).toBe(false)
    expect(h.health).toEqual([true, false])
  })
})

test('img2img and upscale results from a hidden source are saved hidden', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  h.repos.images.setHidden([source.id], true)
  h.state.lockOpen = true
  h.runner.enqueue(imgParams(source.id))
  expect(await h.runner.tick()).toBe('ran')
  h.runner.enqueue(params({ prompt: '', upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } }))
  expect(await h.runner.tick()).toBe('ran')
  const results = h.repos.images.list({ limit: 5 }).filter((i) => i.id !== source.id)
  expect(results).toHaveLength(2)
  expect(results.every((i) => i.hidden)).toBe(true)
  expect(h.added.every((i) => i.hidden)).toBe(true)
})

test('a result from a visible source stays visible', async () => {
  const h = setup({ autoComplete: true })
  const source = sourceFor(h)
  h.runner.enqueue(imgParams(source.id))
  expect(await h.runner.tick()).toBe('ran')
  expect(h.added[0]!.hidden).toBe(false)
})

test('an upscale over the size limit fails with its own code', async () => {
  const h = setup()
  const original = sourceFor(h)
  const big = h.repos.images.insert({ jobId: original.jobId, filePath: '/img/big.png', thumbPath: '/img/t/big.jpg',
    width: 2000, height: 2000, seed: 1, infotext: '', durationMs: 1 })
  const job = h.runner.enqueue(params({ prompt: '', upscale: { sourceImageId: big.id, upscaler: 'R-ESRGAN 4x+', scale: 4 } }))[0]!
  await h.runner.tick()
  expect(h.repos.jobs.get(job.id)?.error?.code).toBe('sizeLimit')
})

test('an upscaled image keeps the seed and infotext of its source', async () => {
  const h = setup({ autoComplete: true })
  const original = h.repos.jobs.insert(h.repos.servers.active()!.id, 'txt2img', params())
  h.repos.jobs.setStatus(original.id, 'done')
  const source = h.repos.images.insert({ jobId: original.id, filePath: '/img/o.png', thumbPath: '/img/t/o.jpg',
    width: 64, height: 64, seed: 4242, infotext: 'a cat\nSteps: 4', durationMs: 10 })
  // Extras answers with the image only, as the real client does.
  h.client.upscale.mockResolvedValueOnce({ images: ['png0'], info: '' })
  h.runner.enqueue(params({ prompt: '', upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } }))
  expect(await h.runner.tick()).toBe('ran')
  const result = h.repos.images.list({ limit: 1 })[0]!
  expect(result.sourceImageId).toBe(source.id)
  expect(result.seed).toBe(4242)
  expect(result.infotext).toBe('a cat\nSteps: 4')
})

test('a hires upscaler the server does not list fails before Forge is called', async () => {
  const h = setup({ autoComplete: true })
  const job = h.runner.enqueue(params({
    hires: { scale: 2, upscaler: 'Gone 4x', secondPassSteps: 8, denoisingStrength: 0.5 },
  }))[0]!
  expect(await h.runner.tick()).toBe('ran')
  expect(h.repos.jobs.get(job.id)?.error).toEqual({ code: 'missingParts', missing: ['Gone 4x'] })
  expect(h.client.txt2img).not.toHaveBeenCalled()
})
