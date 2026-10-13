import { openDb, type Db } from '../storage/db'
import { createOplog } from '../oplog/oplog'
import { createConnectionMonitor, initialConnection, nextConnection, type ConnectionTracker } from './connection'

const ok = (t: number, latencyMs: number) => ({ ok: true, latencyMs, t })
const fail = (t: number) => ({ ok: false, t })

function run(samples: Parameters<typeof nextConnection>[1][], from: ConnectionTracker = initialConnection) {
  return samples.reduce(nextConnection, from)
}

test('ok sample → connected with latency, attempts reset to 0', () => {
  const failing = run([fail(0), fail(2000)])
  expect(failing.attempts).toBe(2)
  const s = nextConnection(failing, ok(4000, 120))
  expect(s).toMatchObject({ state: 'connected', latencyMs: 120, attempts: 0, lastOkAt: 4000, firstFailureAt: null })
})

test('three consecutive samples above 800 ms → slow; the third is the first slow one', () => {
  const a = nextConnection(initialConnection, ok(0, 900))
  const b = nextConnection(a, ok(2000, 900))
  const c = nextConnection(b, ok(4000, 900))
  expect([a.state, b.state, c.state]).toEqual(['connected', 'connected', 'slow'])
  expect(nextConnection(c, ok(6000, 900)).state).toBe('slow')
})

test('a fast sample clears the slow streak', () => {
  const s = run([ok(0, 900), ok(1, 900), ok(2, 100), ok(3, 900), ok(4, 900)])
  expect(s.state).toBe('connected')
  expect(s.slowStreak).toBe(2)
  expect(nextConnection(s, ok(5, 900)).state).toBe('slow')
})

test('exactly 800 ms is not slow', () => {
  expect(run([ok(0, 800), ok(1, 800), ok(2, 800)]).state).toBe('connected')
})

test('failed sample → reconnecting, attempts increments', () => {
  const healthy = nextConnection(initialConnection, ok(1000, 50))
  const a = nextConnection(healthy, fail(3000))
  const b = nextConnection(a, fail(5000))
  expect(a).toMatchObject({ state: 'reconnecting', attempts: 1, latencyMs: null, lastOkAt: 1000, slowStreak: 0 })
  expect(b).toMatchObject({ state: 'reconnecting', attempts: 2 })
})

test('failure 15000 ms after lastOkAt → offline', () => {
  const healthy = nextConnection(initialConnection, ok(1000, 50))
  expect(nextConnection(healthy, fail(15_999)).state).toBe('reconnecting')
  expect(nextConnection(healthy, fail(16_000)).state).toBe('offline')
})

test('failure with lastOkAt null → reconnecting until 15000 ms after the first sample, then offline', () => {
  const a = nextConnection(initialConnection, fail(5000))
  expect(a).toMatchObject({ state: 'reconnecting', lastOkAt: null, firstFailureAt: 5000 })
  const b = nextConnection(a, fail(19_999))
  expect(b.state).toBe('reconnecting')
  expect(b.firstFailureAt).toBe(5000)
  expect(nextConnection(b, fail(20_000)).state).toBe('offline')
})

test('recovery from offline returns to connected', () => {
  const off = run([ok(0, 10), fail(15_000)])
  expect(off.state).toBe('offline')
  expect(nextConnection(off, ok(17_000, 10)).state).toBe('connected')
})

describe('monitor', () => {
  let db: Db
  afterEach(() => { if (db?.open) db.close() })

  function setup(results: (number | Error)[]) {
    db = openDb(':memory:')
    const oplog = createOplog(db, () => 1)
    const emitted: unknown[] = []
    let clock = 0
    const queue = [...results]
    const monitor = createConnectionMonitor({
      ping: async () => {
        const r = queue.shift()
        if (r instanceof Error || r === undefined) throw r ?? new Error('no result')
        return r
      },
      emit: (s) => emitted.push(s),
      now: () => clock,
      oplog,
    })
    return { monitor, oplog, emitted, at: (t: number) => { clock = t } }
  }

  test('monitor logs loss and recovery once each, with downtime in details', async () => {
    const boom = new Error('down')
    const { monitor, oplog, emitted, at } = setup([40, boom, boom, boom, 60, 50])
    at(0); await monitor.sampleOnce()
    at(2000); await monitor.sampleOnce()
    at(4000); await monitor.sampleOnce()
    at(6000); await monitor.sampleOnce()
    expect(oplog.list({ category: 'connection' })).toHaveLength(1)
    at(9000); const back = await monitor.sampleOnce()
    at(11_000); await monitor.sampleOnce()

    expect(back.state).toBe('connected')
    expect(emitted).toHaveLength(6)
    expect(emitted[0]).toEqual({ state: 'connected', latencyMs: 40, attempts: 0, lastOkAt: 0 })
    const entries = oplog.list({ category: 'connection' }).reverse()
    expect(entries.map((e) => e.messageKey)).toEqual(['log.connection.lost', 'log.connection.restored'])
    expect(entries[1]!.details).toEqual({ downtimeMs: 7000 })
    expect(monitor.current().state).toBe('connected')
  })

  test('starting offline and never healthy logs nothing', async () => {
    const boom = new Error('down')
    const { monitor, oplog, at } = setup([boom, 10])
    at(0); await monitor.sampleOnce()
    at(2000); await monitor.sampleOnce()
    expect(oplog.list({ category: 'connection' })).toHaveLength(0)
  })

  test('start samples on an interval without overlapping; stop clears it; second start is a no-op', async () => {
    vi.useFakeTimers()
    try {
      db = openDb(':memory:')
      let calls = 0
      let release: (n: number) => void = () => undefined
      const monitor = createConnectionMonitor({
        ping: () => { calls++; return new Promise<number>((r) => { release = r }) },
        emit: () => undefined, now: () => 0, oplog: createOplog(db, () => 1),
      })
      monitor.start(100)
      monitor.start(100)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(350) // ticks fire while the first ping is still pending
      expect(calls).toBe(1)
      release(5)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(calls).toBe(2)
      release(5)
      monitor.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
