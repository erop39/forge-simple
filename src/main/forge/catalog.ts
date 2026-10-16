import { detectFamily } from '@shared/profiles'
import type { Catalog, CivitaiLink, Family, GenerationParams, ModelKind, ModuleInfo, PartStatus } from '@shared/types'
import type { ModelMetaRow } from '../storage/repos'
import { baseFamilyFromText } from './lora-meta'
import { baseFamilyFromMetadata, triggersFromMetadata } from './lora-meta'
import type { Oplog } from '../oplog/oplog'
import { ForgeError, type ForgeClient, type LoraItem } from './client'
import type { ProbeFindings } from './findings'

export interface CatalogDeps {
  client(): ForgeClient
  familyOverride(filename: string): Family | null
  /** Marks the user made on files of the active server; read at every `get`, so they apply without a refetch. */
  modelMeta?(kind: ModelKind): Map<string, ModelMetaRow>
  previewUrl?(kind: ModelKind, filename: string): string
  /** How often each checkpoint (title) and LoRA (name) was used by finished jobs of the active server. */
  usage?(): { checkpoints: Map<string, { uses: number; last: number | null }>; loras: Map<string, { uses: number; last: number | null }> }
  /** Told which files a fresh fetch listed, so the first appearance of a new one can be recorded. */
  noteSeen?(kind: ModelKind, files: string[]): void
  oplog: Oplog
  now(): number
}

const FAMILY_MODULE_OPTIONS: readonly (readonly [Family, string])[] = [
  ['sdxl', 'forge_additional_modules_xl'],
  ['zimage', 'forge_additional_modules_zit'],
  ['qwen', 'forge_additional_modules_qwen'],
  ['lumina', 'forge_additional_modules_lumina'],
  ['krea2', 'forge_additional_modules_krea'],
  ['anima', 'forge_additional_modules_anima'],
]

function familyModules(options: Record<string, unknown>): Partial<Record<Family, string[]>> {
  const out: Partial<Record<Family, string[]>> = {}
  for (const [family, key] of FAMILY_MODULE_OPTIONS) {
    const v = options[key]
    if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) out[family] = [...v]
  }
  return out
}

export function createCatalog(deps: CatalogDeps): { get(refresh?: boolean): Promise<Catalog> } {
  let cached: Catalog | null = null
  let inFlight: Promise<Catalog> | null = null
  // Raw LoRA metadata is kept apart from the catalog: it is large and only the derived words and family are sent.
  let loraMetadata = new Map<string, Record<string, unknown>>()
  let loraHashes = new Map<string, string>()

  const releasedOf = (mark: ModelMetaRow | undefined): number | null =>
    mark?.civitai && !mark.civitai.missing ? mark.civitai.publishedAt ?? null : null

  const civitaiOf = (mark: ModelMetaRow | undefined): CivitaiLink | null => {
    const c = mark?.civitai
    if (!c || c.missing) return null
    const newest = c.latest && c.latest.versionId > c.versionId ? c.latest : null
    return {
      url: `https://civitai.com/models/${c.modelId}?modelVersionId=${c.versionId}`,
      name: c.name, baseModel: c.baseModel, versionId: c.versionId,
      newer: newest ? { name: newest.name, publishedAt: newest.publishedAt,
        url: `https://civitai.com/models/${c.modelId}?modelVersionId=${newest.versionId}` } : null,
    }
  }

  /** Other files that are the same model: the same hash, or the same Civitai version. Keys are lower-case. */
  function duplicatesOf(entries: { id: string; keys: string[] }[]): Map<string, string[]> {
    const groups = new Map<string, Set<string>>()
    for (const entry of entries) {
      for (const key of entry.keys) {
        const set = groups.get(key) ?? new Set<string>()
        set.add(entry.id)
        groups.set(key, set)
      }
    }
    const out = new Map<string, string[]>()
    for (const entry of entries) {
      const others = new Set<string>()
      for (const key of entry.keys) for (const id of groups.get(key) ?? []) if (id !== entry.id) others.add(id)
      if (others.size > 0) out.set(entry.id, [...others].sort())
    }
    return out
  }

  /** The fetched catalog with the user's marks applied; cheap, so it runs at every `get`. */
  function withMarks(base: Catalog): Catalog {
    const checkpointMeta = deps.modelMeta?.('checkpoint') ?? new Map<string, ModelMetaRow>()
    const loraMeta = deps.modelMeta?.('lora') ?? new Map<string, ModelMetaRow>()
    const used = deps.usage?.()
    const keysOf = (hash: string | null | undefined, mark: ModelMetaRow | undefined): string[] => [
      ...(hash ? [`h:${hash.toLowerCase()}`] : []),
      ...(mark?.civitai && !mark.civitai.missing ? [`v:${mark.civitai.versionId}`] : []),
    ]
    const checkpointDupes = duplicatesOf(base.checkpoints.map((c) => ({ id: c.filename, keys: keysOf(c.sha256 ?? c.hash, checkpointMeta.get(c.filename)) })))
    const loraDupes = duplicatesOf(base.loras.map((l) => ({ id: l.path, keys: keysOf(loraHashes.get(l.path), loraMeta.get(l.path)) })))
    return {
      ...base,
      checkpoints: base.checkpoints.map((c) => {
        const mark = checkpointMeta.get(c.filename)
        const detected = detectFamily(c.title)
        return {
          ...c,
          family: mark?.family ?? deps.familyOverride(c.filename) ?? detected,
          familyOverridden: (mark?.family ?? null) !== null,
          favorite: mark?.favorite ?? false,
          note: mark?.note ?? '',
          previewUrl: deps.previewUrl?.('checkpoint', c.filename) ?? '',
          civitai: civitaiOf(mark),
          triggers: mark?.triggers ?? (mark?.civitai && !mark.civitai.missing ? mark.civitai.trainedWords : []),
          triggersEdited: (mark?.triggers ?? null) !== null,
          addedAt: mark?.firstSeen ?? null,
          releasedAt: releasedOf(mark),
          uses: used?.checkpoints.get(c.title)?.uses ?? 0,
          lastUsedAt: used?.checkpoints.get(c.title)?.last ?? null,
          duplicates: checkpointDupes.get(c.filename) ?? [],
        }
      }),
      loras: base.loras.map((l) => {
        const mark = loraMeta.get(l.path)
        const metadata = loraMetadata.get(l.path) ?? {}
        const own = mark?.triggers ?? null
        const found = mark?.civitai && !mark.civitai.missing ? mark.civitai : null
        const words = found && found.trainedWords.length > 0 ? found.trainedWords : triggersFromMetadata(metadata)
        return {
          ...l,
          hash: loraHashes.get(l.path) ?? null,
          baseFamily: baseFamilyFromMetadata(metadata) ?? (found ? baseFamilyFromText(found.baseModel) : null),
          triggers: own ?? words,
          civitai: civitaiOf(mark),
          triggersEdited: own !== null,
          triggersFrom: own !== null ? 'own' as const : found && found.trainedWords.length > 0 ? 'civitai' as const : 'file' as const,
          favorite: mark?.favorite ?? false,
          note: mark?.note ?? '',
          previewUrl: deps.previewUrl?.('lora', l.path) ?? '',
          addedAt: mark?.firstSeen ?? null,
          releasedAt: releasedOf(mark),
          uses: used?.loras.get(l.name)?.uses ?? 0,
          lastUsedAt: used?.loras.get(l.name)?.last ?? null,
          duplicates: loraDupes.get(l.path) ?? [],
        }
      }),
    }
  }

  async function fetchAll(): Promise<Catalog> {
    const started = deps.now()
    try {
      const client = deps.client()
      // The LoRA list can be slow on big libraries; its failure must not take the catalog down.
      const lorasOrEmpty = client.loras().catch((err: unknown): LoraItem[] => {
        deps.oplog.write({
          level: 'warn', category: 'catalog', messageKey: 'log.catalog.lorasFailed',
          details: err instanceof ForgeError
            ? { kind: err.kind, status: err.status ?? null }
            : { kind: 'unknown', status: null },
        })
        return []
      })
      // The latent modes are a separate list in Forge; without them a hires pass could only name "None".
      const latentModes = client.latentUpscaleModes().catch((): string[] => [
        'Latent', 'Latent (antialiased)', 'Latent (bicubic)', 'Latent (bicubic antialiased)', 'Latent (nearest)', 'Latent (nearest-exact)',
      ])
      const [models, modules, loras, samplers, schedulers, realUpscalers, latent, options] = await Promise.all([
        client.models(), client.modules(), lorasOrEmpty, client.samplers(),
        client.schedulers(), client.upscalers(), latentModes, client.options(),
      ])
      const upscalers = [...new Set([...latent, ...realUpscalers])]
      const loaded = options['sd_model_checkpoint']
      const catalog: Catalog = {
        checkpoints: models.map((m) => ({
          title: m.title,
          name: m.model_name,
          filename: m.filename,
          hash: m.hash,
          sha256: m.sha256,
          family: deps.familyOverride(m.filename) ?? detectFamily(m.title),
        })),
        modules: modules.map((m) => ({ name: m.model_name, filename: m.filename })),
        loras: loras.map((l) => ({ name: l.name, alias: l.alias, path: l.path })),
        samplers,
        schedulers,
        upscalers,
        loadedCheckpoint: typeof loaded === 'string' && loaded !== '' ? loaded : null,
        fetchedAt: deps.now(),
        familyModules: familyModules(options),
      }
      loraMetadata = new Map(loras.map((l) => [l.path, l.metadata]))
      deps.noteSeen?.('checkpoint', models.map((m) => m.filename))
      deps.noteSeen?.('lora', loras.map((l) => l.path))
      loraHashes = new Map(loras.flatMap((l): [string, string][] => {
        const hash = l.metadata.sshs_model_hash
        return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash) ? [[l.path, hash]] : []
      }))
      deps.oplog.write({
        level: 'info', category: 'catalog', messageKey: 'log.catalog.loaded',
        durationMs: deps.now() - started,
        details: {
          checkpoints: catalog.checkpoints.length, modules: catalog.modules.length,
          loras: catalog.loras.length, samplers: catalog.samplers.length,
          schedulers: catalog.schedulers.length, upscalers: catalog.upscalers.length,
        },
      })
      return catalog
    } catch (err) {
      const details: Record<string, unknown> = err instanceof ForgeError
        ? { kind: err.kind, status: err.status ?? null, detail: err.detail ?? err.message }
        : { kind: 'unknown', status: null, detail: err instanceof Error ? err.message : String(err) }
      deps.oplog.write({ level: 'error', category: 'error', messageKey: 'log.catalog.failed', details })
      throw err
    }
  }

  return {
    get(refresh = false) {
      if (inFlight) return inFlight.then(withMarks)
      if (cached && !refresh) return Promise.resolve(withMarks(cached))
      const p = fetchAll().then(
        (c) => { cached = c; inFlight = null; return c },
        (e: unknown) => { inFlight = null; throw e },
      )
      inFlight = p
      return p.then(withMarks)
    },
  }
}

/** The value Forge expects for a module: its file path or its name, per the probe findings. */
export function moduleValue(m: ModuleInfo, findings: ProbeFindings): string {
  return findings.modulesAs === 'path' ? m.filename : m.name
}

export function checkParts(p: GenerationParams, c: Catalog, findings: ProbeFindings): PartStatus[] {
  const known = new Set(c.modules.map((m) => moduleValue(m, findings)))
  return [
    { role: 'model', value: p.checkpoint, found: c.checkpoints.some((x) => x.title === p.checkpoint) },
    ...p.modules.map((m): PartStatus => ({ role: 'module', value: m, found: known.has(m) })),
    // An enabled LoRA the server does not list would be ignored or fail inside Forge; a switched-off one is not sent.
    ...p.loras.filter((l) => l.enabled).map((l): PartStatus => ({
      role: 'lora', value: l.name, found: c.loras.some((x) => x.name === l.name),
    })),
    // A second pass sends the upscaler's name; one the server no longer lists would end in a Forge 500.
    ...(p.hires && p.hires.scale > 1
      ? [{ role: 'upscaler', value: p.hires.upscaler, found: c.upscalers.includes(p.hires.upscaler) } as PartStatus]
      : []),
  ]
}
