import type { Catalog, GenerationParams, Job, JobProgress } from '@shared/types'
import { ForgeError, type ForgeClient, type GenerationResponse } from '../forge/client'
import { checkParts } from '../forge/catalog'
import type { ProbeFindings } from '../forge/findings'
import { buildTxt2ImgBody } from '../generation/payload'
import type { Oplog, OplogWrite } from '../oplog/oplog'
import type { createImageStore } from '../storage/image-store'
import type { createRepos, ImageRow } from '../storage/repos'
import { stepsPerSec } from './speed'

export interface RunnerEvents {
  jobUpdate(job: Job): void
  jobProgress(p: JobProgress): void
  imageAdded(row: ImageRow): void
}

export interface RunnerDeps {
  client(): ForgeClient
  catalog(): Promise<Catalog>
  findings: ProbeFindings
  repos: ReturnType<typeof createRepos>
  images: ReturnType<typeof createImageStore>
  oplog: Oplog
  events: RunnerEvents
  now(): number
  sleep(ms: number): Promise<void>
}

export type TickResult = 'idle' | 'ran' | 'paused'

export const PROGRESS_INTERVAL_MS = 1000
export const PAUSE_INTERVAL_MS = 5000

interface ActiveJob {
  jobId: number
  controller: AbortController
  cancelling: boolean
  stopping: boolean
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
  stop(): void
  kick(): void
} {
  const { repos, oplog, events } = deps

  let active: ActiveJob | null = null
  let tickInFlight: Promise<TickResult> | null = null
  let lastDone: { checkpoint: string; modules: string[] } | null = null
  let queuePaused = false

  // `stopped` is true once stop() was called and until the next start().
  let stopped = false
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
    const job = repos.jobs.setStatus(id, status, patch)
    emitSafely(() => events.jobUpdate(job))
    return job
  }

  const log = (e: OplogWrite): void => oplog.write(e)

  function logError(job: Job, messageKey: string, message: string, extra: Record<string, unknown> = {}): void {
    log({ level: 'error', category: 'error', messageKey, jobId: job.id, details: { message, ...extra } })
  }

  // ---- public operations -------------------------------------------------

  function enqueue(params: GenerationParams): Job[] {
    const server = repos.servers.active()
    if (!server) throw new Error('No active server')
    const count = Math.max(1, Math.trunc(params.count))
    const jobs: Job[] = []
    for (let i = 0; i < count; i++) {
      const seed = params.seed === -1 ? -1 : params.seed + i
      const job = repos.jobs.insert(server.id, 'txt2img', { ...params, count: 1, seed })
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
        await deps.client().interrupt()
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
    const clone = repos.jobs.insert(job.serverId, job.type, job.params)
    log({ level: 'info', category: 'queue', messageKey: 'log.queue.retried', jobId: clone.id, details: { type: clone.type, originalJobId: jobId } })
    kick()
    return clone
  }

  function recover(): void {
    const n = repos.jobs.markRunningInterrupted()
    if (n > 0) log({ level: 'warn', category: 'queue', messageKey: 'log.queue.recovered', details: { count: n } })
  }

  // ---- one pass ----------------------------------------------------------

  function tick(): Promise<TickResult> {
    if (tickInFlight) return tickInFlight
    const p = runTick().finally(() => { tickInFlight = null })
    tickInFlight = p
    return p
  }

  async function runTick(): Promise<TickResult> {
    let current: Job | null = null
    try {
      const server = repos.servers.active()
      if (!server) return 'idle'
      const queued = repos.jobs.nextQueued(server.id)
      if (!queued) return 'idle'
      current = queued

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
      if (stopped) return 'idle'

      // The job may have been cancelled while we were waiting for the network.
      const job = repos.jobs.get(queued.id)
      if (!job || job.status !== 'queued') return 'ran'
      current = job
      resumeIfPaused()

      const missing = checkParts(job.params, catalog, deps.findings).filter((p) => !p.found).map((p) => p.value)
      if (missing.length > 0) {
        const message = `Not available on the server: ${missing.join(', ')}`
        setStatus(job.id, 'failed', { error: message })
        logError(job, 'log.error.missingParts', message, { missing })
        return 'ran'
      }

      return await execute(job, client)
    } catch (err) {
      console.error('runner: tick failed', err)
      const message = messageOf(err)
      log({ level: 'error', category: 'error', messageKey: 'log.error.runner', jobId: current?.id, details: { message } })
      if (current) {
        try {
          if (repos.jobs.get(current.id)?.status === 'running') setStatus(current.id, 'failed', { error: message })
        } catch (inner) {
          console.error('runner: could not fail the job', inner)
        }
      }
      active = null
      return 'paused'
    }
  }

  function markPaused(): 'paused' {
    if (!queuePaused) {
      queuePaused = true
      log({ level: 'warn', category: 'queue', messageKey: 'log.queue.paused', details: { reason: 'unreachable' } })
    }
    return 'paused'
  }

  function resumeIfPaused(): void {
    if (queuePaused) {
      queuePaused = false
      log({ level: 'info', category: 'queue', messageKey: 'log.queue.resumed' })
    }
  }

  async function execute(job: Job, client: ForgeClient): Promise<TickResult> {
    const params = job.params
    const body = buildTxt2ImgBody(params, deps.findings)

    const a: ActiveJob = { jobId: job.id, controller: new AbortController(), cancelling: false, stopping: false }
    active = a
    setStatus(job.id, 'running')

    if (!lastDone || lastDone.checkpoint !== params.checkpoint || !sameModules(lastDone.modules, params.modules)) {
      log({
        level: 'info', category: 'checkpoint', messageKey: 'log.checkpoint.changed', jobId: job.id,
        details: { from: lastDone?.checkpoint ?? null, to: params.checkpoint },
      })
    }
    log({
      level: 'info', category: 'generation', messageKey: 'log.generation.started', jobId: job.id,
      details: { checkpoint: params.checkpoint, width: params.width, height: params.height, steps: params.steps, seed: params.seed },
    })

    const startedAt = deps.now()
    const samples: { t: number; step: number }[] = []
    let speed: number | null = null
    let settled = false

    const request: Promise<Outcome> = (async () => client.txt2img(body, a.controller.signal))().then(
      (value): Outcome => { settled = true; return { ok: true, value } },
      (error: unknown): Outcome => { settled = true; return { ok: false, error } },
    )

    // Polls /progress until the request settles. Never throws and is not awaited.
    void (async () => {
      try {
        while (!settled) {
          await Promise.race([deps.sleep(PROGRESS_INTERVAL_MS), request])
          if (settled) return
          try {
            const prog = await client.progress()
            if (settled) return
            const now = deps.now()
            samples.push({ t: now, step: prog.state.sampling_step })
            const sps = stepsPerSec(samples)
            if (sps !== null) speed = sps
            emitSafely(() => events.jobProgress({
              jobId: job.id,
              step: prog.state.sampling_step,
              totalSteps: prog.state.sampling_steps,
              stage: 'sampling',
              stepsPerSec: sps,
              elapsedMs: now - startedAt,
              preview: prog.current_image ? `data:image/png;base64,${prog.current_image}` : null,
            }))
          } catch {
            // A failed progress poll never affects the job.
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

  async function finish(job: Job, outcome: Outcome, a: ActiveJob, durationMs: number, speed: number | null): Promise<TickResult> {
    const params = job.params

    if (a.cancelling) {
      setStatus(job.id, 'cancelled')
      return 'ran'
    }

    if (!outcome.ok) {
      const err = outcome.error
      if (a.stopping) {
        setStatus(job.id, 'interrupted', { error: 'Application stopped' })
        return 'paused'
      }
      if (err instanceof ForgeError && (err.kind === 'http' || err.kind === 'invalid')) {
        const message = err.detail ?? `Forge error: ${err.kind}${err.status !== undefined ? ` ${err.status}` : ''}`
        setStatus(job.id, 'failed', { error: message })
        logError(job, 'log.error.generation', message, { kind: err.kind, status: err.status ?? null })
        return 'ran'
      }
      if (err instanceof ForgeError) {
        const message = err.detail ?? err.message
        setStatus(job.id, 'interrupted', { error: message })
        logError(job, 'log.error.connectionLost', message, { kind: err.kind })
        return markPaused()
      }
      const message = messageOf(err)
      setStatus(job.id, 'failed', { error: message })
      logError(job, 'log.error.generation', message)
      return 'ran'
    }

    const response = outcome.value
    if (response.images.length === 0) {
      const message = 'Forge returned no images'
      setStatus(job.id, 'failed', { error: message })
      logError(job, 'log.error.generation', message)
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
      setStatus(job.id, 'failed', { error: message })
      logError(job, 'log.error.storage', message, failingPath !== undefined ? { path: failingPath } : {})
      return 'ran'
    }

    for (const row of saved) emitSafely(() => events.imageAdded(row))
    setStatus(job.id, 'done', { durationMs, stepsPerSec: speed })
    lastDone = { checkpoint: params.checkpoint, modules: [...params.modules] }
    log({
      level: 'info', category: 'generation', messageKey: 'log.generation.finished', jobId: job.id, durationMs,
      details: {
        checkpoint: params.checkpoint, width: params.width, height: params.height, steps: params.steps,
        seed: saved[0]?.seed ?? params.seed, images: saved.length,
      },
    })
    return 'ran'
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

  async function loop(): Promise<void> {
    while (!stopped) {
      let result: TickResult
      try {
        result = await tick()
      } catch (err) {
        console.error('runner: loop tick failed', err)
        result = 'paused'
      }
      if (stopped) return
      if (result === 'paused') {
        await Promise.race([deps.sleep(PAUSE_INTERVAL_MS), stopSignal])
      } else if (result === 'idle') {
        if (pendingKick) pendingKick = false
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    }
  }

  function start(): void {
    if (loopPromise) return
    stopped = false
    pendingKick = false
    stopSignal = new Promise<void>((resolve) => { fireStop = resolve })
    loopPromise = loop().finally(() => { loopPromise = null })
  }

  function stop(): void {
    stopped = true
    if (active) {
      active.stopping = true
      active.controller.abort()
    }
    fireStop()
    kick()
  }

  return { enqueue, cancel, retry, recover, tick, start, stop, kick }
}
