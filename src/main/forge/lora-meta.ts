import type { Family } from '@shared/types'

const MAX_TRIGGERS = 8
const MAX_TAG_LENGTH = 60

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * The most frequent training tags of a LoRA (`ss_tag_frequency`: folder → tag → count, an object or its JSON text),
 * summed over folders. Anything unreadable gives an empty list.
 */
export function triggersFromMetadata(metadata: Record<string, unknown>): string[] {
  const folders = asObject(metadata.ss_tag_frequency)
  if (!folders) return []
  const totals = new Map<string, number>()
  for (const tags of Object.values(folders)) {
    const counts = asObject(tags)
    if (!counts) continue
    for (const [raw, count] of Object.entries(counts)) {
      const tag = raw.trim()
      const n = typeof count === 'number' ? count : Number(count)
      if (tag === '' || tag.length > MAX_TAG_LENGTH || !Number.isFinite(n) || n <= 0) continue
      totals.set(tag, (totals.get(tag) ?? 0) + n)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TRIGGERS).map(([tag]) => tag)
}

const FAMILY_HINTS: readonly (readonly [RegExp, Family])[] = [
  [/sdxl|illustrious|pony|noob/, 'sdxl'],
  [/z[-_ ]?image|zimage/, 'zimage'],
  [/anima/, 'anima'],
  [/qwen/, 'qwen'],
  [/lumina/, 'lumina'],
  [/krea/, 'krea2'],
]

/** The family a free-text base model name (`Illustrious`, `SDXL 1.0`, `ZImageTurbo`…) points to. */
export function baseFamilyFromText(value: string): Family | null {
  const lower = value.toLowerCase()
  for (const [pattern, family] of FAMILY_HINTS) if (pattern.test(lower)) return family
  return null
}

/** The family named by the training metadata (`ss_base_model_version`, `modelspec.architecture`); null when unknown. */
export function baseFamilyFromMetadata(metadata: Record<string, unknown>): Family | null {
  for (const key of ['ss_base_model_version', 'modelspec.architecture']) {
    const value = metadata[key]
    if (typeof value !== 'string') continue
    const lower = value.toLowerCase()
    for (const [pattern, family] of FAMILY_HINTS) if (pattern.test(lower)) return family
  }
  return null
}
