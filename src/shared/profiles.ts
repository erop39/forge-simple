import type { Family, GenerationParams } from './types'

export interface FamilyProfile {
  family: Family
  negative: boolean
  cfg: boolean
  distilledCfg: boolean
  shift: boolean
  clipSkip: boolean
  requiresModules: boolean
  defaults: {
    width: number
    height: number
    steps: number
    cfgScale: number
    distilledCfg: number
    shift: number | null
    clipSkip: number | null
    sampler: string
    scheduler: string
  }
}

// Defaults are a hypothesis until checked against real generations.
export const PROFILES: Record<Family, FamilyProfile> = {
  sdxl: {
    family: 'sdxl', negative: true, cfg: true, distilledCfg: false, shift: false, clipSkip: true,
    requiresModules: false,
    defaults: { width: 896, height: 1152, steps: 28, cfgScale: 5, distilledCfg: 3.5, shift: null, clipSkip: 2, sampler: 'Euler a', scheduler: 'Automatic' },
  },
  zimage: {
    family: 'zimage', negative: true, cfg: true, distilledCfg: false, shift: true, clipSkip: false,
    requiresModules: true,
    defaults: { width: 1024, height: 1024, steps: 8, cfgScale: 1, distilledCfg: 3.5, shift: 3, clipSkip: null, sampler: 'Euler', scheduler: 'Simple' },
  },
  qwen: {
    family: 'qwen', negative: true, cfg: true, distilledCfg: false, shift: true, clipSkip: false,
    requiresModules: true,
    defaults: { width: 1024, height: 1024, steps: 20, cfgScale: 4, distilledCfg: 3.5, shift: 3, clipSkip: null, sampler: 'Euler', scheduler: 'Simple' },
  },
  lumina: {
    family: 'lumina', negative: true, cfg: true, distilledCfg: false, shift: true, clipSkip: false,
    requiresModules: true,
    defaults: { width: 1024, height: 1024, steps: 30, cfgScale: 4, distilledCfg: 3.5, shift: 6, clipSkip: null, sampler: 'Euler', scheduler: 'Simple' },
  },
  krea2: {
    family: 'krea2', negative: false, cfg: false, distilledCfg: true, shift: false, clipSkip: false,
    requiresModules: true,
    defaults: { width: 1024, height: 1024, steps: 8, cfgScale: 1, distilledCfg: 3.5, shift: null, clipSkip: null, sampler: 'Euler', scheduler: 'Simple' },
  },
  anima: {
    family: 'anima', negative: true, cfg: true, distilledCfg: false, shift: true, clipSkip: false,
    requiresModules: true,
    defaults: { width: 1024, height: 1024, steps: 30, cfgScale: 4, distilledCfg: 3.5, shift: 3, clipSkip: null, sampler: 'Euler', scheduler: 'Simple' },
  },
}

function familyOfSegment(segment: string): Family | null {
  const name = segment.toLowerCase()
  if (name.includes('krea')) return 'krea2'
  if (name.includes('anima')) return 'anima'
  if (/z_image|z-image|zimage/.test(name)) return 'zimage'
  if (name.includes('lumina')) return 'lumina'
  if (name.includes('qwen')) return 'qwen'
  return null
}

/**
 * Guesses the family from a checkpoint title or path: the base name first, then the folders from
 * innermost to outermost; a trailing " [hash]" is ignored. Unknown names are SDXL.
 */
export function detectFamily(nameOrTitle: string): Family {
  const segments = nameOrTitle.replace(/\s*\[[^\]]*\]\s*$/, '').split(/[\\/]/)
  for (let i = segments.length - 1; i >= 0; i--) {
    const family = familyOfSegment(segments[i] ?? '')
    if (family !== null) return family
  }
  return 'sdxl'
}

export const RATIOS: readonly (readonly [number, number])[] = [
  [1, 1], [3, 4], [4, 3], [2, 3], [3, 2], [9, 16], [16, 9],
]

const snap = (v: number): number => Math.max(64, Math.round(v / 64) * 64)

/** Width and height for an aspect ratio at roughly the given pixel area, snapped to multiples of 64. */
export function dimsForRatio(ratio: readonly [number, number], area: number): { width: number; height: number } {
  const [rw, rh] = ratio
  return {
    width: snap(Math.sqrt((area * rw) / rh)),
    height: snap(Math.sqrt((area * rh) / rw)),
  }
}

/** The profile's choice if the server offers it, else the server's first entry; the profile's choice if the list is empty. */
function pick(preferred: string, available: string[]): string {
  return available.includes(preferred) ? preferred : (available[0] ?? preferred)
}

export function defaultParams(
  family: Family,
  checkpoint: string,
  available: { samplers: string[]; schedulers: string[] },
  modules?: string[],
): GenerationParams {
  const d = PROFILES[family].defaults
  return {
    family,
    checkpoint,
    modules: [...(modules ?? [])],
    prompt: '',
    negativePrompt: '',
    width: d.width,
    height: d.height,
    steps: d.steps,
    cfgScale: d.cfgScale,
    distilledCfg: d.distilledCfg,
    shift: d.shift,
    clipSkip: d.clipSkip,
    sampler: pick(d.sampler, available.samplers),
    scheduler: pick(d.scheduler, available.schedulers),
    seed: -1,
    count: 1,
    loras: [],
  }
}
