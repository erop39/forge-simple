import { detectFamily } from '@shared/profiles'
import type { Catalog, Family, GenerationParams, ModuleInfo, PartStatus } from '@shared/types'
import type { Oplog } from '../oplog/oplog'
import { ForgeError, type ForgeClient } from './client'
import type { ProbeFindings } from './findings'

export interface CatalogDeps {
  client(): ForgeClient
  familyOverride(filename: string): Family | null
  oplog: Oplog
  now(): number
}

export function createCatalog(deps: CatalogDeps): { get(refresh?: boolean): Promise<Catalog> } {
  let cached: Catalog | null = null
  let inFlight: Promise<Catalog> | null = null

  async function fetchAll(): Promise<Catalog> {
    const started = deps.now()
    try {
      const client = deps.client()
      const [models, modules, loras, samplers, schedulers, upscalers, options] = await Promise.all([
        client.models(), client.modules(), client.loras(), client.samplers(),
        client.schedulers(), client.upscalers(), client.options(),
      ])
      const loaded = options['sd_model_checkpoint']
      const catalog: Catalog = {
        checkpoints: models.map((m) => ({
          title: m.title,
          name: m.model_name,
          filename: m.filename,
          family: deps.familyOverride(m.filename) ?? detectFamily(m.filename),
        })),
        modules: modules.map((m) => ({ name: m.model_name, filename: m.filename })),
        loras: loras.map((l) => ({ name: l.name, path: l.path })),
        samplers,
        schedulers,
        upscalers,
        loadedCheckpoint: typeof loaded === 'string' && loaded !== '' ? loaded : null,
        fetchedAt: deps.now(),
      }
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
      if (inFlight) return inFlight
      if (cached && !refresh) return Promise.resolve(cached)
      const p = fetchAll().then(
        (c) => { cached = c; inFlight = null; return c },
        (e: unknown) => { inFlight = null; throw e },
      )
      inFlight = p
      return p
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
  ]
}
