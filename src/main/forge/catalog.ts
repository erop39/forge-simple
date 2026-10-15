import { detectFamily } from '@shared/profiles'
import type { Catalog, Family, GenerationParams, ModuleInfo, PartStatus } from '@shared/types'
import type { Oplog } from '../oplog/oplog'
import { ForgeError, type ForgeClient, type LoraItem } from './client'
import type { ProbeFindings } from './findings'

export interface CatalogDeps {
  client(): ForgeClient
  familyOverride(filename: string): Family | null
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
      const [models, modules, loras, samplers, schedulers, upscalers, options] = await Promise.all([
        client.models(), client.modules(), lorasOrEmpty, client.samplers(),
        client.schedulers(), client.upscalers(), client.options(),
      ])
      const loaded = options['sd_model_checkpoint']
      const catalog: Catalog = {
        checkpoints: models.map((m) => ({
          title: m.title,
          name: m.model_name,
          filename: m.filename,
          family: deps.familyOverride(m.filename) ?? detectFamily(m.title),
        })),
        modules: modules.map((m) => ({ name: m.model_name, filename: m.filename })),
        loras: loras.map((l) => ({ name: l.name, path: l.path })),
        samplers,
        schedulers,
        upscalers,
        loadedCheckpoint: typeof loaded === 'string' && loaded !== '' ? loaded : null,
        fetchedAt: deps.now(),
        familyModules: familyModules(options),
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
    // A second pass sends the upscaler's name; one the server no longer lists would end in a Forge 500.
    ...(p.hires && p.hires.scale > 1
      ? [{ role: 'upscaler', value: p.hires.upscaler, found: c.upscalers.includes(p.hires.upscaler) } as PartStatus]
      : []),
  ]
}
