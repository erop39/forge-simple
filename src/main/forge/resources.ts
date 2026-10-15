export interface MemoryMetrics {
  ramUsed: number | null
  ramTotal: number | null
  vramUsed: number | null
  vramTotal: number | null
  allocated: number | null
  reserved: number | null
  vramPeak: number | null
  oom: number | null
}

export interface ResourceSample { time: number; memory: MemoryMetrics }

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
  now(): number
  runningJob(): number | null
}) {
  let server: string | null = null
  let active = false
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let samples: ResourceSample[] = []
  let failed = false
  const peaks = new Map<number, number>()

  function clearTimer(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

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
      if (!active || mine !== epoch) return
      samples.push({ time: deps.now(), memory })
      if (samples.length > RESOURCE_HISTORY_LIMIT) samples.shift()
      failed = false
      if (jobId !== null && deps.runningJob() === jobId && memory.vramUsed !== null) {
        peaks.set(jobId, Math.max(peaks.get(jobId) ?? 0, memory.vramUsed))
      }
    } catch {
      if (!active || mine !== epoch) return
      failed = true
    } finally {
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
        clearTimer()
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
    takePeak(jobId: number): number | null {
      const value = peaks.get(jobId) ?? null
      peaks.delete(jobId)
      return value
    },
    current: () => ({ samples: [...samples], failed }),
  }
}
