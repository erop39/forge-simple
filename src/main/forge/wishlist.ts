import type { Catalog } from '@shared/types'

const baseName = (file: string): string => (file.split(/[\\/]/).pop() ?? file).toLowerCase()

/**
 * True when the library already holds the wished model version: a file whose Civitai answer names that version, or
 * (before any Civitai lookup has run) a file with the same name as one of the version's files. Plain in-memory
 * comparison, no request: the cost is the size of the wishlist times the size of the library.
 */
export function inLibrary(item: { modelId: number; versionId: number; files: string[] }, catalog: Catalog): boolean {
  const names = new Set(item.files.map(baseName))
  const linked = (link: { url: string; versionId: number } | null | undefined): boolean => {
    if (!link || link.versionId !== item.versionId) return false
    const m = /\/models\/(\d+)/.exec(link.url)
    return m !== null && Number(m[1]) === item.modelId
  }
  for (const c of catalog.checkpoints) if (linked(c.civitai) || names.has(baseName(c.filename))) return true
  for (const l of catalog.loras) if (linked(l.civitai) || names.has(baseName(l.path))) return true
  return false
}
