import type { ForgeStats } from '@shared/types'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/** Missing optional values from pynvml or nvidia-smi remain null. */
export function parseStats(value: unknown): ForgeStats {
  const root = object(value)
  const cpu = object(root.cpu)
  const ram = object(root.ram)
  const gpu = object(root.gpu)
  return {
    version: stringOrNull(root.version),
    forgeVersion: stringOrNull(root.forge_version),
    torchVersion: stringOrNull(root.torch_version),
    cpuPercent: numberOrNull(cpu.percent),
    ramUsed: numberOrNull(ram.used), ramTotal: numberOrNull(ram.total),
    gpuName: stringOrNull(gpu.name), gpuUtilization: numberOrNull(gpu.utilization),
    gpuTemperature: numberOrNull(gpu.temperature), gpuFanPercent: numberOrNull(gpu.fan_percent),
    gpuPowerWatts: numberOrNull(gpu.power_watts), gpuPowerLimitWatts: numberOrNull(gpu.power_limit_watts),
    gpuVramUsed: numberOrNull(gpu.vram_used), gpuVramTotal: numberOrNull(gpu.vram_total),
  }
}
