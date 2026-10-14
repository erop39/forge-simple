import { defaultParams, PROFILES } from '@shared/profiles'
import { eventChannel, type AppEvents, type Channel, type ConnectionCheck, type IpcErrorKey } from '@shared/ipc'
import type { Catalog, ConnectionStatus, GenerationParams, ImageRecord } from '@shared/types'
import { checkParts, type createCatalog } from '../forge/catalog'
import { ForgeError, normalizeBaseUrl, type ForgeClient } from '../forge/client'
import { FINDINGS } from '../forge/findings'
import type { Oplog } from '../oplog/oplog'
import type { createRunner } from '../queue/runner'
import { toImageUrl } from '../storage/image-protocol'
import type { createImageStore } from '../storage/image-store'
import { isGenerationParams, type createRepos, type ImageRow } from '../storage/repos'

export interface IpcDeps {
  repos: ReturnType<typeof createRepos>
  /** The catalog of the active server; may be a different instance after the server changes. */
  catalog(): ReturnType<typeof createCatalog>
  runner: ReturnType<typeof createRunner>
  monitor: { sampleOnce(): Promise<ConnectionStatus>; current(): ConnectionStatus }
  images: ReturnType<typeof createImageStore>
  oplog: Oplog
  imagesDir(): string
  /** Builds a throwaway client for a candidate address. */
  createClient(url: string): ForgeClient
  /** Called after a new server address was saved (e.g. to start the connection monitor). */
  onServerChanged?(): void
}

type Send = <K extends keyof AppEvents>(e: K, p: AppEvents[K]) => void

const MAX_IMAGE_PAGE = 500
const MAX_ID = Number.MAX_SAFE_INTEGER

class IpcError extends Error {
  constructor(key: IpcErrorKey) {
    super(key)
    this.name = 'IpcError'
  }
}
const fail = (key: IpcErrorKey): never => { throw new IpcError(key) }

/** Maps a failed Forge call to a stable key; the error's own message never leaves main. */
function forgeErrorKey(err: unknown): 'error.network' | 'error.notForge' {
  return err instanceof ForgeError && (err.kind === 'invalid' || err.kind === 'http')
    ? 'error.notForge'
    : 'error.network'
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

const MAX_TEXT = 10_000
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isNumberIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isOptionalNumber = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** Checks every field the renderer sends and returns a copy holding exactly the known fields. */
function validateEnqueue(p: unknown): GenerationParams {
  if (!isGenerationParams(p)) return fail('error.invalidParams')
  const o = p as GenerationParams
  const shift = isOptionalNumber(o.shift)
  const clipSkip = isOptionalNumber(o.clipSkip)
  const loras = o.loras
  if (!Object.hasOwn(PROFILES, o.family)
    || !isNonEmptyString(o.prompt) || o.prompt.length > MAX_TEXT || o.negativePrompt.length > MAX_TEXT
    || !isNonEmptyString(o.checkpoint) || !isNonEmptyString(o.sampler) || !isNonEmptyString(o.scheduler)
    || !isInt(o.count, 1, 8) || !isInt(o.width, 64, 4096) || !isInt(o.height, 64, 4096) || !isInt(o.steps, 1, 200)
    || !isInt(o.seed, -1, MAX_ID) || !isNumberIn(o.cfgScale, 0, 30) || !isNumberIn(o.distilledCfg, 0, 30)
    || shift === undefined || clipSkip === undefined
    || o.modules.length > 8 || !o.modules.every((m) => typeof m === 'string')
    || loras.length > 16
    || !loras.every((l) => typeof l === 'object' && l !== null && isNonEmptyString(l.name)
      && isNumberIn(l.weight, -5, 5) && typeof l.enabled === 'boolean')) {
    return fail('error.invalidParams')
  }
  return {
    family: o.family, checkpoint: o.checkpoint, modules: [...o.modules], prompt: o.prompt, negativePrompt: o.negativePrompt,
    width: o.width, height: o.height, steps: o.steps, cfgScale: o.cfgScale, distilledCfg: o.distilledCfg,
    shift, clipSkip, sampler: o.sampler, scheduler: o.scheduler, seed: o.seed, count: o.count,
    loras: loras.map((l) => ({ name: l.name, weight: l.weight, enabled: l.enabled })),
  }
}

export function toImageRecord(row: ImageRow, imagesDir: string): ImageRecord {
  const { filePath, thumbPath, ...rest } = row
  return { ...rest, url: toImageUrl(filePath, imagesDir), thumbUrl: toImageUrl(thumbPath, imagesDir) }
}

export function registerIpc(
  ipc: { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void },
  deps: IpcDeps,
  send: Send,
): void {
  const { repos, runner, oplog } = deps

  // Handlers ignore the Electron event argument. Anything that is not an IpcError becomes
  // 'error.unexpected' so internal (English) messages never reach the renderer.
  const handle = (channel: Channel, fn: (...args: unknown[]) => unknown): void => {
    const listener = async (_event: unknown, ...args: unknown[]): Promise<unknown> => {
      try {
        return await fn(...args)
      } catch (err) {
        if (err instanceof IpcError) throw err
        console.error(`ipc: ${channel} failed`, err)
        throw new IpcError('error.unexpected')
      }
    }
    ipc.handle(channel, listener)
  }

  const requireServer = (): void => { if (!repos.servers.active()) fail('error.noServer') }

  async function loadCatalog(refresh = false): Promise<Catalog> {
    requireServer()
    try {
      return await deps.catalog().get(refresh)
    } catch (err) {
      if (err instanceof ForgeError) return fail(forgeErrorKey(err))
      throw err // not a Forge failure: the wrapper logs it and reports error.unexpected
    }
  }

  handle('settings:get', () => ({ serverUrl: repos.servers.active()?.url ?? null, imagesDir: deps.imagesDir() }))

  handle('settings:setServerUrl', async (url): Promise<ConnectionCheck> => {
    if (typeof url !== 'string') return fail('error.invalidParams')
    let normalised: string
    try {
      normalised = normalizeBaseUrl(url)
    } catch {
      return { ok: false, latencyMs: null, errorKey: 'error.network' }
    }
    let latencyMs: number
    try {
      latencyMs = await deps.createClient(normalised).ping()
    } catch (err) {
      return { ok: false, latencyMs: null, errorKey: forgeErrorKey(err) }
    }
    const old = repos.servers.active()?.url ?? null
    repos.servers.setActiveUrl(normalised)
    oplog.write({
      level: 'info', category: 'settings', messageKey: 'log.settings.serverChanged',
      details: { key: 'serverUrl', old, new: normalised },
    })
    deps.onServerChanged?.()
    runner.kick()
    void deps.monitor.sampleOnce()
    return { ok: true, latencyMs, errorKey: null }
  })

  handle('catalog:get', (refresh) => loadCatalog(refresh === true))

  handle('catalog:defaults', async (title) => {
    if (typeof title !== 'string') return fail('error.invalidParams')
    const catalog = await loadCatalog()
    const ckpt = catalog.checkpoints.find((c) => c.title === title) ?? fail('error.notFound')
    return defaultParams(ckpt.family, title, { samplers: catalog.samplers, schedulers: catalog.schedulers },
      catalog.familyModules[ckpt.family] ?? [])
  })

  handle('catalog:parts', async (params) => {
    if (!isGenerationParams(params)) return fail('error.invalidParams')
    return checkParts(params, await loadCatalog(), FINDINGS)
  })

  handle('jobs:enqueue', (params) => {
    const valid = validateEnqueue(params)
    requireServer()
    try {
      return runner.enqueue(valid)
    } catch (err) {
      if (err instanceof RangeError) return fail('error.invalidParams')
      throw err
    }
  })

  handle('jobs:cancel', async (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    await runner.cancel(id)
  })

  handle('jobs:retry', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const job = repos.jobs.get(id) ?? fail('error.notFound')
    if (job.status !== 'failed' && job.status !== 'interrupted' && job.status !== 'cancelled') {
      return fail('error.invalidParams')
    }
    return runner.retry(id)
  })

  handle('jobs:listActive', () => repos.jobs.listActive())

  handle('images:list', (opts) => {
    if (typeof opts !== 'object' || opts === null) return fail('error.invalidParams')
    const { limit, beforeId } = opts as { limit?: unknown; beforeId?: unknown }
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return fail('error.invalidParams')
    if (beforeId !== undefined && !isInt(beforeId, 0, MAX_ID)) return fail('error.invalidParams')
    const clamped = Math.min(MAX_IMAGE_PAGE, Math.max(1, Math.trunc(limit)))
    const rows = repos.images.list(beforeId === undefined ? { limit: clamped } : { limit: clamped, beforeId })
    const dir = deps.imagesDir()
    return rows.map((r) => toImageRecord(r, dir))
  })

  handle('images:delete', async (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const row = repos.images.delete(id) ?? fail('error.notFound')
    try {
      await deps.images.remove(row.filePath, row.thumbPath)
    } catch (err) {
      oplog.write({
        level: 'warn', category: 'storage', messageKey: 'log.storage.fileRemoveFailed', jobId: row.jobId,
        details: { filePath: row.filePath, thumbPath: row.thumbPath, error: err instanceof Error ? err.message : String(err) },
      })
    }
    send('image:removed', { id })
    oplog.write({
      level: 'info', category: 'storage', messageKey: 'log.storage.imageDeleted',
      jobId: row.jobId, details: { imageId: id },
    })
  })

  handle('connection:get', () => deps.monitor.current())
}

/** Listeners that forward runner and monitor events to the renderer through `send`. */
export function forwardEvents(imagesDir: () => string, send: Send) {
  return {
    runner: {
      jobUpdate: (job: AppEvents['job:update']) => send('job:update', job),
      jobProgress: (p: AppEvents['job:progress']) => send('job:progress', p),
      imageAdded: (row: ImageRow) => send('image:added', toImageRecord(row, imagesDir())),
    },
    connection: (s: ConnectionStatus) => send('connection', s),
  }
}
