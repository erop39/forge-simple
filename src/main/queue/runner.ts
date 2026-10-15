import type { Catalog, GenerationParams, Job, JobError, JobProgress } from '@shared/types'
import { ForgeError, type ForgeClient, type GenerationResponse, type RestartOutcome } from '../forge/client'
import { checkParts } from '../forge/catalog'
import type { ProbeFindings } from '../forge/findings'
import { buildImg2ImgBody, buildTxt2ImgBody, buildUpscaleBody } from '../generation/payload'
import type { Oplog, OplogWrite } from '../oplog/oplog'
import { SourceImageError, type createImageStore } from '../storage/image-store'
import { isGenerationParams, type createRepos, type ImageRow } from '../storage/repos'
import { stepsPerSec } from './speed'

export interface RunnerEvents {
  jobUpdate(job: Job): void
  jobProgress(p: JobProgress): void
  imageAdded(row: ImageRow): void
  /** The unhealthy flag changed: generations keep failing with HTTP 500 and a restart is advised. */
  forgeHealth?(unhealthy: boolean): void
}

export interface RunnerDeps {
  client(): ForgeClient
  catalog(): Promise<Catalog>
  findings: ProbeFindings
  repos: ReturnType<typeof createRepos>
  images: ReturnType<typeof createImageStore>
  /** Closed by default; hidden sources need an explicitly open session. */
  lock?: { isOpen(): boolean }
  oplog: Oplog
  events: RunnerEvents
  now(): number
  sleep(ms: number): Promise<void>
  /** Consumes the largest VRAM reading collected for this job, if any. */
  peakVram?(jobId: number): number | null
}

export type TickResult = 'idle' | 'ran' | 'paused'

export const PROGRESS_INTERVAL_MS = 1000
export const PAUSE_INTERVAL_MS = 5000
/** Consecutive failed progress polls after which a silent link drop ends the job. */
export const PROGRESS_FAILURE_LIMIT = 15
export const MAX_COUNT = 8
/** Consecutive generation 500s on one server after which Forge counts as unhealthy. */
export const UNHEALTHY_AFTER = 2
/** The automatic unload after a 500 is best effort: the queue waits at most this long for it. */
export const RECOVERY_UNLOAD_TIMEOUT_MS = 15_000

interface ActiveJob {
  jobId: number
  client: ForgeClient
  controller: AbortController
  cancelling: boolean
  stopping: boolean
  watchdog: boolean
}

type Outcome = { ok: true; value: GenerationResponse } | { ok: false; error: unknown }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function sameModules(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sb = [...b].sort()
  return [...a].sort().every((m, i) => m === sb[i])
}

/** Any problem with the server's info text yields no seeds and no infotexts. */
function parseInfo(info: string): { seeds: unknown[]; infotexts: unknown[] } {
  try {
    const parsed: unknown = JSON.parse(info)
    if (typeof parsed !== 'object' || parsed === null) return { seeds: [], infotexts: [] }
    const o = parsed as { all_seeds?: unknown; infotexts?: unknown }
    return {
      seeds: Array.isArray(o.all_seeds) ? o.all_seeds : [],
      infotexts: Array.isArray(o.infotexts) ? o.infotexts : [],
    }
  } catch {
    return { seeds: [], infotexts: [] }
  }
}

export function createRunner(deps: RunnerDeps): {
  enqueue(params: GenerationParams): Job[]
  cancel(jobId: number): Promise<void>
  retry(jobId: number): Job
  recover(): void
  tick(): Promise<TickResult>
  start(): void
  stop(): Promise<void>
  kick(): void
  /** True after UNHEALTHY_AFTER generation 500s in a row on the active server. */
  unhealthy(): boolean
  /** Clears the 500 count and the unhealthy flag (server switch, restart). */
  resetHealth(): void
  /**
   * Asks Forge to restart. When it accepts, the running job is interrupted (code stopped), the
   * queue pauses until Forge answers again and the unhealthy flag clears. Throws what the client throws.
   */
  restartForge(): Promise<RestartOutcome>
} {
  const { repos, oplog, events } = deps

  let active: ActiveJob | null = null
  let tickInFlight: Promise<TickResult> | null = null
  let tickEpoch = 0
  let lastDone: { checkpoint: string; modules: string[] } | null = null
  let queuePaused = false
  /** Generation 500s in a row, per server; any success or resetHealth() clears it. */
  let failStreak: { serverId: number; count: number } | null = null
  let isUnhealthy = false
  /** Set while a restart request is out: a dropped generation request is then a stop, not a lost link. */
  let restartPending = false

  // Every stop() bumps `stopEpoch`: a tick that began earlier backs off, a tick that begins later
  // is a normal pass. Every start()/stop() bumps `runGen`: only the newest loop keeps running.
  let stopEpoch = 0
  let running = false
  let runGen = 0
  let loopPromise: Promise<void> | null = null
  let wake: (() => void) | null = null
  let pendingKick = false
  let stopSignal: Promise<void> = Promise.resolve()
  let fireStop: () => void = () => undefined

  const emitSafely = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      console.error('runner: event listener failed', err)
    }
  }

  function setStatus(id: number, status: Job['status'], patch: Parameters<typeof repos.jobs.setStatus>[2] = {}): Job {
    const terminal = status === 'done' || status === 'failed' || status === 'interrupted' || status === 'cancelled'
    const peakVram = terminal ? deps.peakVram?.(id) : null
    const job = repos.jobs.setStatus(id, status, peakVram == null ? patch : { ...patch, peakVram })
    emitSafely(() => events.jobUpdate(job))
    return job
  }

  const log = (e: OplogWrite): void => oplog.write(e)

  function logError(job: Job, messageKey: string, details: Record<string, unknown> = {}): void {
    log({ level: 'error', category: 'error', messageKey, jobId: job.id, details })
  }

  // ---- public operations -------------------------------------------------

  function enqueue(params: GenerationParams): Job[] {
    if (!Number.isInteger(params.count) || params.count < 1 || params.count > MAX_COUNT) {
      throw new RangeError(`count must be an integer from 1 to ${MAX_COUNT}`)
    }
    const server = repos.servers.active()
    if (!server) throw new Error('No active server')
    const jobs: Job[] = []
    for (let i = 0; i < params.count; i++) {
      const seed = params.seed === -1 ? -1 : params.seed + i
      const job = repos.jobs.insert(server.id, params.upscale ? 'upscale' : params.img2img ? 'img2img' : 'txt2img', { ...params, count: 1, seed })
      jobs.push(job)
      log({ level: 'info', category: 'queue', messageKey: 'log.queue.added', jobId: job.id, details: { type: job.type } })
    }
    kick()
    return jobs
  }

  async function cancel(jobId: number): Promise<void> {
    const job = repos.jobs.get(jobId)
    if (!job) return
    if (job.status === 'queued') {
      setStatus(jobId, 'cancelled')
      log({ level: 'info', category: 'queue', messageKey: 'log.queue.cancelled', jobId, details: { type: job.type, wasRunning: false } })
      return
    }
    if (job.status === 'running' && active?.jobId === jobId && !active.cancelling) {
      const a = active
      a.cancelling = true
      log({ level: 'info', category: 'queue', messageKey: 'log.queue.cancelled', jobId, details: { type: job.type, wasRunning: true } })
      try {
        await a.client.interrupt() // the client that runs the job, not a fresh one
      } catch {
        // Forge may be gone; aborting the request below still ends the job.
      } finally {
        a.controller.abort()
      }
    }
  }

  function retry(jobId: number): Job {
    const job = repos.jobs.get(jobId)
    if (!job) throw new Error(`Job ${jobId} not found`)
    if (job.status !== 'failed' && job.status !== 'interrupted' && job.status !== 'cancelled') {
      throw new Error(`Job ${jobId} cannot be retried while ${job.status}`)
    }
    // A job keeps its server, unless that server was removed: then it goes to the active one.
    const serverId = repos.servers.get(job.serverId)?.id ?? repos.servers.active()?.id
    if (serverId === undefined) throw new Error('No active server')
    const clone = repos.jobs.insert(serverId, job.type, job.params)
    log({ level: 'info', category: 'queue', messageKey: 'log.queue.retried', jobId: clone.id, details: { type: clone.type, originalJobId: jobId } })
    kick()
    return clone
  }

  function recover(): void {
    const n = repos.jobs.markRunningInterrupted()
    if (n > 0) log({ level: 'warn', category: 'queue', messageKey: 'log.queue.recovered', details: { count: n } })
  }

  // ---- one pass ----------------------------------------------------------

  // One tick at a time. A call made during a tick joins it, unless a stop() happened since that tick
  // began: then it runs after it, so a restarted loop is never handed a tick that backed off.
  function tick(): Promise<TickResult> {
    const prev = tickInFlight
    if (prev && tickEpoch === stopEpoch) return prev
    const p: Promise<TickResult> = (prev ? prev.catch(() => undefined).then(runTick) : runTick())
      .finally(() => { if (tickInFlight === p) tickInFlight = null })
    tickInFlight = p
    tickEpoch = stopEpoch
    return p
  }

  async function idleCheck(): Promise<TickResult> {
    if (!queuePaused) return 'idle'
    try {
      await deps.client().ping()
    } catch {
      return 'paused'
    }
    resumeIfPaused()
    return 'idle'
  }

  async function runTick(): Promise<TickResult> {
    const epoch = stopEpoch
    let current: Job | null = null
    try {
      const server = repos.servers.active()
      if (!server) return 'idle'
      const queued = repos.jobs.nextQueued(server.id)
      if (!queued) return await idleCheck()
      current = queued

      if (!isGenerationParams(queued.params) || (queued.type === 'img2img' && (!queued.params.img2img || queued.params.upscale || (queued.params.hires?.scale ?? 1) > 1))
        || (queued.type === 'txt2img' && (queued.params.img2img || queued.params.upscale))
        || (queued.type === 'upscale' && (!queued.params.upscale || queued.params.img2img || (queued.params.hires?.scale ?? 1) > 1))) {
        setStatus(queued.id, 'failed', { error: { code: 'corruptJob' } })
        logError(queued, 'log.error.corruptJob')
        return 'ran'
      }

      const client = deps.client()
      try {
        await client.ping()
      } catch {
        return markPaused()
      }
      let catalog: Catalog
      try {
        catalog = await deps.catalog()
      } catch {
        return markPaused()
      }
      resumeIfPaused() // both ping and catalog succeeded
      if (epoch !== stopEpoch) return 'idle'
      // The active server changed while we were waiting: the job waits for its own server.
      if (repos.servers.active()?.id !== server.id) return 'idle'

      // The job may have been cancelled while we were waiting for the network.
      const job = repos.jobs.get(queued.id)
      if (!job || job.status !== 'queued') return 'ran'
      current = job

      const missing = job.type === 'upscale'
        ? (catalog.upscalers.includes(job.params.upscale!.upscaler) ? [] : [job.params.upscale!.upscaler])
        : checkParts(job.params, catalog, deps.findings).filter((p) => !p.found).map((p) => p.value)
      if (missing.length > 0) {
        setStatus(job.id, 'failed', { error: { code: 'missingParts', missing } })
        logError(job, 'log.error.missingParts', { missing })
        return 'ran'
      }

      let sourceBase64: string | undefined
      if (job.type === 'img2img' || job.type === 'upscale') {
        const source = repos.images.get((job.params.img2img ?? job.params.upscale)!.sourceImageId)
        if (!source) return failSource(job, 'sourceMissing')
        if (source.hidden && !deps.lock?.isOpen()) return failSource(job, 'sourceLocked')
        if (job.type === 'upscale' && (source.width * job.params.upscale!.scale > 4096
          || source.height * job.params.upscale!.scale > 4096)) return failSource(job, 'sourceCorrupt')
        try {
          sourceBase64 = await deps.images.readSource(source.filePath)
        } catch (err) {
          if (err instanceof SourceImageError) return failSource(job, err.kind === 'missing' ? 'sourceMissing' : 'sourceCorrupt')
          return failSource(job, 'sourceCorrupt')
        }
        if (epoch !== stopEpoch || repos.servers.active()?.id !== server.id) return 'idle'
        if (repos.jobs.get(job.id)?.status !== 'queued') return 'ran'
        const latest = repos.images.get(source.id)
        if (!latest) return failSource(job, 'sourceMissing')
        if (latest.hidden && !deps.lock?.isOpen()) return failSource(job, 'sourceLocked')
      }
      return await execute(job, client, sourceBase64)
    } catch (err) {
      console.error('runner: tick failed', err)
      const sourceJob = current?.type === 'img2img' || current?.type === 'upscale'
      const message = sourceJob ? 'source-image job failed unexpectedly' : messageOf(err)
      const stack = !sourceJob && err instanceof Error ? err.stack : undefined
      log({
        level: 'error', category: 'error', messageKey: 'log.error.runner', jobId: current?.id,
        details: {
          detail: message,
          ...(stack !== undefined ? { stack } : {}),
        },
      })
      if (current) {
        try {
          const status = repos.jobs.get(current.id)?.status
          if (status === 'queued' || status === 'running') setStatus(current.id, 'failed', { error: { code: 'unexpected', detail: message } })
        } catch (inner) {
          console.error('runner: could not fail the job', inner)
        }
      }
      active = null
      return 'paused'
    }
  }

  function markPaused(reason: 'unreachable' | 'restart' = 'unreachable'): 'paused' {
    if (!queuePaused) {
      queuePaused = true
      log({ level: 'warn', category: 'queue', messageKey: 'log.queue.paused', details: { reason } })
    }
    return 'paused'
  }

  function failSource(job: Job, code: 'sourceMissing' | 'sourceLocked' | 'sourceCorrupt'): TickResult {
    setStatus(job.id, 'failed', { error: { code } })
    logError(job, 'log.error.sourceImage', { code })
    return 'ran'
  }

  function resumeIfPaused(): void {
    restartPending = false
    if (queuePaused) {
      queuePaused = false
      log({ level: 'info', category: 'queue', messageKey: 'log.queue.resumed' })
    }
  }

  async function execute(job: Job, client: ForgeClient, sourceBase64?: string): Promise<TickResult> {
    const params = job.params
    const body = job.type === 'upscale' ? buildUpscaleBody(params, sourceBase64!)
      : job.type === 'img2img' ? buildImg2ImgBody(params, sourceBase64!, deps.findings)
        : buildTxt2ImgBody(params, deps.findings)

    const a: ActiveJob = { jobId: job.id, client, controller: new AbortController(), cancelling: false, stopping: false, watchdog: false }
    active = a
    setStatus(job.id, 'running')

    if (job.type !== 'upscale' && lastDone && (lastDone.checkpoint !== params.checkpoint || !sameModules(lastDone.modules, params.modules))) {
      log({
        level: 'info', category: 'checkpoint', messageKey: 'log.checkpoint.changed', jobId: job.id,
        details: { from: lastDone.checkpoint, to: params.checkpoint, modulesFrom: lastDone.modules, modulesTo: params.modules },
      })
    }
    log({
      level: 'info', category: 'generation', messageKey: 'log.generation.started', jobId: job.id,
      details: { checkpoint: params.checkpoint, width: params.width, height: params.height, steps: params.steps, seed: params.seed },
    })

    const startedAt = deps.now()
    const samples: { t: number; step: number }[] = []
    let speed: number | null = null
    let lastJobNo = 0
    let settled = false

    const request: Promise<Outcome> = (async () => job.type === 'upscale'
      ? client.upscale(body as ReturnType<typeof buildUpscaleBody>, a.controller.signal)
      : job.type === 'img2img' ? client.img2img(body as ReturnType<typeof buildImg2ImgBody>, a.controller.signal)
        : client.txt2img(body as ReturnType<typeof buildTxt2ImgBody>, a.controller.signal))().then(
      (value): Outcome => { settled = true; return { ok: true, value } },
      (error: unknown): Outcome => { settled = true; return { ok: false, error } },
    )

    // Polls /progress until the request settles. Never throws and is not awaited.
    void (async () => {
      let failures = 0
      try {
        while (!settled) {
          await Promise.race([deps.sleep(PROGRESS_INTERVAL_MS), request])
          if (settled) return
          try {
            const prog = await client.progress()
            failures = 0
            if (settled) return
            const now = deps.now()
            if (prog.state.job_no !== lastJobNo) {
              samples.length = 0
              speed = null
              lastJobNo = prog.state.job_no
            }
            samples.push({ t: now, step: prog.state.sampling_step })
            const sps = stepsPerSec(samples)
            if (sps !== null) speed = sps
            emitSafely(() => events.jobProgress({
              jobId: job.id,
              step: prog.state.sampling_step,
              totalSteps: prog.state.sampling_steps,
              stage: job.type === 'upscale' ? 'upscaling'
                : params.hires && params.hires.scale > 1 && prog.state.job_no > 0 ? 'hires' : 'sampling',
              stepsPerSec: sps,
              elapsedMs: now - startedAt,
              preview: prog.current_image ? `data:image/png;base64,${prog.current_image}` : null,
            }))
          } catch {
            // One failed poll never affects the job, but a long run of them means the link is gone.
            failures++
            if (failures >= PROGRESS_FAILURE_LIMIT && !settled) {
              a.watchdog = true
              a.controller.abort()
              return
            }
          }
        }
      } catch (err) {
        console.error('runner: progress polling stopped', err)
      }
    })()

    const outcome = await request
    const durationMs = deps.now() - startedAt
    active = null
    return finish(job, outcome, a, durationMs, speed)
  }

  function failForgeError(job: Job, err: ForgeError, code: 'forgeHttp' | 'forgeInvalid'): TickResult {
    const error: JobError = { code, ...(err.status !== undefined ? { status: err.status } : {}),
      ...(job.type === 'txt2img' && err.detail !== undefined ? { detail: err.detail } : {}) }
    setStatus(job.id, 'failed', { error })
    logError(job, 'log.error.generation', { kind: err.kind, status: err.status ?? null })
    return 'ran'
  }

  function interrupted(job: Job, error: JobError, messageKey?: string, details: Record<string, unknown> = {}): void {
    setStatus(job.id, 'interrupted', { error })
    if (messageKey) logError(job, messageKey, details)
  }

  async function finish(job: Job, outcome: Outcome, a: ActiveJob, durationMs: number, speed: number | null): Promise<TickResult> {
    const params = job.params

    // A cancel wins over whatever the request returned.
    if (a.cancelling) {
      setStatus(job.id, 'cancelled')
      return 'ran'
    }

    if (!outcome.ok) {
      const err = outcome.error
      if (a.watchdog) {
        interrupted(job, { code: 'network' }, 'log.error.connectionLost', { kind: 'watchdog' })
        return markPaused()
      }
      if (a.stopping || (restartPending && err instanceof ForgeError && err.kind === 'network')) {
        interrupted(job, { code: 'stopped' })
        return 'paused'
      }
      if (err instanceof ForgeError && err.kind === 'http' && err.status === 500) {
        failForgeError(job, err, 'forgeHttp')
        if (job.type !== 'upscale') {
          noteServerError(job)
          await unloadAfterError(job, a.client)
        }
        return 'ran'
      }
      if (err instanceof ForgeError && err.kind === 'http') return failForgeError(job, err, 'forgeHttp')
      if (err instanceof ForgeError && err.kind === 'invalid') return failForgeError(job, err, 'forgeInvalid')
      if (err instanceof ForgeError) {
        interrupted(job, { code: 'network', ...(job.type === 'txt2img' && err.detail !== undefined ? { detail: err.detail } : {}) }, 'log.error.connectionLost',
          { kind: err.kind, status: err.status ?? null })
        return markPaused()
      }
      const message = job.type === 'txt2img' ? messageOf(err) : 'source-image job failed unexpectedly'
      setStatus(job.id, 'failed', { error: { code: 'unexpected', detail: message } })
      logError(job, 'log.error.generation', { detail: message })
      return 'ran'
    }

    // Deterministic rule for stop() and the watchdog: when Forge's answer arrived before the abort
    // took effect, the finished images are kept and the job completes normally; only a request that
    // actually failed is interrupted.
    const response = outcome.value
    if (response.images.length === 0) {
      setStatus(job.id, 'failed', { error: { code: 'noImages' } })
      logError(job, 'log.error.noImages')
      return 'ran'
    }

    const info = parseInfo(response.info)
    const saved: ImageRow[] = []
    let failingPath: string | undefined
    try {
      for (const [i, image] of response.images.entries()) {
        const seedRaw = info.seeds[i]
        const seed = typeof seedRaw === 'number' && Number.isFinite(seedRaw) ? seedRaw : -1
        const infotextRaw = info.infotexts[i]
        const infotext = typeof infotextRaw === 'string' ? infotextRaw : ''
        let file: Awaited<ReturnType<typeof deps.images.save>>
        try {
          file = await deps.images.save(image, { jobId: job.id, seed, createdAt: deps.now() })
        } catch (err) {
          const p = (err as { path?: unknown }).path
          if (typeof p === 'string') failingPath = p
          throw err
        }
        try {
          saved.push(repos.images.insert({
            jobId: job.id, filePath: file.filePath, thumbPath: file.thumbPath,
            width: file.width, height: file.height, seed, infotext, durationMs,
            ...(job.type === 'upscale' && repos.images.get(params.upscale!.sourceImageId)
              ? { sourceImageId: params.upscale!.sourceImageId } : {}),
          }))
        } catch (err) {
          failingPath = file.filePath
          await deps.images.remove(file.filePath, file.thumbPath).catch(() => undefined)
          throw err
        }
      }
    } catch (err) {
      // Roll back what this job already stored so a failed job leaves no images behind.
      for (const row of saved) {
        try {
          repos.images.delete(row.id)
          await deps.images.remove(row.filePath, row.thumbPath)
        } catch (cleanup) {
          console.error('runner: could not remove a partially saved image', cleanup)
        }
      }
      const message = messageOf(err)
      setStatus(job.id, 'failed', { error: { code: 'storage', detail: message } })
      logError(job, 'log.error.storage', { detail: message, ...(failingPath !== undefined ? { path: failingPath } : {}) })
      return 'ran'
    }

    for (const row of saved) emitSafely(() => events.imageAdded(row))
    const finished = setStatus(job.id, 'done', { durationMs, stepsPerSec: speed })
    resetHealth()
    if (job.type !== 'upscale') lastDone = { checkpoint: params.checkpoint, modules: [...params.modules] }
    log({
      level: 'info', category: 'generation', messageKey: 'log.generation.finished', jobId: job.id, durationMs,
      details: {
        checkpoint: params.checkpoint, width: params.width, height: params.height, steps: params.steps,
        seed: saved[0]?.seed ?? params.seed, images: saved.length,
        ...(finished.peakVram !== null ? { peakVram: finished.peakVram } : {}),
      },
    })
    return 'ran'
  }

  // ---- recovery ----------------------------------------------------------

  function setUnhealthy(next: boolean): void {
    if (isUnhealthy === next) return
    isUnhealthy = next
    emitSafely(() => events.forgeHealth?.(next))
  }

  function resetHealth(): void {
    failStreak = null
    setUnhealthy(false)
  }

  /** Counts a generation 500; after UNHEALTHY_AFTER in a row on one server, Forge counts as unhealthy. */
  function noteServerError(job: Job): void {
    const count = failStreak?.serverId === job.serverId ? failStreak.count + 1 : 1
    failStreak = { serverId: job.serverId, count }
    if (count >= UNHEALTHY_AFTER && !isUnhealthy) {
      log({ level: 'warn', category: 'server', messageKey: 'log.recovery.unhealthy', jobId: job.id, details: { count } })
      setUnhealthy(true)
    }
  }

  /**
   * After a 500 Forge's model state may be broken (a failed load leaves the old checkpoint named but
   * nothing loaded). Unloading makes the next job load its model afresh. Best effort: a failure is logged only.
   */
  async function unloadAfterError(job: Job, client: ForgeClient): Promise<void> {
    try {
      await client.unloadCheckpoint(RECOVERY_UNLOAD_TIMEOUT_MS)
      log({ level: 'info', category: 'checkpoint', messageKey: 'log.recovery.unloaded', jobId: job.id })
    } catch (err) {
      log({
        level: 'warn', category: 'checkpoint', messageKey: 'log.recovery.unloadFailed', jobId: job.id,
        details: err instanceof ForgeError ? { kind: err.kind, status: err.status ?? null } : { kind: 'unknown', status: null },
      })
    }
  }

  async function restartForge(): Promise<RestartOutcome> {
    restartPending = true
    let outcome: RestartOutcome
    try {
      outcome = await deps.client().restartServer()
    } catch (err) {
      restartPending = false
      throw err
    }
    if (outcome !== 'restarting') {
      restartPending = false
      return outcome
    }
    if (active && !active.cancelling) {
      active.stopping = true
      active.controller.abort()
    }
    markPaused('restart')
    resetHealth()
    return outcome
  }

  // ---- loop --------------------------------------------------------------

  function kick(): void {
    if (wake) {
      const w = wake
      wake = null
      w()
    } else {
      pendingKick = true
    }
  }

  async function loop(gen: number): Promise<void> {
    while (gen === runGen) {
      let result: TickResult
      try {
        result = await tick()
      } catch (err) {
        console.error('runner: loop tick failed', err)
        result = 'paused'
      }
      if (gen !== runGen) return
      if (result === 'paused') {
        await Promise.race([deps.sleep(PAUSE_INTERVAL_MS), stopSignal])
      } else if (result === 'idle') {
        if (pendingKick) pendingKick = false
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    }
  }

  function start(): void {
    if (running) return
    running = true
    pendingKick = false
    const gen = ++runGen
    stopSignal = new Promise<void>((resolve) => { fireStop = resolve })
    // A loop left over from before a stop() may still be unwinding; the new one waits for it.
    const previous = loopPromise
    const p: Promise<void> = (async () => {
      if (previous) await previous
      if (gen === runGen) await loop(gen)
    })().finally(() => { if (loopPromise === p) loopPromise = null })
    loopPromise = p
  }

  /** Resolves when the loop has exited and no tick is in flight; the caller may then close the database. */
  function stop(): Promise<void> {
    running = false
    runGen++
    stopEpoch++
    if (active) {
      active.stopping = true
      active.controller.abort()
    }
    fireStop()
    kick()
    const pending: Promise<unknown>[] = []
    if (loopPromise) pending.push(loopPromise)
    if (tickInFlight) pending.push(tickInFlight)
    return Promise.allSettled(pending).then(() => undefined)
  }

  return { enqueue, cancel, retry, recover, tick, start, stop, kick, unhealthy: () => isUnhealthy, resetHealth, restartForge }
}
