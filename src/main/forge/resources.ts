import type { ForgeStats, MemoryMetrics, ResourceSample, ResourceSnapshot } from '@shared/types'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Forge may omit whole sections when CUDA is unavailable. Missing readings are unknown, not zero. */
export function parseMemory(value: unknown): MemoryMetrics {
  const root = object(value)
  const ram = object(root.ram)
  const cuda = object(root.cuda)
  const system = object(cuda.system)
  const allocated = object(cuda.allocated)
  const reserved = object(cuda.reserved)
  const events = object(cuda.events)
  const oom = bytes(events.oom)
  return {
    ramUsed: bytes(ram.used), ramTotal: bytes(ram.total),
    vramUsed: bytes(system.used), vramTotal: bytes(system.total),
    allocated: bytes(allocated.current), reserved: bytes(reserved.current),
    vramPeak: bytes(allocated.peak), oom: oom !== null && Number.isInteger(oom) ? oom : null,
  }
}

export const IDLE_RESOURCE_INTERVAL_MS = 2000
export const RUNNING_RESOURCE_INTERVAL_MS = 1000
export const RESOURCE_HISTORY_LIMIT = 60

/** Read-only samples; no polling error can affect a generation request or connection status. */
export function createResourceMonitor(deps: {
  read(): Promise<MemoryMetrics>
  readStats?(): Promise<ForgeStats | null>
  now(): number
  runningJob(): number | null
  emit?(snapshot: ResourceSnapshot): void
}) {
  let server: string | null = null
  let active = false
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let samples: ResourceSample[] = []
  let failed = false
  let extension: ResourceSnapshot['extension'] = 'unknown'
  let probed = false
  const peaks = new Map<number, number>()

  function clearTimer(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const current = (): ResourceSnapshot => ({ samples: [...samples], failed, extension })
  const emit = (): void => { try { deps.emit?.(current()) } catch { /* a renderer listener cannot stop polling */ } }

  function schedule(): void {
    clearTimer()
    if (!active) return
    const interval = deps.runningJob() === null ? IDLE_RESOURCE_INTERVAL_MS : RUNNING_RESOURCE_INTERVAL_MS
    timer = setTimeout(() => { void sample() }, interval)
  }

  async function sample(): Promise<void> {
    if (inFlight) return
    inFlight = true
    const mine = epoch
    const jobId = deps.runningJob()
    try {
      const memory = await deps.read()
      let stats: ForgeStats | null = null
      if (extension === 'available' && deps.readStats) {
        try { stats = await deps.readStats() } catch { /* memory remains available */ }
      }
      if (!active || mine !== epoch) return
      samples.push({ time: deps.now(), memory, stats })
      if (samples.length > RESOURCE_HISTORY_LIMIT) samples.shift()
      failed = false
      if (jobId !== null && deps.runningJob() === jobId && memory.vramUsed !== null) {
        peaks.set(jobId, Math.max(peaks.get(jobId) ?? 0, memory.vramUsed))
      }
    } catch {
      if (!active || mine !== epoch) return
      failed = true
    } finally {
      if (active && mine === epoch) emit()
      inFlight = false
      if (active && mine === epoch) schedule()
      else if (active) void sample()
    }
  }

  return {
    start(key: string) {
      if (server !== key) {
        epoch++
        server = key
        samples = []
        peaks.clear()
        failed = false
        extension = 'unknown'
        probed = false
        clearTimer()
        emit()
        active = true
        void sample()
      } else if (!active) {
        epoch++
        active = true
        void sample()
      }
    },
    stop() { epoch++; active = false; clearTimer() },
    jobChanged() { if (active && !inFlight) schedule() },
    onConnection(healthy: boolean) {
      if (!healthy) { probed = false; return }
      if (!active || probed || !deps.readStats) return
      probed = true
      const mine = epoch
      void deps.readStats().then(
        (stats) => {
          if (!active || mine !== epoch) return
          extension = stats ? 'available' : 'absent'
          emit()
        },
        () => { if (active && mine === epoch) { extension = 'unknown'; emit() } },
      )
    },
    takePeak(jobId: number): number | null {
      const value = peaks.get(jobId) ?? null
      peaks.delete(jobId)
      return value
    },
    current,
  }
}
