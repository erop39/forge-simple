import { PROFILES } from '@shared/profiles'
import type { Family, HiresSettings, ImportSummary, ModelKind, PresetParams } from '@shared/types'
import { normalizeBaseUrl } from '../forge/client'
import { isHiresSettings, type createRepos } from '../storage/repos'

type Repos = ReturnType<typeof createRepos>

export const BACKUP_FORMAT = 'forge-neo-client-settings'
export const BACKUP_VERSION = 1
/** A settings file is small; anything bigger is not one. */
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024
const MAX_NAME = 80
const MAX_TEXT = 10_000
const MAX_LIST = 1000

/** Setting keys that are copied; they mirror the ones `ipc/register.ts` writes. */
const HIRES_UPSCALER_KEY = 'upscaler.hires'
const FINISHED_UPSCALER_KEY = 'upscaler.finished'
const RETENTION_KEY = 'oplog.retentionDays'
const familyNegativeKey = (family: string): string => `negative.family.${family}`
const familyModulesKey = (family: string): string => `modules.family.${family}`
const FAMILIES = Object.keys(PROFILES) as Family[]

/** Why a file was refused: not one of ours, a format version this app does not know, or damaged. */
export class BackupError extends Error {
  constructor(readonly code: 'notBackup' | 'unknownVersion' | 'malformed') {
    super(code)
  }
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  servers: { name: string; url: string }[]
  presets: { name: string; params: PresetParams }[]
  hiresPresets: { name: string; settings: HiresSettings }[]
  negativePresets: { name: string; text: string }[]
  /** Marks the user made on files, per server address: a hand-set family (checkpoints) and own trigger words. */
  models: { serverUrl: string; kind: ModelKind; file: string; family?: Family; triggers?: string[] }[]
  settings: {
    retentionDays?: number
    upscalers?: { hires: string; finished: string }
    /** Family → name of the negative preset it starts with ('' = none). */
    familyNegatives: Partial<Record<Family, string>>
    familyModules: Partial<Record<Family, string[]>>
  }
}

/** Everything the file may hold, read from the database. Images, jobs, tags, the log and the lock hash are never read. */
export function buildBackup(repos: Repos, now: Date): BackupFile {
  const servers = repos.servers.list()
  const models: BackupFile['models'] = []
  for (const server of servers) {
    for (const kind of ['checkpoint', 'lora'] as const) {
      for (const [file, row] of repos.modelMeta.list(server.id, kind)) {
        const family = kind === 'checkpoint' && row.family ? row.family : undefined
        const triggers = row.triggers ?? undefined
        if (family === undefined && triggers === undefined) continue
        models.push({ serverUrl: server.url, kind, file, ...(family ? { family } : {}), ...(triggers ? { triggers } : {}) })
      }
    }
  }
  const negativeName = new Map(repos.negativePresets.list().map((p) => [p.id, p.name]))
  const familyNegatives: BackupFile['settings']['familyNegatives'] = {}
  const familyModules: BackupFile['settings']['familyModules'] = {}
  for (const family of FAMILIES) {
    const id = repos.settings.get(familyNegativeKey(family))
    if (id !== null) familyNegatives[family] = id === '' ? '' : negativeName.get(Number(id)) ?? ''
    const raw = repos.settings.get(familyModulesKey(family))
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.every((m): m is string => typeof m === 'string')) familyModules[family] = parsed
      } catch { /* a damaged value is not exported */ }
    }
  }
  const retention = Number(repos.settings.get(RETENTION_KEY))
  const hires = repos.settings.get(HIRES_UPSCALER_KEY)
  const finished = repos.settings.get(FINISHED_UPSCALER_KEY)
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(),
    servers: servers.map((s) => ({ name: s.name, url: s.url })),
    presets: repos.presets.list().map((p) => ({ name: p.name, params: p.params })),
    hiresPresets: repos.hiresPresets.list().map((p) => ({ name: p.name, settings: p.settings })),
    negativePresets: repos.negativePresets.list().map((p) => ({ name: p.name, text: p.text })),
    models,
    settings: {
      ...(Number.isInteger(retention) && retention >= 1 ? { retentionDays: retention } : {}),
      ...(hires !== null && finished !== null ? { upscalers: { hires, finished } } : {}),
      familyNegatives,
      familyModules,
    },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.trim().length <= MAX_NAME
const isFamily = (v: unknown): v is Family => typeof v === 'string' && Object.hasOwn(PROFILES, v)
const isStringList = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s !== '' && s.length <= 500)

/**
 * Reads and checks a whole file. Any fault refuses all of it (`BackupError`): there is no partial import.
 * `validatePreset` is the job validation applied to a preset's parameters (it returns them, or null).
 */
export function parseBackup(text: string, validatePreset: (params: unknown) => PresetParams | null): BackupFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BackupError('malformed')
  }
  if (!isObject(json) || json.format !== BACKUP_FORMAT) throw new BackupError('notBackup')
  if (json.version !== BACKUP_VERSION) throw new BackupError('unknownVersion')
  const bad = (): never => { throw new BackupError('malformed') }
  const list = (key: string): unknown[] => {
    const v = json[key]
    if (v === undefined) return []
    return Array.isArray(v) && v.length <= MAX_LIST ? v : bad()
  }

  const servers = list('servers').map((s) => {
    if (!isObject(s) || !isName(s.name) || typeof s.url !== 'string') return bad()
    try {
      return { name: s.name.trim(), url: normalizeBaseUrl(s.url) }
    } catch {
      return bad()
    }
  })
  const presets = list('presets').map((p) => {
    if (!isObject(p) || !isName(p.name)) return bad()
    const params = validatePreset(p.params)
    return params ? { name: p.name.trim(), params } : bad()
  })
  const hiresPresets = list('hiresPresets').map((p) => {
    if (!isObject(p) || !isName(p.name) || !isHiresSettings(p.settings, 0, 0)) return bad()
    return { name: p.name.trim(), settings: p.settings }
  })
  const negativePresets = list('negativePresets').map((p) => {
    if (!isObject(p) || !isName(p.name) || typeof p.text !== 'string' || p.text.length > MAX_TEXT) return bad()
    return { name: p.name.trim(), text: p.text }
  })
  const models = list('models').map((m) => {
    if (!isObject(m) || typeof m.serverUrl !== 'string' || (m.kind !== 'checkpoint' && m.kind !== 'lora')
      || typeof m.file !== 'string' || m.file === '' || m.file.length > 1000) return bad()
    if (m.family !== undefined && !(m.kind === 'checkpoint' && isFamily(m.family))) return bad()
    if (m.triggers !== undefined && !isStringList(m.triggers, 50)) return bad()
    if (m.family === undefined && m.triggers === undefined) return bad()
    let serverUrl: string
    try {
      serverUrl = normalizeBaseUrl(m.serverUrl)
    } catch {
      return bad()
    }
    return {
      serverUrl, kind: m.kind as ModelKind, file: m.file,
      ...(m.family !== undefined ? { family: m.family as Family } : {}),
      ...(m.triggers !== undefined ? { triggers: m.triggers as string[] } : {}),
    }
  })

  const rawSettings = json.settings === undefined ? {} : json.settings
  if (!isObject(rawSettings)) return bad()
  const settings: BackupFile['settings'] = { familyNegatives: {}, familyModules: {} }
  if (rawSettings.retentionDays !== undefined) {
    const d = rawSettings.retentionDays
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 3650) return bad()
    settings.retentionDays = d
  }
  if (rawSettings.upscalers !== undefined) {
    const u = rawSettings.upscalers
    if (!isObject(u) || typeof u.hires !== 'string' || typeof u.finished !== 'string' || u.hires === '' || u.finished === '') return bad()
    settings.upscalers = { hires: u.hires, finished: u.finished }
  }
  for (const [key, target] of [['familyNegatives', settings.familyNegatives], ['familyModules', settings.familyModules]] as const) {
    const raw = rawSettings[key]
    if (raw === undefined) continue
    if (!isObject(raw)) return bad()
    for (const [family, value] of Object.entries(raw)) {
      if (!isFamily(family)) return bad()
      if (key === 'familyNegatives') {
        if (typeof value !== 'string' || value.length > MAX_NAME) return bad()
        ;(target as BackupFile['settings']['familyNegatives'])[family] = value
      } else {
        if (!isStringList(value, 8)) return bad()
        ;(target as BackupFile['settings']['familyModules'])[family] = value
      }
    }
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: typeof json.exportedAt === 'string' ? json.exportedAt.slice(0, 40) : '', servers, presets, hiresPresets, negativePresets, models, settings }
}

/** A free name for an imported entry: its own, else "<name> (imported)", else "<name> (imported 2)" and so on. */
function freeName(name: string, taken: Set<string>): string {
  const fit = (suffix: string): string => `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`
  let candidate = name
  for (let n = 1; taken.has(candidate.toLowerCase()); n++) candidate = fit(n === 1 ? ' (imported)' : ` (imported ${n})`)
  taken.add(candidate.toLowerCase())
  return candidate
}

/** Adds the file's entries to the database (one transaction) or, with `dryRun`, only counts what that would add. */
function run(repos: Repos, file: BackupFile, dryRun: boolean): ImportSummary {
  const summary: ImportSummary = { servers: 0, presets: 0, hiresPresets: 0, negativePresets: 0, models: 0, settings: 0, renamed: 0, skipped: 0 }
  const write = (fn: () => void): void => { if (!dryRun) fn() }
  const steps = (): void => {
    const liveUrls = new Map(repos.servers.list().map((s) => [s.url, s.id]))
    const serverNames = new Set(repos.servers.list().map((s) => s.name.toLowerCase()))
    for (const s of file.servers) {
      if (liveUrls.has(s.url)) { summary.skipped++; continue }
      const name = freeName(s.name, serverNames)
      if (name !== s.name) summary.renamed++
      summary.servers++
      write(() => { liveUrls.set(s.url, repos.servers.add(name, s.url).id) })
      if (dryRun) liveUrls.set(s.url, -1)
    }
    const importKind = <T extends { name: string }>(
      items: T[], existing: string[], count: 'presets' | 'hiresPresets' | 'negativePresets', add: (name: string, item: T) => number,
    ): Map<string, number> => {
      const taken = new Set(existing.map((n) => n.toLowerCase()))
      const ids = new Map<string, number>()
      for (const item of items) {
        const name = freeName(item.name, taken)
        if (name !== item.name) summary.renamed++
        summary[count]++
        if (!dryRun) ids.set(item.name.toLowerCase(), add(name, item))
      }
      return ids
    }
    importKind(file.presets, repos.presets.list().map((p) => p.name), 'presets', (name, p) => repos.presets.add(name, p.params).id)
    importKind(file.hiresPresets, repos.hiresPresets.list().map((p) => p.name), 'hiresPresets', (name, p) => repos.hiresPresets.add(name, p.settings).id)
    const negativeIds = importKind(file.negativePresets, repos.negativePresets.list().map((p) => p.name), 'negativePresets',
      (name, p) => repos.negativePresets.add(name, p.text).id)

    for (const m of file.models) {
      const serverId = liveUrls.get(m.serverUrl)
      if (serverId === undefined) { summary.skipped++; continue }
      const row = serverId > 0 ? repos.modelMeta.get(serverId, m.kind, m.file) : null
      const family = m.family !== undefined && !row?.family ? m.family : undefined
      const triggers = m.triggers !== undefined && row?.triggers == null ? m.triggers : undefined
      if (family === undefined && triggers === undefined) { summary.skipped++; continue }
      summary.models++
      write(() => {
        if (family !== undefined) repos.modelMeta.setFamily(serverId, m.kind, m.file, family)
        if (triggers !== undefined) repos.modelMeta.setTriggers(serverId, m.kind, m.file, triggers)
      })
    }

    // Settings are filled in only where the user has not chosen yet; an existing choice always stays.
    const setIfUnset = (key: string, value: string): void => {
      if (repos.settings.get(key) !== null) { summary.skipped++; return }
      summary.settings++
      write(() => repos.settings.set(key, value))
    }
    if (file.settings.retentionDays !== undefined) setIfUnset(RETENTION_KEY, String(file.settings.retentionDays))
    if (file.settings.upscalers && repos.settings.get(HIRES_UPSCALER_KEY) === null && repos.settings.get(FINISHED_UPSCALER_KEY) === null) {
      summary.settings++
      write(() => {
        repos.settings.set(HIRES_UPSCALER_KEY, file.settings.upscalers!.hires)
        repos.settings.set(FINISHED_UPSCALER_KEY, file.settings.upscalers!.finished)
      })
    }
    for (const [family, name] of Object.entries(file.settings.familyNegatives) as [Family, string][]) {
      // The name points at an imported preset (or, failing that, one already here with that name).
      const id = name === '' ? '' : negativeIds.get(name.toLowerCase()) ?? repos.negativePresets.list().find((p) => p.name.toLowerCase() === name.toLowerCase())?.id
      if (id === undefined && !(dryRun && file.negativePresets.some((p) => p.name.toLowerCase() === name.toLowerCase()))) { summary.skipped++; continue }
      setIfUnset(familyNegativeKey(family), String(id ?? ''))
    }
    for (const [family, modules] of Object.entries(file.settings.familyModules) as [Family, string[]][]) {
      setIfUnset(familyModulesKey(family), JSON.stringify(modules))
    }
  }
  if (dryRun) steps()
  else repos.transaction(steps)
  return summary
}

/** What importing the file would add, without changing anything. */
export const previewBackup = (repos: Repos, file: BackupFile): ImportSummary => run(repos, file, true)

/** Adds the file's entries in one transaction; nothing is overwritten and a fault rolls everything back. */
export const applyBackup = (repos: Repos, file: BackupFile): ImportSummary => run(repos, file, false)
