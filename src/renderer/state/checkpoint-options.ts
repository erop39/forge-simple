import { PROFILES } from '@shared/profiles'
import type { CheckpointInfo, Family } from '@shared/types'
import { t, type MessageKey } from '../i18n/t'
import type { SelectOption } from '../components/ui/Select'

const FAMILY_ORDER = Object.keys(PROFILES) as Family[]

const FAMILY_KEYS: Record<Family, MessageKey> = {
  sdxl: 'family.sdxl',
  zimage: 'family.zimage',
  qwen: 'family.qwen',
  lumina: 'family.lumina',
  krea2: 'family.krea2',
  anima: 'family.anima',
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The Model menu: checkpoints grouped by family in the PROFILES order, then by name ignoring case
 * with natural number order. The family is the catalog's (detected from the title unless the user
 * overrode it), so the group matches the model card.
 */
export function checkpointOptions(checkpoints: readonly CheckpointInfo[]): SelectOption[] {
  return [...checkpoints]
    .sort(
      (a, b) =>
        FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || byName.compare(a.name, b.name),
    )
    .map((c) => ({ value: c.title, label: c.name, group: t(FAMILY_KEYS[c.family]) }))
}
