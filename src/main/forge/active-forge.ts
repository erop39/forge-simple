import type { Family, ModelKind } from '@shared/types'
import type { ModelMetaRow } from '../storage/repos'
import type { Oplog } from '../oplog/oplog'
import { createCatalog } from './catalog'
import { createForgeClient, ForgeError, type ForgeClient } from './client'

/**
 * Holds one Forge client and one catalog per active server URL. Both follow `activeUrl()`:
 * when the URL changes, the next call rebuilds them, so no cached catalog outlives its server.
 */
export function createActiveForge(deps: {
  activeUrl(): string | null
  familyOverride(filename: string): Family | null
  /** What the user marked on the active server's files (favorite, note, family, own trigger words). */
  modelMeta?(kind: ModelKind): Map<string, ModelMetaRow>
  previewUrl?(kind: ModelKind, filename: string, stamp?: string | null): string
  usage?: NonNullable<Parameters<typeof createCatalog>[0]['usage']>
  noteSeen?(kind: ModelKind, files: string[]): void
  /** The catalog got its LoRA list after it was handed out. */
  onCatalogUpdated?(): void
  oplog: Oplog
  now(): number
  create?: (url: string) => ForgeClient
}) {
  const create = deps.create ?? ((url: string) => createForgeClient(url))
  let url: string | null = null
  let current: ForgeClient | null = null
  let catalog: ReturnType<typeof createCatalog> | null = null

  function sync(): void {
    const next = deps.activeUrl()
    if (next === url && (next === null || current !== null)) return
    url = next
    current = next === null ? null : create(next)
    catalog = null
  }

  function client(): ForgeClient {
    sync()
    if (!current) throw new ForgeError('network', 'No Forge server is configured')
    return current
  }

  return {
    client,
    catalog(): ReturnType<typeof createCatalog> {
      sync()
      catalog ??= createCatalog({
        client, familyOverride: deps.familyOverride, oplog: deps.oplog, now: deps.now,
        ...(deps.modelMeta ? { modelMeta: deps.modelMeta } : {}),
        ...(deps.previewUrl ? { previewUrl: deps.previewUrl } : {}),
        ...(deps.usage ? { usage: deps.usage } : {}),
        ...(deps.noteSeen ? { noteSeen: deps.noteSeen } : {}),
        ...(deps.onCatalogUpdated ? { onUpdated: deps.onCatalogUpdated } : {}),
      })
      return catalog
    },
    address: (): string => deps.activeUrl() ?? '',
  }
}
