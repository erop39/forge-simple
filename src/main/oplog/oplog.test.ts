import { openDb, type Db } from '../storage/db'
import { createOplog, type Oplog } from './oplog'

let db: Db
let log: Oplog
let clock: number

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1000
  log = createOplog(db, () => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (db.open) db.close()
})

const at = (time: number, e: Parameters<Oplog['write']>[0]) => {
  clock = time
  log.write(e)
}

test('write then list returns newest first with parsed details', () => {
  at(100, { level: 'info', category: 'app', messageKey: 'log.app.started' })
  at(200, { level: 'warn', category: 'queue', messageKey: 'log.queue.slow', durationMs: 42, jobId: 7, details: { a: 1 } })
  const rows = log.list()
  expect(rows.map((r) => r.messageKey)).toEqual(['log.queue.slow', 'log.app.started'])
  expect(rows[0]).toMatchObject({ time: 200, level: 'warn', category: 'queue', durationMs: 42, jobId: 7, details: { a: 1 } })
  expect(rows[1]).toMatchObject({ durationMs: null, jobId: null, details: {} })
})

test('ties on time are ordered by id descending', () => {
  at(100, { level: 'info', category: 'app', messageKey: 'first' })
  at(100, { level: 'info', category: 'app', messageKey: 'second' })
  expect(log.list().map((r) => r.messageKey)).toEqual(['second', 'first'])
})

test('filters by level, category and time range', () => {
  at(100, { level: 'info', category: 'app', messageKey: 'a' })
  at(200, { level: 'error', category: 'queue', messageKey: 'b' })
  at(300, { level: 'error', category: 'app', messageKey: 'c' })
  at(400, { level: 'info', category: 'app', messageKey: 'd' })
  expect(log.list({ level: 'error' }).map((r) => r.messageKey)).toEqual(['c', 'b'])
  expect(log.list({ category: 'app' }).map((r) => r.messageKey)).toEqual(['d', 'c', 'a'])
  expect(log.list({ from: 200, to: 300 }).map((r) => r.messageKey)).toEqual(['c', 'b'])
  expect(log.list({ level: 'error', category: 'app', from: 200 }).map((r) => r.messageKey)).toEqual(['c'])
})

test('text filter matches messageKey and details', () => {
  at(1, { level: 'info', category: 'checkpoint', messageKey: 'log.checkpoint.loaded', details: { checkpoint: 'Krea-dev.safetensors' } })
  at(2, { level: 'info', category: 'app', messageKey: 'log.app.started' })
  expect(log.list({ text: 'krea' }).map((r) => r.messageKey)).toEqual(['log.checkpoint.loaded'])
  expect(log.list({ text: 'APP.STARTED' }).map((r) => r.messageKey)).toEqual(['log.app.started'])
})

test('text filter treats LIKE wildcards literally', () => {
  at(1, { level: 'info', category: 'app', messageKey: 'k1', details: { v: '1000' } })
  at(2, { level: 'info', category: 'app', messageKey: 'k2', details: { v: '100%' } })
  at(3, { level: 'info', category: 'app', messageKey: 'k3', details: { v: 'a_b' } })
  at(4, { level: 'info', category: 'app', messageKey: 'k4', details: { v: 'axb' } })
  expect(log.list({ text: '100%' }).map((r) => r.messageKey)).toEqual(['k2'])
  expect(log.list({ text: 'a_b' }).map((r) => r.messageKey)).toEqual(['k3'])
  at(5, { level: 'info', category: 'app', messageKey: 'k5', details: { v: 'wow!' } })
  expect(log.list({ text: 'w!' }).map((r) => r.messageKey)).toEqual(['k5'])
})

test('list defaults to 500 entries', () => {
  for (let i = 0; i < 510; i++) at(i, { level: 'info', category: 'app', messageKey: 'm' })
  expect(log.list()).toHaveLength(500)
})

test('explicit limit is clamped to 1..5000', () => {
  for (let i = 0; i < 5; i++) at(i, { level: 'info', category: 'app', messageKey: 'm' })
  expect(log.list({ limit: 2 })).toHaveLength(2)
  expect(log.list({ limit: 0 })).toHaveLength(1)
  expect(log.list({ limit: -3 })).toHaveLength(1)
  expect(log.list({ limit: 999_999 })).toHaveLength(5)
})

test('purgeOlderThan(90) deletes only older rows and returns the count', () => {
  const day = 86_400_000
  const nowMs = 200 * day
  at(nowMs - 91 * day, { level: 'info', category: 'app', messageKey: 'old1' })
  at(nowMs - 100 * day, { level: 'info', category: 'app', messageKey: 'old2' })
  at(nowMs - 90 * day, { level: 'info', category: 'app', messageKey: 'edge' })
  at(nowMs - 1 * day, { level: 'info', category: 'app', messageKey: 'fresh' })
  clock = nowMs
  expect(log.purgeOlderThan(90)).toBe(2)
  expect(log.list().map((r) => r.messageKey)).toEqual(['fresh', 'edge'])
})

test('write never throws when the database is closed', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  db.close()
  expect(() => log.write({ level: 'info', category: 'app', messageKey: 'log.app.started' })).not.toThrow()
  expect(spy).toHaveBeenCalled()
})

test('strips prompt keys from details', () => {
  log.write({ level: 'info', category: 'generation', messageKey: 'k', details: { prompt: 'x', negativePrompt: 'y', steps: 20 } })
  expect(log.list()[0]!.details).toEqual({ steps: 20 })
})

test('strips prompt keys at any depth, including inside arrays', () => {
  log.write({
    level: 'info', category: 'generation', messageKey: 'k',
    details: { job: { params: { prompt: 'x', seed: 1 } }, items: [{ negativePrompt: 'y', n: 2 }, [{ prompt: 'z' }]] },
  })
  expect(log.list()[0]!.details).toEqual({ job: { params: { seed: 1 } }, items: [{ n: 2 }, [{}]] })
})

test('does not mutate the details object passed by the caller', () => {
  const details = { prompt: 'x', nested: { negativePrompt: 'y', keep: 1 } }
  log.write({ level: 'info', category: 'generation', messageKey: 'k', details })
  expect(details).toEqual({ prompt: 'x', nested: { negativePrompt: 'y', keep: 1 } })
})

test('stores {} and reports through console.error when details cannot be serialised', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => log.write({ level: 'info', category: 'app', messageKey: 'circ', details: circular })).not.toThrow()
  expect(() => log.write({ level: 'info', category: 'app', messageKey: 'big', details: { n: 10n } })).not.toThrow()
  expect(spy).toHaveBeenCalledTimes(2)
  expect(log.list().map((r) => [r.messageKey, r.details])).toEqual([['big', {}], ['circ', {}]])
})
