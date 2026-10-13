import type { ConnectionStatus } from '@shared/types'
import type { Oplog } from '../oplog/oplog'

export const SLOW_LATENCY_MS = 800
export const SLOW_SAMPLES = 3
export const OFFLINE_AFTER_MS = 15_000
export const DEFAULT_INTERVAL_MS = 2000

/** The public status plus the counters the state machine needs between samples. */
export type ConnectionTracker = ConnectionStatus & { slowStreak: number; firstFailureAt: number | null }

export const initialConnection: ConnectionTracker = {
  state: 'reconnecting', latencyMs: null, attempts: 0, lastOkAt: null, slowStreak: 0, firstFailureAt: null,
}

export function nextConnection(
  prev: ConnectionTracker,
  sample: { ok: boolean; latencyMs?: number; t: number },
): ConnectionTracker {
  if (sample.ok) {
    const latencyMs = sample.latencyMs ?? 0
    const slowStreak = latencyMs > SLOW_LATENCY_MS ? prev.slowStreak + 1 : 0
    return {
      state: slowStreak >= SLOW_SAMPLES ? 'slow' : 'connected',
      latencyMs, attempts: 0, lastOkAt: sample.t, slowStreak, firstFailureAt: null,
    }
  }
  const firstFailureAt = prev.firstFailureAt ?? sample.t
  const since = prev.lastOkAt ?? firstFailureAt
  return {
    state: sample.t - since >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting',
    latencyMs: null, attempts: prev.attempts + 1, lastOkAt: prev.lastOkAt, slowStreak: 0, firstFailureAt,
  }
}

const isHealthy = (s: ConnectionStatus) => s.state === 'connected' || s.state === 'slow'

function publicStatus(t: ConnectionTracker): ConnectionStatus {
  return { state: t.state, latencyMs: t.latencyMs, attempts: t.attempts, lastOkAt: t.lastOkAt }
}

export function createConnectionMonitor(deps: {
  ping(): Promise<number>
  emit(s: ConnectionStatus): void
  now(): number
  oplog: Oplog
}): {
  sampleOnce(): Promise<ConnectionStatus>
  start(intervalMs?: number): void
  stop(): void
  current(): ConnectionStatus
} {
  let tracker = initialConnection
  let lostAt: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<ConnectionStatus> | null = null

  async function sample(): Promise<ConnectionStatus> {
    let latency: number | null = null
    try {
      latency = await deps.ping()
    } catch {
      latency = null
    }
    const t = deps.now()
    const prev = tracker
    tracker = nextConnection(prev, latency === null ? { ok: false, t } : { ok: true, latencyMs: latency, t })

    if (isHealthy(prev) && !isHealthy(tracker)) {
      lostAt = t
      deps.oplog.write({ level: 'warn', category: 'connection', messageKey: 'log.connection.lost', details: { state: tracker.state } })
    } else if (!isHealthy(prev) && isHealthy(tracker) && lostAt !== null) {
      deps.oplog.write({
        level: 'info', category: 'connection', messageKey: 'log.connection.restored',
        details: { downtimeMs: t - lostAt },
      })
      lostAt = null
    }

    const status = publicStatus(tracker)
    try {
      deps.emit(status)
    } catch (err) {
      console.error('connection: emit failed', err)
    }
    return status
  }

  // Samples never overlap: a call made while one is running joins it.
  function sampleOnce(): Promise<ConnectionStatus> {
    if (inFlight) return inFlight
    const p = sample().finally(() => { inFlight = null })
    inFlight = p
    return p
  }

  return {
    sampleOnce,
    start(intervalMs = DEFAULT_INTERVAL_MS) {
      if (timer) return
      timer = setInterval(() => { void sampleOnce() }, intervalMs)
      void sampleOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    current: () => publicStatus(tracker),
  }
}
