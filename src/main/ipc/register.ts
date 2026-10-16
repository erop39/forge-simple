import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import { inLibrary } from '../forge/wishlist'
import { ArchiveError, createArchive, restoreArchive } from '../archive/archive'
import { applyBackup, BackupError, buildBackup, MAX_BACKUP_BYTES, parseBackup, previewBackup, type BackupFile } from '../backup/settings-backup'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultParams, PROFILES } from '@shared/profiles'
import { eventChannel, type AppEvents, type Channel, type ConnectionCheck, type IpcErrorKey } from '@shared/ipc'
import {
  OPLOG_CATEGORIES, OPLOG_LEVELS,
  type ArchiveCreated, type ArchiveRestored, type ArchiveState, type WishlistItem, type Catalog, type ImportSummary, type PresetParams, type CivitaiBrowseItem, type CivitaiBrowseQuery, type ConnectionStatus, type Family, type ForgeCapabilities, type GenerationParams, type ModelKind, type ImageQuery, type ImageRecord,
  type RestartOutcome, type ServerInfo,
} from '@shared/types'
import { checkParts, moduleValue, type createCatalog } from '../forge/catalog'
import { browseCivitai, CivitaiBusyError, type BrowseEntry, createCivitaiClient, fetchThumb, type CivitaiClient } from '../forge/civitai'
import { createCivitaiUpdater } from '../forge/civitai-updater'
import { ForgeError, normalizeBaseUrl, type ForgeClient } from '../forge/client'
import { FINDINGS } from '../forge/findings'
import { LockError, type Lock } from '../lock/lock'
import {
  isRetentionDays, retentionDays, RETENTION_KEY, toJsonLines, type Oplog, type OplogFilter,
} from '../oplog/oplog'
import type { createRunner } from '../queue/runner'
import { toRecordImageUrl } from '../storage/image-protocol'
import type { createImageStore } from '../storage/image-store'
import {
  DuplicatePresetError, DuplicateServerError, hostOf, isGenerationParams, isHiresSettings, isImg2ImgSettings, isUpscaleSettings, normalizeTag, normalizeTags, type createRepos, type ImageRow,
  type Server,
} from '../storage/repos'

export interface IpcDeps {
  repos: ReturnType<typeof createRepos>
  /** The catalog of the active server; may be a different instance after the server changes. */
  catalog(): ReturnType<typeof createCatalog>
  runner: ReturnType<typeof createRunner>
  monitor: { sampleOnce(): Promise<ConnectionStatus>; current(): ConnectionStatus }
  images: ReturnType<typeof createImageStore>
  oplog: Oplog
  imagesDir(): string
  imageRoots?(): string[]
  chooseImagesDir?(current: string): Promise<string | null>
  /** Builds a throwaway client for a candidate address. */
  createClient(url: string, opts?: { pingTimeoutMs?: number }): ForgeClient
  copyToClipboard(text: string): void
  /** Stores a model's own preview picture and drops it again. */
  previews?: { setCustom(kind: ModelKind, filename: string, bytes: Buffer): Promise<string>; clearCustom(kind: ModelKind, filename: string): void }
  /** Looks a file hash up on Civitai; injectable for tests. */
  civitai?: CivitaiClient
  /** Opens a web address in the system browser. */
  openExternal?(url: string): void
  /** Pause between Civitai requests; injectable for tests. */
  civitaiGapMs?: number
  /** fetch used for the Civitai browser (tests). */
  civitaiFetch?: typeof fetch
  /** Shows a file in the system file manager. */
  revealFile(path: string): void
  /** Called after the active server changed or went away (e.g. to start or stop the connection monitor). */
  onServerChanged?(): void
  /** Asks the user where to save a log export (a save dialog); null when cancelled. */
  chooseExportPath(defaultName: string): Promise<string | null>
  /** Asks the user which settings file to import (an open dialog); null when cancelled. */
  chooseImportPath(): Promise<string | null>
  /** Entries read per page while exporting; injectable for tests. */
  exportPageSize?: number
  /** What the active Forge allows (see forge/capabilities.ts). */
  capabilities: { current(): ForgeCapabilities; refresh(): Promise<ForgeCapabilities>; reset(): void }
  /** Forge on this PC; defaults to LOCAL_FORGE_URL, injectable for tests and manual checks. */
  localUrl?: string
  /** The session lock over hidden images (see lock/lock.ts). */
  lock: Lock
}

/** Forge Neo's default address on the same PC. */
export const LOCAL_FORGE_URL = 'http://127.0.0.1:7860'
/** The first-run check of the local Forge must not hold up the start for long. */
const LOCAL_PING_TIMEOUT_MS = 1500

type Send = <K extends keyof AppEvents>(e: K, p: AppEvents[K]) => void

const MAX_IMAGE_PAGE = 200
const MAX_QUERY_TEXT = 500
const MAX_QUERY_TAGS = 20
/** Images one hide or unhide may name. */
const MAX_IMAGE_BATCH = 1000
const MAX_LOG_PAGE = 5000
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

const MAX_SERVER_NAME = 100
const MAX_SERVER_URL = 2048

/** Checks a server's name and address as sent by the renderer; the address is not normalised yet. */
function validateServerInput(input: unknown): { name: string; url: string } {
  if (typeof input !== 'object' || input === null) return fail('error.invalidParams')
  const { name, url } = input as { name?: unknown; url?: unknown }
  if (typeof name !== 'string' || typeof url !== 'string') return fail('error.invalidParams')
  const trimmed = name.trim()
  if (trimmed.length > MAX_SERVER_NAME || url.length > MAX_SERVER_URL) return fail('error.invalidParams')
  return { name: trimmed, url }
}

const toServerInfo = ({ id, name, url, active }: Server): ServerInfo => ({ id, name, url, active })

const MAX_TEXT = 10_000
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isNumberIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isOptionalNumber = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined

const MAX_PRESET_NAME = 80

/** A trimmed, non-empty preset name, or undefined when it is not one. */
const presetName = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed !== '' && trimmed.length <= MAX_PRESET_NAME ? trimmed : undefined
}
/** Negative text follows the enqueue limit for negative prompts; empty is allowed. */
const isPresetText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT

/** Checks a preset patch; `partial` allows either field to be missing, but not both. */
function validatePresetInput(input: unknown, partial: boolean): { name?: string; text?: string } {
  if (typeof input !== 'object' || input === null) return fail('error.invalidParams')
  const { name, text } = input as { name?: unknown; text?: unknown }
  const out: { name?: string; text?: string } = {}
  if (name !== undefined || !partial) out.name = presetName(name) ?? fail('error.invalidParams')
  if (text !== undefined || !partial) {
    if (!isPresetText(text)) return fail('error.invalidParams')
    out.text = text
  }
  if (out.name === undefined && out.text === undefined) return fail('error.invalidParams')
  return out
}

/** Checks every field the renderer sends and returns a copy holding exactly the known fields. */
function validateEnqueue(p: unknown): GenerationParams {
  if (!isGenerationParams(p)) return fail('error.invalidParams')
  const o = p as GenerationParams
  const shift = isOptionalNumber(o.shift)
  const clipSkip = isOptionalNumber(o.clipSkip)
  const loras = o.loras
  const hires = o.hires
  const img2img = o.img2img
  const upscale = o.upscale
  const validHires = hires === undefined || isHiresSettings(hires, o.width, o.height)
  if (!Object.hasOwn(PROFILES, o.family)
    || (!upscale && !isNonEmptyString(o.prompt)) || o.prompt.length > MAX_TEXT || o.negativePrompt.length > MAX_TEXT
    || !isNonEmptyString(o.checkpoint) || !isNonEmptyString(o.sampler) || !isNonEmptyString(o.scheduler)
    || !isInt(o.count, 1, 8) || !isInt(o.width, 64, 4096) || !isInt(o.height, 64, 4096) || !isInt(o.steps, 1, 200)
    || !isInt(o.seed, -1, MAX_ID) || !isNumberIn(o.cfgScale, 0, 30) || !isNumberIn(o.distilledCfg, 0, 30)
    || shift === undefined || clipSkip === undefined
    || !validHires || (img2img !== undefined && (!isImg2ImgSettings(img2img) || upscale !== undefined || hires?.scale !== undefined && hires.scale > 1))
    || (upscale !== undefined && (!isUpscaleSettings(upscale) || hires?.scale !== undefined && hires.scale > 1))
    || (o.tags !== undefined && (!Array.isArray(o.tags) || o.tags.length > MAX_QUERY_TAGS || !o.tags.every((tag) => typeof tag === 'string' && normalizeTag(tag) !== null)))
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
    ...(o.tags !== undefined && o.tags.length > 0 ? { tags: normalizeTags(o.tags) } : {}),
    ...(hires ? { hires: {
      scale: hires.scale, upscaler: hires.upscaler, secondPassSteps: hires.secondPassSteps,
      denoisingStrength: hires.denoisingStrength,
      ...(hires.cfgScale !== undefined ? { cfgScale: hires.cfgScale } : {}),
    } } : {}),
    ...(img2img ? { img2img: {
      sourceImageId: img2img.sourceImageId, denoisingStrength: img2img.denoisingStrength,
      resizeMode: img2img.resizeMode,
    } } : {}),
    ...(upscale ? { upscale: {
      sourceImageId: upscale.sourceImageId, upscaler: upscale.upscaler, scale: upscale.scale,
    } } : {}),
  }
}

/** Checks a log query from the renderer; text search is not part of it (the renderer searches the shown text). */
function validateLogQuery(q: unknown): OplogFilter {
  if (q === undefined) return {}
  if (typeof q !== 'object' || q === null) return fail('error.invalidParams')
  const { level, category, from, limit, ids } = q as Record<string, unknown>
  const out: OplogFilter = {}
  if (level !== undefined) {
    if (!(OPLOG_LEVELS as readonly unknown[]).includes(level)) return fail('error.invalidParams')
    out.level = level as OplogFilter['level']
  }
  if (category !== undefined) {
    if (!(OPLOG_CATEGORIES as readonly unknown[]).includes(category)) return fail('error.invalidParams')
    out.category = category as OplogFilter['category']
  }
  if (from !== undefined) out.from = isInt(from, 0, MAX_ID) ? from : fail('error.invalidParams')
  if (limit !== undefined) out.limit = isInt(limit, 1, MAX_LOG_PAGE) ? limit : fail('error.invalidParams')
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length > MAX_LOG_PAGE || !ids.every((id) => isInt(id, 1, MAX_ID))) {
      return fail('error.invalidParams')
    }
    out.ids = [...(ids as number[])]
  }
  return out
}

/** YYYY-MM-DD of the local calendar day. */
const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Checks a gallery query from the renderer: the page size is clamped to 1..200, the cursor is a positive id,
 * the text is trimmed (at most 500 characters; empty means none) and tags are normalised as stored
 * (at most 20, each 1..40 characters after trimming and collapsing spaces).
 */
export function validateImageQuery(q: unknown): ImageQuery {
  if (typeof q !== 'object' || q === null) return fail('error.invalidParams')
  const { limit, beforeId, text, tags } = q as Record<string, unknown>
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fail('error.invalidParams')
  const out: ImageQuery = { limit: Math.min(MAX_IMAGE_PAGE, Math.max(1, Math.trunc(limit))) }
  if (beforeId !== undefined) out.beforeId = isInt(beforeId, 1, MAX_ID) ? beforeId : fail('error.invalidParams')
  if (text !== undefined) {
    if (typeof text !== 'string') return fail('error.invalidParams')
    const trimmed = text.trim()
    if (trimmed.length > MAX_QUERY_TEXT) return fail('error.invalidParams')
    if (trimmed !== '') out.text = trimmed
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_QUERY_TAGS) return fail('error.invalidParams')
    const clean = tags.map((tag: unknown) => (typeof tag === 'string' ? normalizeTag(tag) : null) ?? fail('error.invalidParams'))
    if (clean.length > 0) out.tags = clean
  }
  return out
}

/**
 * The renderer's copy of an image row. A `locked` row (a hidden image while the lock is closed) keeps only what
 * its tile needs for its place in the grid: no addresses, infotext, seed, tags or job id (jobId is 0).
 */
export function toImageRecord(row: ImageRow, opts: { tags?: string[]; locked?: boolean } = {}): ImageRecord {
  const { filePath: _filePath, thumbPath: _thumbPath, ...rest } = row
  // jobId 0 (no job has it): the job would lead to the prompt.
  if (opts.locked) return { ...rest, jobId: 0, sourceImageId: null, enhanced: false, url: '', thumbUrl: '', infotext: '', seed: 0, tags: [], locked: true }
  return {
    ...rest, tags: opts.tags ?? [], locked: false,
    url: toRecordImageUrl(row.id, 'image'), thumbUrl: toRecordImageUrl(row.id, 'thumb'),
  }
}

export function registerIpc(
  ipc: { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void },
  deps: IpcDeps,
  send: Send,
): void {
  const { repos, runner, oplog, lock } = deps

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
      const catalog = await deps.catalog().get(refresh)
      pruneWishlist(catalog)
      return catalog
    } catch (err) {
      if (err instanceof ForgeError) return fail(forgeErrorKey(err))
      throw err // not a Forge failure: the wrapper logs it and reports error.unexpected
    }
  }

  const localUrl = (): string => normalizeBaseUrl(deps.localUrl ?? LOCAL_FORGE_URL)
  const HIRES_UPSCALER_KEY = 'upscaler.hires'
  const CIVITAI_KEY = 'civitai.enabled'
  const FINISHED_UPSCALER_KEY = 'upscaler.finished'

  const familyNegativeKey = (family: string): string => `negative.family.${family}`
  const familyModulesKey = (family: string): string => `modules.family.${family}`
  const familyModuleDefaults = (): Partial<Record<Family, string[]>> => {
    const out: Partial<Record<Family, string[]>> = {}
    for (const family of Object.keys(PROFILES) as Family[]) {
      try {
        const parsed: unknown = JSON.parse(repos.settings.get(familyModulesKey(family)) || 'null')
        if (Array.isArray(parsed) && parsed.every((m): m is string => typeof m === 'string')) out[family] = parsed
      } catch { /* a damaged value counts as not set */ }
    }
    return out
  }
  const familyNegatives = (): Partial<Record<Family, number>> => {
    const out: Partial<Record<Family, number>> = {}
    for (const family of Object.keys(PROFILES) as Family[]) {
      const id = Number(repos.settings.get(familyNegativeKey(family)))
      if (Number.isInteger(id) && id > 0 && repos.negativePresets.get(id)) out[family] = id
    }
    return out
  }

  handle('settings:get', () => ({
    serverUrl: repos.servers.active()?.url ?? null, imagesDir: deps.imagesDir(), localUrl: localUrl(),
    upscalers: { hires: repos.settings.get(HIRES_UPSCALER_KEY), finished: repos.settings.get(FINISHED_UPSCALER_KEY) },
    familyNegatives: familyNegatives(),
    civitaiEnabled: repos.settings.get(CIVITAI_KEY) === '1',
    familyModules: familyModuleDefaults(),
  }))

  handle('settings:setFamilyModules', async (family, modules) => {
    if (typeof family !== 'string' || !Object.hasOwn(PROFILES, family)) return fail('error.invalidParams')
    if (modules === null) {
      repos.settings.set(familyModulesKey(family), '')
      return
    }
    if (!Array.isArray(modules) || modules.length > 8 || !modules.every((m) => typeof m === 'string' && m !== '' && m.length <= 500)) {
      return fail('error.invalidParams')
    }
    const known = new Set((await loadCatalog()).modules.map((m) => moduleValue(m, FINDINGS)))
    if (!modules.every((m) => known.has(m as string))) return fail('error.notFound')
    repos.settings.set(familyModulesKey(family), JSON.stringify([...new Set(modules as string[])]))
  })

  handle('settings:setFamilyNegative', (family, presetId) => {
    if (typeof family !== 'string' || !Object.hasOwn(PROFILES, family)) return fail('error.invalidParams')
    if (presetId === null) {
      repos.settings.set(familyNegativeKey(family), '')
      return
    }
    if (!isInt(presetId, 1, MAX_ID)) return fail('error.invalidParams')
    if (!repos.negativePresets.get(presetId)) return fail('error.notFound')
    repos.settings.set(familyNegativeKey(family), String(presetId))
  })

  handle('settings:setUpscalers', async (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('error.invalidParams')
    const choices = input as Record<string, unknown>
    const catalog = await loadCatalog()
    if (typeof choices.hires !== 'string' || typeof choices.finished !== 'string'
      || !catalog.upscalers.includes(choices.hires) || !catalog.upscalers.includes(choices.finished)) {
      return fail('error.invalidParams')
    }
    repos.settings.set(HIRES_UPSCALER_KEY, choices.hires)
    repos.settings.set(FINISHED_UPSCALER_KEY, choices.finished)
  })

  handle('settings:chooseImagesDir', async () => {
    const chosen = await deps.chooseImagesDir?.(deps.imagesDir())
    if (chosen == null) return null
    if (typeof chosen !== 'string' || !isAbsolute(chosen)) return fail('error.invalidParams')
    let canonical: string
    try {
      canonical = await fs.realpath(chosen)
      if (!(await fs.stat(canonical)).isDirectory()) return fail('error.storageUnavailable')
      const probe = join(canonical, `.forge-neo-client-${randomUUID()}`)
      const handle = await fs.open(probe, 'wx')
      try { await handle.close() }
      finally { await fs.rm(probe, { force: true }) }
    } catch { return fail('error.storageUnavailable') }
    const roots = [...new Map([...(deps.imageRoots?.() ?? [deps.imagesDir()]), canonical]
      .map((root) => [resolve(root).toLowerCase(), resolve(root)])).values()]
    repos.settings.set('images.roots', JSON.stringify(roots))
    repos.settings.set('imagesDir', canonical)
    oplog.write({ level: 'info', category: 'settings', messageKey: 'log.settings.imagesDirChanged' })
    return canonical
  })

  // ---- saved servers ----------------------------------------------------

  const sendServers = (): void => send('servers', repos.servers.list().map(toServerInfo))

  /** Everything that follows the active server: monitor, runner, connection sample, and the log entry. */
  function activeServerChanged(old: string | null): void {
    const next = repos.servers.active()?.url ?? null
    oplog.write({
      level: 'info', category: 'settings', messageKey: 'log.settings.serverChanged',
      details: { key: 'serverUrl', old, new: next },
    })
    deps.onServerChanged?.()
    runner.resetHealth()
    deps.capabilities.reset()
    civitaiUpdater.cancel() // the rest of a run would describe the other server's files
    runner.kick()
    if (next !== null) {
      void deps.monitor.sampleOnce()
      void deps.capabilities.refresh()
    }
  }

  /** Normalises and pings an address; a failure is a ConnectionCheck, not a rejection. */
  async function testAddress(url: string, pingTimeoutMs?: number): Promise<{ url: string; check: ConnectionCheck }> {
    let normalised: string
    try {
      normalised = normalizeBaseUrl(url)
    } catch {
      return { url, check: { ok: false, latencyMs: null, errorKey: 'error.network' } }
    }
    try {
      const client = pingTimeoutMs === undefined ? deps.createClient(normalised) : deps.createClient(normalised, { pingTimeoutMs })
      const latencyMs = await client.ping()
      return { url: normalised, check: { ok: true, latencyMs, errorKey: null } }
    } catch (err) {
      return { url: normalised, check: { ok: false, latencyMs: null, errorKey: forgeErrorKey(err) } }
    }
  }

  const normalisedOrSelf = (url: string): string => {
    try {
      return normalizeBaseUrl(url)
    } catch {
      return url
    }
  }

  const rethrowDuplicate = (err: unknown): never => {
    if (err instanceof DuplicateServerError) return fail('error.duplicateServer')
    throw err
  }

  /** True when another live server already has this (normalised) address. */
  const takenByOther = (url: string, id: number | null): boolean =>
    repos.servers.list().some((s) => s.url === url && s.id !== id)

  handle('servers:list', () => repos.servers.list().map(toServerInfo))

  handle('servers:add', async (input): Promise<ConnectionCheck> => {
    const { name, url } = validateServerInput(input)
    if (takenByOther(normalisedOrSelf(url), null)) return fail('error.duplicateServer')
    const tested = await testAddress(url)
    if (!tested.check.ok) return tested.check
    try {
      saveTested(name, tested.url)
    } catch (err) {
      return rethrowDuplicate(err)
    }
    return tested.check
  })

  /** Saves an address that answered as Forge and logs it; with no active server it becomes the active one. */
  function saveTested(name: string, url: string): void {
    const server = repos.servers.add(name || hostOf(url), url)
    oplog.write({
      level: 'info', category: 'server', messageKey: 'log.server.added', details: { name: server.name, url: server.url },
    })
    if (!repos.servers.active()) {
      repos.servers.activate(server.id)
      activeServerChanged(null)
    }
    sendServers()
  }

  // First run: only the loopback address is tried, never the network around it.
  handle('servers:addLocal', async (name): Promise<boolean> => {
    const input = validateServerInput({ name, url: '' })
    if (repos.servers.list().length > 0) return false
    const tested = await testAddress(localUrl(), LOCAL_PING_TIMEOUT_MS)
    // A server saved while the ping was out (the user was quicker) wins.
    if (!tested.check.ok || repos.servers.list().length > 0) return false
    saveTested(input.name, tested.url)
    return true
  })

  handle('servers:update', async (id, input): Promise<ConnectionCheck> => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const { name, url } = validateServerInput(input)
    const before = repos.servers.get(id) ?? fail('error.notFound')
    let next = { name: name || before.name, url: before.url }
    let check: ConnectionCheck = { ok: true, latencyMs: null, errorKey: null }
    const urlChanged = normalisedOrSelf(url) !== before.url
    if (urlChanged) {
      if (takenByOther(normalisedOrSelf(url), id)) return fail('error.duplicateServer')
      if (before.active && repos.jobs.hasRunning()) return fail('error.jobRunning')
      const tested = await testAddress(url)
      if (!tested.check.ok) return tested.check
      check = tested.check
      next = { name: name || hostOf(tested.url), url: tested.url }
    }
    try {
      repos.servers.update(id, next) ?? fail('error.notFound')
    } catch (err) {
      return rethrowDuplicate(err)
    }
    oplog.write({
      level: 'info', category: 'server', messageKey: 'log.server.updated',
      details: { old: { name: before.name, url: before.url }, new: next },
    })
    if (before.active && urlChanged) activeServerChanged(before.url)
    sendServers()
    return check
  })

  handle('servers:activate', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const target = repos.servers.get(id) ?? fail('error.notFound')
    if (target.active) return
    if (repos.jobs.hasRunning()) return fail('error.jobRunning')
    const old = repos.servers.active()?.url ?? null
    repos.servers.activate(id)
    activeServerChanged(old)
    sendServers()
  })

  handle('servers:remove', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const target = repos.servers.get(id) ?? fail('error.notFound')
    // Only the active server can have a running job.
    if (target.active && repos.jobs.hasRunning()) return fail('error.jobRunning')
    const { deletedJobIds } = repos.servers.remove(id) ?? fail('error.notFound')
    for (const jobId of deletedJobIds) send('job:removed', { id: jobId })
    oplog.write({
      level: 'info', category: 'server', messageKey: 'log.server.removed',
      details: { name: target.name, url: target.url, deletedJobs: deletedJobIds.length },
    })
    if (target.active) activeServerChanged(target.url)
    sendServers()
  })

  // ---- negative presets ------------------------------------------------
  // The log carries preset names only: the text is prompt content.

  const presetNameFree = <T>(write: () => T): T => {
    try {
      return write()
    } catch (err) {
      if (err instanceof DuplicatePresetError) return fail('error.presetNameTaken')
      throw err
    }
  }

  handle('negativePresets:list', () => repos.negativePresets.list())

  // ---- tags on images --------------------------------------------------------

  handle('tags:suggest', (prefix) => {
    if (typeof prefix !== 'string' || prefix.length > 80) return fail('error.invalidParams')
    return repos.tags.suggest(prefix, 8, { revealHidden: lock.isOpen() })
  })

  /** The ids the renderer may touch now: existing images, hidden ones only while the lock is open. */
  function taggable(ids: unknown, names: unknown): { ids: number[]; names: string[] } {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IMAGE_BATCH || !ids.every((id: unknown) => isInt(id, 1, MAX_ID))
      || !Array.isArray(names) || names.length < 1 || names.length > MAX_QUERY_TAGS || !names.every((n: unknown) => typeof n === 'string')) {
      return fail('error.invalidParams')
    }
    const open = lock.isOpen()
    const usable = (ids as number[]).filter((id) => { const row = repos.images.get(id); return row !== null && (open || !row.hidden) })
    return { ids: usable, names: names as string[] }
  }

  handle('tags:add', (ids, names) => {
    const valid = taggable(ids, names)
    if (valid.ids.length > 0) {
      repos.tags.add(valid.ids, valid.names)
      send('images:changed', { ids: valid.ids })
    }
  })

  handle('tags:remove', (ids, names) => {
    const valid = taggable(ids, names)
    if (valid.ids.length > 0) {
      repos.tags.remove(valid.ids, valid.names)
      send('images:changed', { ids: valid.ids })
    }
  })

  // ---- generation presets (the log carries names only) -----------------------

  handle('presets:list', () => repos.presets.list())

  handle('presets:save', (name, params) => {
    const clean = presetName(name) ?? fail('error.invalidParams')
    if (typeof params !== 'object' || params === null) return fail('error.invalidParams')
    // The ordinary job validation decides what is acceptable; what belongs to one picture is then dropped.
    const checked = validateEnqueue({ ...params, prompt: 'x', negativePrompt: '', seed: -1, count: 1, img2img: undefined, upscale: undefined })
    const { prompt: _p, negativePrompt: _n, seed: _s, count: _c, img2img: _i, upscale: _u, ...kept } = checked
    const preset = presetNameFree(() => repos.presets.add(clean, kept))
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.settingsCreated', details: { name: preset.name } })
    return preset
  })

  handle('presets:rename', (id, name) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const clean = presetName(name) ?? fail('error.invalidParams')
    const before = repos.presets.get(id) ?? fail('error.notFound')
    const after = presetNameFree(() => repos.presets.rename(id, clean)) ?? fail('error.notFound')
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.settingsRenamed', details: { old: before.name, new: after.name } })
    return after
  })

  handle('presets:remove', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const removed = repos.presets.remove(id) ?? fail('error.notFound')
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.settingsDeleted', details: { name: removed.name } })
  })

  handle('presets:applied', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const preset = repos.presets.get(id) ?? fail('error.notFound')
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.settingsApplied', details: { name: preset.name } })
  })

  // ---- hires presets (the log carries names only) --------------------------

  handle('hiresPresets:list', () => repos.hiresPresets.list())

  handle('hiresPresets:add', (input) => {
    if (typeof input !== 'object' || input === null) return fail('error.invalidParams')
    const { name, settings } = input as { name?: unknown; settings?: unknown }
    const clean = presetName(name) ?? fail('error.invalidParams')
    if (!isHiresSettings(settings, 0, 0)) return fail('error.invalidParams')
    const saved = {
      scale: settings.scale, upscaler: settings.upscaler, secondPassSteps: settings.secondPassSteps,
      denoisingStrength: settings.denoisingStrength,
      ...(settings.cfgScale !== undefined ? { cfgScale: settings.cfgScale } : {}),
    }
    const preset = presetNameFree(() => repos.hiresPresets.add(clean, saved))
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.hiresCreated', details: { name: preset.name } })
    return preset
  })

  handle('hiresPresets:rename', (id, name) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const clean = presetName(name) ?? fail('error.invalidParams')
    return presetNameFree(() => repos.hiresPresets.rename(id, clean)) ?? fail('error.notFound')
  })

  handle('hiresPresets:remove', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const removed = repos.hiresPresets.remove(id) ?? fail('error.notFound')
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.hiresDeleted', details: { name: removed.name } })
  })

  handle('negativePresets:add', (input) => {
    const { name, text } = validatePresetInput(input, false) as { name: string; text: string }
    const preset = presetNameFree(() => repos.negativePresets.add(name, text))
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.created', details: { name: preset.name } })
    return preset
  })

  handle('negativePresets:update', (id, patch) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const valid = validatePresetInput(patch, true)
    const before = repos.negativePresets.get(id) ?? fail('error.notFound')
    const after = presetNameFree(() => repos.negativePresets.update(id, valid)) ?? fail('error.notFound')
    if (after.name !== before.name) {
      oplog.write({
        level: 'info', category: 'preset', messageKey: 'log.preset.renamed', details: { old: before.name, new: after.name },
      })
    }
    if (after.text !== before.text) {
      oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.updated', details: { name: after.name } })
    }
    return after
  })

  handle('negativePresets:remove', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const removed = repos.negativePresets.remove(id) ?? fail('error.notFound')
    for (const family of Object.keys(PROFILES)) {
      if (repos.settings.get(familyNegativeKey(family)) === String(id)) repos.settings.set(familyNegativeKey(family), '')
    }
    oplog.write({ level: 'info', category: 'preset', messageKey: 'log.preset.deleted', details: { name: removed.name } })
  })

  handle('catalog:get', (refresh) => {
    // A refresh is also how new preview files are noticed: forget the "has none" answers of this server.
    if (refresh === true) {
      const serverId = repos.servers.active()?.id
      if (serverId !== undefined) repos.modelMeta.clearPreviews(serverId)
    }
    return loadCatalog(refresh === true)
  })

  // ---- optional Civitai lookup (hashes only, slow, cancellable) -------------------
  let lastCatalog: Catalog | null = null
  const civitaiUpdater = createCivitaiUpdater({
    client: deps.civitai ?? createCivitaiClient({ now: Date.now }),
    now: Date.now,
    emit: (progress) => send('civitai:progress', progress),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }),
    ...(deps.civitaiGapMs !== undefined ? { gapMs: deps.civitaiGapMs } : {}),
    items: () => {
      const serverId = repos.servers.active()?.id
      if (serverId === undefined || !lastCatalog) return []
      const stored = (kind: ModelKind) => repos.modelMeta.list(serverId, kind)
      const checkedAt = (row: ReturnType<typeof stored> extends Map<string, infer R> ? R | undefined : never): number | null =>
        row?.civitai && (row.civitai.missing || row.civitai.latest !== undefined) ? row.civitai.checkedAt : null
      const checkpoints = stored('checkpoint')
      const loras = stored('lora')
      return [
        ...lastCatalog.checkpoints.flatMap((c) => (c.sha256 ?? c.hash)
          ? [{ serverId, kind: 'checkpoint' as const, id: c.filename, hash: (c.sha256 ?? c.hash)!, checkedAt: checkedAt(checkpoints.get(c.filename)) }] : []),
        ...lastCatalog.loras.flatMap((l) => l.hash
          ? [{ serverId, kind: 'lora' as const, id: l.path, hash: l.hash, checkedAt: checkedAt(loras.get(l.path)) }] : []),
      ]
    },
    save: (item, info) => {
      // An answer belongs to the server its file was listed on, even when the user has switched since.
      const serverId = item.serverId
      repos.modelMeta.setCivitai(serverId, item.kind, item.id, info ?? { missing: true, checkedAt: Date.now() })
      // A model Forge had no preview for may get one from Civitai now: look it up again.
      if (info?.imageUrl && repos.modelMeta.get(serverId, item.kind, item.id)?.preview === '') {
        repos.modelMeta.setPreview(serverId, item.kind, item.id, '')
        repos.modelMeta.clearPreview(serverId, item.kind, item.id)
      }
    },
  })

  handle('civitai:setEnabled', (enabled) => {
    if (typeof enabled !== 'boolean') return fail('error.invalidParams')
    repos.settings.set(CIVITAI_KEY, enabled ? '1' : '0')
    if (!enabled) civitaiUpdater.cancel()
    oplog.write({ level: 'info', category: 'settings', messageKey: enabled ? 'log.civitai.enabled' : 'log.civitai.disabled' })
  })

  handle('civitai:update', async (opts) => {
    if (repos.settings.get(CIVITAI_KEY) !== '1') return fail('error.invalidParams')
    const force = typeof opts === 'object' && opts !== null && (opts as { force?: unknown }).force === true
    lastCatalog = await loadCatalog()
    void civitaiUpdater.start({ force })
  })

  handle('civitai:updateOne', async (kind, id) => {
    if (repos.settings.get(CIVITAI_KEY) !== '1') return fail('error.invalidParams')
    const target = await modelTarget(kind, id)
    const catalog = await loadCatalog()
    const hash = target.kind === 'checkpoint'
      ? (() => { const c = catalog.checkpoints.find((x) => x.filename === target.id); return c?.sha256 ?? c?.hash })()
      : catalog.loras.find((l) => l.path === target.id)?.hash
    if (!hash) return 'noHash'
    const client = deps.civitai ?? createCivitaiClient({ now: Date.now })
    let info: Awaited<ReturnType<CivitaiClient['lookup']>>
    try {
      info = await client.lookup(hash)
    } catch (err) {
      if (err instanceof CivitaiBusyError) return 'busy'
      throw err
    }
    civitaiUpdater.record({ serverId: target.serverId, kind: target.kind, id: target.id, hash, checkedAt: null }, info)
    return info ? 'found' : 'missing'
  })

  handle('civitai:browse', async (raw) => {
    if (repos.settings.get(CIVITAI_KEY) !== '1') return fail('error.invalidParams')
    const q = raw as Partial<CivitaiBrowseQuery> | null
    if (typeof q !== 'object' || q === null || (q.kind !== 'checkpoint' && q.kind !== 'lora')
      || !(q.site === 'com' || q.site === 'red')
      || !(q.period === 'day' || q.period === 'week' || q.period === 'month')
      || !(q.sort === 'newest' || q.sort === 'downloads' || q.sort === 'rating')
      || !Array.isArray(q.baseModels) || q.baseModels.length > 10 || !q.baseModels.every((b) => typeof b === 'string' && b.length > 0 && b.length <= 60)
      || typeof q.text !== 'string' || q.text.length > 200
      || (q.cursor != null && (typeof q.cursor !== 'string' || q.cursor.length > 200))) return fail('error.invalidParams')
    let page: Awaited<ReturnType<typeof browseCivitai>>
    try {
      page = await browseCivitai({ site: q.site, kind: q.kind, period: q.period, sort: q.sort, baseModels: q.baseModels as string[], text: q.text, cursor: q.cursor ?? null },
        { ...(deps.civitaiFetch ? { fetch: deps.civitaiFetch } : {}), now: Date.now })
    } catch (err) {
      return fail(err instanceof CivitaiBusyError ? 'error.civitaiBusy' : 'error.network')
    }
    const catalog = await loadCatalog().catch(() => null)
    const have = new Map<number, Set<number>>()
    for (const c of [...(catalog?.checkpoints ?? []), ...(catalog?.loras ?? [])]) {
      const m = c.civitai ? /\/models\/(\d+)/.exec(c.civitai.url) : null
      if (!m || !c.civitai) continue
      const id = Number(m[1])
      have.set(id, (have.get(id) ?? new Set()).add(c.civitai.versionId))
    }
    const thumbs: (string | null)[] = new Array(page.entries.length).fill(null)
    let at = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (at < page.entries.length) {
        const i = at++
        const url = page.entries[i]!.imageUrl
        if (url) thumbs[i] = await fetchThumb(url, deps.civitaiFetch)
      }
    }))
    page.entries.forEach((e, i) => {
      shown.set(wishKey(e.modelId, e.versionId), { entry: e, kind: q.kind as ModelKind, site: q.site as 'com' | 'red', thumb: thumbs[i] ?? null })
    })
    while (shown.size > 300) shown.delete(shown.keys().next().value as string)
    return {
      items: page.entries.map((e, i): CivitaiBrowseItem => {
        const versions = have.get(e.modelId)
        const { imageUrl: _drop, files: _files, ...rest } = e
        return { ...rest, thumb: thumbs[i] ?? null, inLibrary: versions ? (versions.has(e.versionId) ? 'have' : 'older') : null }
      }),
      next: page.next,
    }
  })

  // ---- download later ---------------------------------------------------------

  /** The listing entries the browser showed lately, so `wishlist:add` can take everything from main instead of trusting the renderer. */
  const shown = new Map<string, { entry: BrowseEntry; kind: ModelKind; site: 'com' | 'red'; thumb: string | null }>()
  const wishKey = (modelId: number, versionId: number): string => `${modelId}:${versionId}`
  const toWishlistItem = (r: ReturnType<typeof repos.wishlist.list>[number]): WishlistItem => {
    const { files: _files, ...item } = r
    return item
  }
  /** Drops the wished models whose files are in the library now (a comparison in memory, no request). */
  function pruneWishlist(catalog: Catalog): void {
    const gone = repos.wishlist.list().filter((w) => inLibrary(w, catalog))
    if (gone.length === 0) return
    for (const w of gone) repos.wishlist.remove(w.id)
    oplog.write({ level: 'info', category: 'storage', messageKey: 'log.storage.wishlistFound', details: { names: gone.map((w) => w.name).slice(0, 10), count: gone.length } })
    send('wishlist:changed', { removed: gone.length })
  }

  handle('wishlist:list', () => repos.wishlist.list().map(toWishlistItem))

  handle('wishlist:add', (modelId, versionId) => {
    if (!isInt(modelId, 1, MAX_ID) || !isInt(versionId, 1, MAX_ID)) return fail('error.invalidParams')
    const found = shown.get(wishKey(modelId as number, versionId as number)) ?? fail('error.wishlistUnknown')
    const e = found.entry
    repos.wishlist.add({
      modelId: e.modelId, versionId: e.versionId, kind: found.kind, name: e.name, versionName: e.versionName, baseModel: e.baseModel,
      creator: e.creator, site: found.site, thumb: found.thumb, files: e.files,
    })
    send('wishlist:changed', { removed: 0 })
  })

  handle('wishlist:remove', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    if (!repos.wishlist.remove(id as number)) return fail('error.notFound')
    send('wishlist:changed', { removed: 0 })
  })

  handle('civitai:openModel', (modelId, versionId, site) => {
    if (site !== undefined && site !== 'com' && site !== 'red') return fail('error.invalidParams')
    if (!Number.isSafeInteger(modelId) || !Number.isSafeInteger(versionId) || (modelId as number) <= 0 || (versionId as number) <= 0) return fail('error.invalidParams')
    deps.openExternal?.(`https://civitai.${site ?? 'com'}/models/${modelId as number}?modelVersionId=${versionId as number}`)
  })

  handle('civitai:cancel', () => { civitaiUpdater.cancel() })
  handle('civitai:state', () => civitaiUpdater.state())

  handle('civitai:open', async (kind, id, which) => {
    if ((kind !== 'checkpoint' && kind !== 'lora') || typeof id !== 'string') return fail('error.invalidParams')
    const catalog = await loadCatalog()
    const link = (kind === 'checkpoint' ? catalog.checkpoints.find((c) => c.filename === id) : catalog.loras.find((l) => l.path === id))
      ?.civitai
    const url = which === 'newer' ? link?.newer?.url : link?.url
    if (!url || !url.startsWith('https://civitai.com/models/')) return fail('error.notFound')
    deps.openExternal?.(url)
  })

  /** The active server and the file the renderer named, checked against the catalog it was listed in. */
  async function modelTarget(kind: unknown, id: unknown): Promise<{ serverId: number; kind: ModelKind; id: string }> {
    if ((kind !== 'checkpoint' && kind !== 'lora') || typeof id !== 'string' || id === '' || id.length > 1000) {
      return fail('error.invalidParams')
    }
    const serverId = repos.servers.active()?.id ?? fail('error.noServer')
    const catalog = await loadCatalog()
    const listed = kind === 'checkpoint' ? catalog.checkpoints.some((c) => c.filename === id) : catalog.loras.some((l) => l.path === id)
    if (!listed) return fail('error.notFound')
    return { serverId, kind, id }
  }

  handle('models:setFavorite', async (kind, id, favorite) => {
    if (typeof favorite !== 'boolean') return fail('error.invalidParams')
    const target = await modelTarget(kind, id)
    repos.modelMeta.setFavorite(target.serverId, target.kind, target.id, favorite)
  })

  handle('models:setNote', async (kind, id, note) => {
    if (typeof note !== 'string' || note.length > 2000) return fail('error.invalidParams')
    const target = await modelTarget(kind, id)
    repos.modelMeta.setNote(target.serverId, target.kind, target.id, note.trim())
  })

  handle('models:setFamily', async (file, family) => {
    if (family !== null && (typeof family !== 'string' || !Object.hasOwn(PROFILES, family))) return fail('error.invalidParams')
    const target = await modelTarget('checkpoint', file)
    const was = (await loadCatalog()).checkpoints.find((c) => c.filename === target.id)?.family
    repos.modelMeta.setFamily(target.serverId, 'checkpoint', target.id, family as Family | null)
    oplog.write({
      level: 'info', category: 'checkpoint', messageKey: 'log.checkpoint.familyChanged',
      details: { file: target.id.split(/[\\/]/).pop() ?? '', from: was ?? 'auto', to: family ?? 'auto' },
    })
  })

  /** The catalog key of a checked model file: a checkpoint's title, a LoRA's name. */
  async function modelKey(kind: ModelKind, id: string): Promise<string> {
    const catalog = await loadCatalog()
    return (kind === 'checkpoint' ? catalog.checkpoints.find((c) => c.filename === id)?.title : catalog.loras.find((l) => l.path === id)?.name)
      ?? fail('error.notFound')
  }

  const previewSourceKey = (imageId: number): string => `preview.source.${imageId}`
  const previewSources = (imageId: number): { serverId: number; kind: ModelKind; id: string }[] => {
    try {
      const parsed: unknown = JSON.parse(repos.settings.get(previewSourceKey(imageId)) || '[]')
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s?.serverId === 'number' && (s.kind === 'checkpoint' || s.kind === 'lora') && typeof s.id === 'string') : []
    } catch { return [] }
  }
  /** A model preview made from an image must not outlive hiding it: the lock would otherwise not cover that picture. */
  function dropPreviewsMadeFrom(imageId: number): void {
    for (const s of previewSources(imageId)) {
      if (s.serverId === repos.servers.active()?.id) deps.previews?.clearCustom(s.kind, s.id)
      else repos.modelMeta.setPreview(s.serverId, s.kind, s.id, '')
    }
    repos.settings.set(previewSourceKey(imageId), '')
  }

  handle('models:generations', async (kind, id) => {
    const target = await modelTarget(kind, id)
    return toRecords(repos.images.forModel(target.serverId, target.kind, await modelKey(target.kind, target.id), 24))
  })

  handle('models:setPreviewFromImage', async (kind, id, imageId) => {
    if (!isInt(imageId, 1, MAX_ID)) return fail('error.invalidParams')
    const target = await modelTarget(kind, id)
    const row = repos.images.get(imageId) ?? fail('error.notFound')
    if (row.hidden) return fail('error.notFound')
    if (!deps.previews) return fail('error.unexpected')
    let bytes: Buffer
    try {
      bytes = await deps.images.readThumb(row.thumbPath)
    } catch {
      return fail('error.notFound')
    }
    await deps.previews.setCustom(target.kind, target.id, bytes)
    // Remember where the picture came from, so hiding that image takes it off the model again.
    const sources = previewSources(imageId)
    if (!sources.some((s) => s.serverId === target.serverId && s.kind === target.kind && s.id === target.id)) {
      repos.settings.set(previewSourceKey(imageId), JSON.stringify([...sources, { serverId: target.serverId, kind: target.kind, id: target.id }]))
    }
  })

  handle('models:clearPreview', async (kind, id) => {
    const target = await modelTarget(kind, id)
    deps.previews?.clearCustom(target.kind, target.id)
  })

  handle('models:setTriggers', async (kind, id, triggers) => {
    if (triggers !== null && (!Array.isArray(triggers) || triggers.length > 40
      || !triggers.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= 60))) {
      return fail('error.invalidParams')
    }
    const target = await modelTarget(kind, id)
    repos.modelMeta.setTriggers(target.serverId, target.kind, target.id,
      triggers === null ? null : [...new Set(triggers.map((t) => t.trim()))])
  })

  handle('catalog:defaults', async (title) => {
    if (typeof title !== 'string') return fail('error.invalidParams')
    const catalog = await loadCatalog()
    const ckpt = catalog.checkpoints.find((c) => c.title === title) ?? fail('error.notFound')
    // The user's own choice for the family wins while every file of it is still on the server.
    const known = new Set(catalog.modules.map((m) => moduleValue(m, FINDINGS)))
    const own = familyModuleDefaults()[ckpt.family]
    const modules = own && own.every((m) => known.has(m)) ? own : catalog.familyModules[ckpt.family] ?? []
    const params = defaultParams(ckpt.family, title, { samplers: catalog.samplers, schedulers: catalog.schedulers, upscalers: catalog.upscalers },
      modules)
    const preferred = repos.settings.get(HIRES_UPSCALER_KEY)
    if (preferred && catalog.upscalers.includes(preferred) && params.hires) params.hires.upscaler = preferred
    return params
  })

  handle('catalog:parts', async (params) => {
    if (!isGenerationParams(params)) return fail('error.invalidParams')
    return checkParts(params, await loadCatalog(), FINDINGS)
  })

  handle('jobs:enqueue', async (params) => {
    const valid = validateEnqueue(params)
    requireServer()
    if (valid.img2img || valid.upscale) {
      const source = repos.images.get((valid.img2img ?? valid.upscale)!.sourceImageId) ?? fail('error.notFound')
      if (source.hidden && !lock.isOpen()) return fail('error.notFound')
      if (valid.upscale && (source.width * valid.upscale.scale > 4096 || source.height * valid.upscale.scale > 4096)) {
        return fail('error.invalidParams')
      }
      if (valid.upscale && !(await loadCatalog()).upscalers.includes(valid.upscale.upscaler)) {
        return fail('error.invalidParams')
      }
      if (valid.upscale) {
        const latest = repos.images.get(source.id) ?? fail('error.notFound')
        if (latest.hidden && !lock.isOpen()) return fail('error.notFound')
        if (latest.width * valid.upscale.scale > 4096 || latest.height * valid.upscale.scale > 4096) return fail('error.invalidParams')
      }
    }
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
    // A job of a removed server is retried on the active one; without one there is nowhere to run it.
    if (!repos.servers.get(job.serverId)) requireServer()
    if (job.type === 'img2img' || job.type === 'upscale') {
      const valid = validateEnqueue(job.params)
      const source = repos.images.get((valid.img2img ?? valid.upscale)?.sourceImageId ?? -1) ?? fail('error.notFound')
      if (source.hidden && !lock.isOpen()) return fail('error.notFound')
      if (valid.upscale && (source.width * valid.upscale.scale > 4096 || source.height * valid.upscale.scale > 4096)) {
        return fail('error.invalidParams')
      }
    }
    return runner.retry(id)
  })

  handle('jobs:listActive', () => repos.jobs.listActive())

  handle('jobs:clearUnfinished', () => {
    const ids = repos.jobs.clearUnfinished()
    for (const id of ids) send('job:removed', { id })
    return ids.length
  })

  handle('jobs:get', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const job = repos.jobs.get(id) ?? fail('error.notFound')
    // The job holds the prompt of the image it made: while that image is hidden and locked, there is no such job.
    if (!lock.isOpen() && repos.images.jobHasHidden(id)) return fail('error.notFound')
    return job
  })

  /** Rows as the renderer may see them now: tags read in one query, hidden rows redacted while locked. */
  function toRecords(rows: ImageRow[]): ImageRecord[] {
    const open = lock.isOpen()
    const tags = repos.tags.forImages(rows.filter((r) => open || !r.hidden).map((r) => r.id))
    return rows.map((r) => toImageRecord(r, { tags: tags.get(r.id) ?? [], locked: r.hidden && !open }))
  }

  const queryImages = (q: unknown): ImageRecord[] =>
    toRecords(repos.images.query(validateImageQuery(q), { revealHidden: lock.isOpen() }))

  handle('images:query', (q) => queryImages(q))

  // The gallery's unfiltered pages: a query without text or tags.
  handle('images:list', (opts) => {
    if (typeof opts !== 'object' || opts === null) return fail('error.invalidParams')
    const { limit, beforeId } = opts as { limit?: unknown; beforeId?: unknown }
    return queryImages(beforeId === undefined ? { limit } : { limit, beforeId })
  })

  handle('images:details', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const row = repos.images.get(id) ?? fail('error.notFound')
    // A hidden image does not exist for the renderer while the lock is closed.
    if (row.hidden && !lock.isOpen()) return fail('error.notFound')
    const job = repos.jobs.get(row.jobId) ?? fail('error.notFound')
    return { image: toRecords([row])[0]!, params: validateEnqueue(job.params), jobType: job.type }
  })

  handle('images:setHidden', (ids, hidden) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IMAGE_BATCH
      || !ids.every((id: unknown) => isInt(id, 1, MAX_ID)) || typeof hidden !== 'boolean') {
      return fail('error.invalidParams')
    }
    // Hiding needs a password to exist (the renderer asks for one at the first hide). Unhiding needs the lock
    // open: otherwise it would show hidden images without the password.
    if (hidden && !lock.state().hasPassword) return fail('error.noPassword')
    if (!hidden && !lock.isOpen()) return fail('error.notFound')
    const existing = [...new Set(ids as number[])].filter((id) => repos.images.get(id) !== null)
    repos.images.setHidden(existing, hidden)
    if (hidden) for (const id of existing) dropPreviewsMadeFrom(id)
    oplog.write({
      level: 'info', category: 'storage', messageKey: hidden ? 'log.storage.imagesHidden' : 'log.storage.imagesUnhidden',
      details: { ids: existing, count: existing.length },
    })
    send('images:changed', { ids: existing })
  })

  handle('clipboard:writeText', (value) => {
    if (typeof value !== 'string' || value.length > MAX_TEXT) return fail('error.invalidParams')
    deps.copyToClipboard(value)
  })

  handle('images:reveal', (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const row = repos.images.get(id) ?? fail('error.notFound')
    if (row.hidden && !lock.isOpen()) return fail('error.notFound')
    deps.revealFile(row.filePath)
  })

  /** Removes one saved image and its files; false when it is gone or hidden behind a closed lock. */
  async function removeImage(id: number, log = true): Promise<boolean> {
    // Like unhiding: a hidden image cannot be removed without the password.
    if (!lock.isOpen() && repos.images.get(id)?.hidden) return false
    const row = repos.images.delete(id)
    if (!row) return false
    try {
      await deps.images.remove(row.filePath, row.thumbPath)
    } catch (err) {
      oplog.write({
        level: 'warn', category: 'storage', messageKey: 'log.storage.fileRemoveFailed', jobId: row.jobId,
        details: { filePath: row.filePath, thumbPath: row.thumbPath, error: err instanceof Error ? err.message : String(err) },
      })
    }
    send('image:removed', { id })
    // Archiving and delete-all write one summary entry instead of one line per image.
    if (log) {
      oplog.write({
        level: 'info', category: 'storage', messageKey: 'log.storage.imageDeleted',
        jobId: row.jobId, details: { imageId: id },
      })
    }
    return true
  }

  handle('images:delete', async (id) => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    if (!(await removeImage(id))) return fail('error.notFound')
  })

  handle('images:deleteMany', async (ids) => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IMAGE_BATCH || !ids.every((id: unknown) => isInt(id, 1, MAX_ID))) {
      return fail('error.invalidParams')
    }
    const deleted: number[] = []
    const failed: number[] = []
    for (const id of new Set(ids as number[])) (await removeImage(id) ? deleted : failed).push(id)
    return { deleted, failed }
  })

  // ---- archives (images moved out of the gallery into a folder) ------------------

  const ARCHIVE_DIR_KEY = 'archive.dir'
  const archiveDir = (): string => repos.settings.get(ARCHIVE_DIR_KEY) || join(dirname(deps.imagesDir()), 'fnc-archives')
  let archiveBusy = false
  const archiveKey = (err: ArchiveError): IpcErrorKey => {
    if (err.code === 'nothing') return 'error.archiveNothing'
    if (err.code === 'noSpace') return 'error.archiveNoSpace'
    if (err.code === 'version') return 'error.archiveVersion'
    if (err.code === 'noServer') return 'error.noServer'
    return 'error.archiveUnreadable'
  }
  const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

  handle('archive:state', async (): Promise<ArchiveState> => ({
    dir: archiveDir(),
    archives: await Promise.all(repos.archives.list().map(async (a) => ({
      id: a.id, name: a.name, createdAt: a.createdAt, imageCount: a.imageCount, bytes: a.bytes, available: await exists(join(a.path, 'manifest.json')),
    }))),
  }))

  handle('archive:chooseDir', async () => {
    const chosen = await deps.chooseImagesDir?.(archiveDir())
    if (chosen == null) return null
    if (typeof chosen !== 'string' || !isAbsolute(chosen)) return fail('error.invalidParams')
    let canonical: string
    try {
      canonical = await fs.realpath(chosen)
      if (!(await fs.stat(canonical)).isDirectory()) return fail('error.storageUnavailable')
      const probe = join(canonical, `.forge-neo-client-${randomUUID()}`)
      const handle = await fs.open(probe, 'wx')
      try { await handle.close() }
      finally { await fs.rm(probe, { force: true }) }
    } catch { return fail('error.storageUnavailable') }
    repos.settings.set(ARCHIVE_DIR_KEY, canonical)
    oplog.write({ level: 'info', category: 'settings', messageKey: 'log.settings.archiveDirChanged' })
    return canonical
  })

  handle('archive:create', async (ids, label): Promise<ArchiveCreated> => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IMAGE_BATCH || !ids.every((id: unknown) => isInt(id, 1, MAX_ID))
      || typeof label !== 'string' || label.length > 200) return fail('error.invalidParams')
    if (archiveBusy) return fail('error.archiveBusy')
    archiveBusy = true
    try {
      const result = await createArchive({
        repos, now: Date.now, resolveManaged: (file) => deps.images.resolveManaged(file), removeImage: (id) => removeImage(id, false),
      }, archiveDir(), [...new Set(ids as number[])], label)
      for (const id of result.removedJobIds) send('job:removed', { id })
      oplog.write({
        level: 'info', category: 'storage', messageKey: 'log.storage.archived',
        details: { name: result.archive.name, images: result.archived, skippedHidden: result.skippedHidden, unreadable: result.unreadable },
      })
      return { name: result.archive.name, archived: result.archived, skippedHidden: result.skippedHidden, unreadable: result.unreadable, notRemoved: result.notRemoved }
    } catch (err) {
      if (err instanceof ArchiveError) return fail(archiveKey(err))
      throw err
    } finally {
      archiveBusy = false
    }
  })

  handle('archive:restore', async (id): Promise<ArchiveRestored> => {
    if (!isInt(id, 1, MAX_ID)) return fail('error.invalidParams')
    const archive = repos.archives.get(id) ?? fail('error.notFound')
    const serverId = repos.servers.active()?.id ?? fail('error.noServer')
    if (!(await exists(join(archive.path, 'manifest.json')))) return fail('error.archiveUnavailable')
    if (archiveBusy) return fail('error.archiveBusy')
    archiveBusy = true
    try {
      const result = await restoreArchive({ repos, serverId, saveImage: (png, name) => deps.images.save(png, name) }, archive.path)
      send('images:changed', { ids: [] })
      oplog.write({
        level: 'info', category: 'storage', messageKey: 'log.storage.restored',
        details: { name: archive.name, images: result.restored, alreadyThere: result.alreadyThere, damaged: result.damaged },
      })
      return result
    } catch (err) {
      if (err instanceof ArchiveError) return fail(archiveKey(err))
      throw err
    } finally {
      archiveBusy = false
    }
  })

  handle('generations:count', () => repos.images.count())

  handle('generations:deleteAll', async () => {
    if (repos.jobs.listActive().some((j) => j.status === 'queued' || j.status === 'running')) return fail('error.jobRunning')
    if (!lock.isOpen() && repos.images.count().hidden > 0) return fail('error.lockedImages')
    let deleted = 0
    let failed = 0
    for (;;) {
      const page = repos.images.list({ limit: 200 })
      if (page.length === 0) break
      let progress = 0
      for (const row of page) {
        if (await removeImage(row.id, false)) { deleted++; progress++ } else failed++
      }
      if (progress === 0) break
    }
    const jobs = failed === 0 ? repos.jobs.deleteFinished() : []
    for (const id of jobs) send('job:removed', { id })
    oplog.write({ level: 'warn', category: 'storage', messageKey: 'log.storage.allDeleted', details: { images: deleted, failed, jobs: jobs.length } })
    return { deleted, failed }
  })

  handle('connection:get', () => deps.monitor.current())

  // ---- the lock over hidden images ----------------------------------------
  // Passwords never reach the log. Each change of the state is pushed as 'lock'.

  async function lockCall(call: () => Promise<void> | void): Promise<void> {
    try {
      await call()
    } catch (err) {
      if (err instanceof LockError) return fail(err.key)
      throw err
    }
    send('lock', lock.state())
  }

  handle('lock:state', () => lock.state())

  handle('lock:open', (password) => {
    if (typeof password !== 'string') return fail('error.invalidParams')
    return lockCall(() => lock.open(password))
  })

  handle('lock:close', () => lockCall(() => lock.close()))

  handle('lock:setPassword', (oldPassword, next) => {
    if ((oldPassword !== null && typeof oldPassword !== 'string') || typeof next !== 'string') {
      return fail('error.invalidParams')
    }
    return lockCall(() => lock.setPassword(oldPassword, next))
  })

  // ---- operation log -----------------------------------------------------

  // ---- settings backup ------------------------------------------------------

  let pendingImport: BackupFile | null = null
  /** The job validation applied to a preset's parameters; what belongs to one picture is dropped. */
  const validatePresetParams = (params: unknown): PresetParams | null => {
    if (typeof params !== 'object' || params === null) return null
    try {
      const checked = validateEnqueue({ ...params, prompt: 'x', negativePrompt: '', seed: -1, count: 1, img2img: undefined, upscale: undefined })
      const { prompt: _p, negativePrompt: _n, seed: _s, count: _c, img2img: _i, upscale: _u, ...kept } = checked
      return kept
    } catch {
      return null
    }
  }

  handle('backup:export', async (): Promise<boolean> => {
    const path = await deps.chooseExportPath(`forge-neo-client-settings-${localDay(new Date())}.json`)
    if (path === null) return false
    const file = buildBackup(repos, new Date())
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8')
    // The file name only: the folder may name the user, and the file holds server addresses.
    oplog.write({ level: 'info', category: 'backup', messageKey: 'log.backup.settingsExported', details: { file: basename(path), servers: file.servers.length, presets: file.presets.length } })
    return true
  })

  handle('backup:preview', async (): Promise<ImportSummary | null> => {
    pendingImport = null
    const path = await deps.chooseImportPath()
    if (path === null) return null
    try {
      if ((await stat(path)).size > MAX_BACKUP_BYTES) return fail('error.backupTooBig')
      pendingImport = parseBackup(await readFile(path, 'utf8'), validatePresetParams)
    } catch (err) {
      if (err instanceof BackupError) {
        return fail(err.code === 'unknownVersion' ? 'error.backupVersion' : err.code === 'notBackup' ? 'error.backupNotBackup' : 'error.backupMalformed')
      }
      if (err instanceof IpcError) throw err
      return fail('error.backupMalformed')
    }
    return previewBackup(repos, pendingImport)
  })

  handle('backup:apply', (): ImportSummary => {
    const file = pendingImport ?? fail('error.notFound')
    pendingImport = null
    const summary = applyBackup(repos, file)
    oplog.write({ level: 'info', category: 'backup', messageKey: 'log.backup.settingsImported', details: { ...summary } })
    return summary
  })

  handle('backup:discard', () => { pendingImport = null })

  handle('oplog:list', (query) => oplog.list(validateLogQuery(query)))

  handle('oplog:export', async (query): Promise<boolean> => {
    // The export holds every matching entry, read page by page, not just what the panel shows.
    const { limit: _shown, ...filter } = validateLogQuery(query)
    const path = await deps.chooseExportPath(`forge-neo-client-log-${localDay(new Date())}.jsonl`)
    if (path === null) return false
    const pageSize = deps.exportPageSize ?? MAX_LOG_PAGE
    await writeFile(path, '', 'utf8')
    let count = 0
    let before: OplogFilter['before']
    for (;;) {
      const page = oplog.list({ ...filter, limit: pageSize, ...(before ? { before } : {}) })
      if (page.length === 0) break
      await appendFile(path, toJsonLines(page), 'utf8')
      count += page.length
      if (page.length < pageSize) break
      const last = page[page.length - 1]!
      before = { time: last.time, id: last.id }
    }
    // The file name only: the folder may name the user.
    oplog.write({ level: 'info', category: 'backup', messageKey: 'log.backup.logExported', details: { file: basename(path), count } })
    return true
  })

  handle('oplog:retention', () => retentionDays(repos.settings.get(RETENTION_KEY)))

  handle('oplog:setRetention', (days) => {
    if (!isRetentionDays(days)) return fail('error.invalidParams')
    const old = retentionDays(repos.settings.get(RETENTION_KEY))
    repos.settings.set(RETENTION_KEY, String(days))
    if (old !== days) {
      oplog.write({
        level: 'info', category: 'settings', messageKey: 'log.settings.changed', details: { key: RETENTION_KEY, old, new: days },
      })
    }
  })

  // ---- control of the active Forge ---------------------------------------
  // The log carries the server's name and address only.

  const activeServer = (): Server => repos.servers.active() ?? fail('error.noServer')

  handle('forge:capabilities', () => deps.capabilities.current())

  handle('forge:health', () => ({ unhealthy: runner.unhealthy() }))

  handle('forge:restart', async (): Promise<RestartOutcome> => {
    const server = activeServer()
    let outcome: RestartOutcome
    try {
      outcome = await runner.restartForge()
    } catch (err) {
      if (err instanceof ForgeError) return fail(forgeErrorKey(err))
      throw err
    }
    oplog.write({
      level: outcome === 'restarting' ? 'info' : 'warn', category: 'server',
      messageKey: outcome === 'restarting' ? 'log.server.restartRequested' : 'log.server.restartRefused',
      details: { name: server.name, url: server.url, outcome },
    })
    // Reconnecting shows at once instead of on the monitor's next sample.
    if (outcome === 'restarting') void deps.monitor.sampleOnce()
    return outcome
  })

  handle('forge:unload', async () => {
    const server = activeServer()
    if (repos.jobs.hasRunning()) return fail('error.jobRunning')
    try {
      await deps.createClient(server.url).unloadCheckpoint()
    } catch (err) {
      if (err instanceof ForgeError) return fail(forgeErrorKey(err))
      throw err
    }
    oplog.write({
      level: 'info', category: 'server', messageKey: 'log.server.unloaded', details: { name: server.name, url: server.url },
    })
  })
}

/** Listeners that forward runner and monitor events to the renderer through `send`. */
export function forwardEvents(send: Send, lock: { isOpen(): boolean }, tagsOf?: (imageId: number) => string[]) {
  return {
    runner: {
      jobUpdate: (job: AppEvents['job:update']) => send('job:update', job),
      jobProgress: (p: AppEvents['job:progress']) => send('job:progress', p),
      imageAdded: (row: ImageRow) => send('image:added', toImageRecord(row, { locked: row.hidden && !lock.isOpen(), ...(tagsOf ? { tags: tagsOf(row.id) } : {}) })),
      forgeHealth: (unhealthy: boolean) => send('forge:health', { unhealthy }),
    },
    capabilities: (c: ForgeCapabilities) => send('forge:capabilities', c),
    connection: (s: ConnectionStatus) => send('connection', s),
  }
}
