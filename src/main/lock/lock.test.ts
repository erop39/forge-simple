import * as crypto from 'node:crypto'
import { createOplog } from '../oplog/oplog'
import { openDb } from '../storage/db'
import { createRepos } from '../storage/repos'
import { createLock, HASH_KEY, LOCKOUT_MS, MAX_FAILURES } from './lock'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const setup = () => {
  const db = openDb(':memory:')
  const repos = createRepos(db, () => 1)
  const oplog = createOplog(db, () => 1)
  return { repos, oplog, lock: createLock(repos.settings, oplog) }
}

test('a new lock has no password and is closed', () => {
  const { lock } = setup()
  expect(lock.state()).toEqual({ hasPassword: false, open: false })
  expect(lock.isOpen()).toBe(false)
})

test('the password is stored as scrypt$16384$<16-byte salt>$<32-byte key>, never as plain text', async () => {
  const { lock, repos, oplog } = setup()
  await lock.setPassword(null, 'secret-pass')
  const stored = repos.settings.get(HASH_KEY)!
  expect(stored).toMatch(/^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  expect(stored).not.toContain('secret-pass')
  expect(JSON.stringify(oplog.list())).not.toContain('secret-pass')
  expect(lock.state()).toEqual({ hasPassword: true, open: false })
  // Two settings of the same password use different salts.
  const { lock: other, repos: otherRepos } = setup()
  await other.setPassword(null, 'secret-pass')
  expect(otherRepos.settings.get(HASH_KEY)).not.toBe(stored)
})

test('open with the right password opens; close closes; both are logged', async () => {
  const { lock, oplog } = setup()
  await lock.setPassword(null, 'secret-pass')
  await lock.open('secret-pass')
  expect(lock.isOpen()).toBe(true)
  expect(lock.state()).toEqual({ hasPassword: true, open: true })
  expect(vi.mocked(crypto.timingSafeEqual)).toHaveBeenCalled()
  lock.close()
  expect(lock.isOpen()).toBe(false)
  expect(oplog.list({ category: 'lock' }).map((e) => e.messageKey))
    .toEqual(['log.lock.closed', 'log.lock.opened', 'log.lock.passwordSet'])
})

test('a wrong password is refused with error.wrongPassword and logged as a warning without the password', async () => {
  const { lock, oplog } = setup()
  await lock.setPassword(null, 'secret-pass')
  await expect(lock.open('wrong-pass')).rejects.toThrow('error.wrongPassword')
  expect(lock.isOpen()).toBe(false)
  const warn = oplog.list({ category: 'lock', level: 'warn' })
  expect(warn).toHaveLength(1)
  expect(warn[0]).toMatchObject({ messageKey: 'log.lock.wrongPassword', details: {} })
  expect(JSON.stringify(oplog.list())).not.toContain('wrong-pass')
})

test('open without a password set is refused', async () => {
  const { lock } = setup()
  await expect(lock.open('anything')).rejects.toThrow('error.wrongPassword')
  expect(lock.isOpen()).toBe(false)
})

test('changing the password needs the old one', async () => {
  const { lock, oplog } = setup()
  await lock.setPassword(null, 'first-pass')
  await expect(lock.setPassword(null, 'second-pass')).rejects.toThrow('error.wrongPassword')
  await expect(lock.setPassword('nope', 'second-pass')).rejects.toThrow('error.wrongPassword')
  await lock.setPassword('first-pass', 'second-pass')
  await expect(lock.open('first-pass')).rejects.toThrow('error.wrongPassword')
  await lock.open('second-pass')
  expect(lock.isOpen()).toBe(true)
  expect(oplog.list({ category: 'lock' }).map((e) => e.messageKey)).toContain('log.lock.passwordChanged')
})

test('a password shorter than 4 characters is refused with error.invalidParams', async () => {
  const { lock, repos } = setup()
  await expect(lock.setPassword(null, 'abc')).rejects.toThrow('error.invalidParams')
  expect(repos.settings.get(HASH_KEY)).toBeNull()
  await lock.setPassword(null, 'abcd')
  expect(lock.state().hasPassword).toBe(true)
})

test('a new lock over the same settings (a restart) starts closed', async () => {
  const { lock, repos, oplog } = setup()
  await lock.setPassword(null, 'secret-pass')
  await lock.open('secret-pass')
  const again = createLock(repos.settings, oplog)
  expect(again.state()).toEqual({ hasPassword: true, open: false })
  await again.open('secret-pass')
  expect(again.isOpen()).toBe(true)
})

test('a damaged stored hash never opens the lock', async () => {
  const { lock, repos } = setup()
  repos.settings.set(HASH_KEY, 'scrypt$99999999999$zz$zz')
  await expect(lock.open('secret-pass')).rejects.toThrow('error.wrongPassword')
  repos.settings.set(HASH_KEY, 'plain-text')
  await expect(lock.open('plain-text')).rejects.toThrow('error.wrongPassword')
  expect(lock.isOpen()).toBe(false)
})

test('two first-time password sets at once: one wins, the other is refused', async () => {
  const { lock } = setup()
  const results = await Promise.allSettled([lock.setPassword(null, 'first-pass'), lock.setPassword(null, 'other-pass')])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  expect((refused.reason as Error).message).toBe('error.wrongPassword')
  const winner = results[0]!.status === 'fulfilled' ? 'first-pass' : 'other-pass'
  await lock.open(winner)
  expect(lock.isOpen()).toBe(true)
})

test('a close during an open that is still checking the password keeps the lock closed', async () => {
  const { lock, oplog } = setup()
  await lock.setPassword(null, 'secret-pass')
  const opening = lock.open('secret-pass')
  lock.close()
  await opening
  expect(lock.isOpen()).toBe(false)
  expect(oplog.list({ category: 'lock' }).map((e) => e.messageKey)).not.toContain('log.lock.opened')
  // A later open works as usual.
  await lock.open('secret-pass')
  expect(lock.isOpen()).toBe(true)
})

describe('wrong-password throttle', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 }))
  afterEach(() => vi.useRealTimers())

  test('the 5th wrong password in a row pauses attempts for 30 s, logged once', async () => {
    const { lock, oplog } = setup()
    await lock.setPassword(null, 'secret-pass')
    for (let i = 0; i < MAX_FAILURES - 1; i++) await expect(lock.open('bad-guess')).rejects.toThrow('error.wrongPassword')
    await expect(lock.open('bad-guess')).rejects.toThrow('error.tooManyAttempts')
    const warnings = () => oplog.list({ category: 'lock', level: 'warn' }).map((e) => e.messageKey)
    expect(warnings().filter((k) => k === 'log.lock.lockedOut')).toHaveLength(1)
    expect(oplog.list({ category: 'lock', level: 'warn' })[0]!.details).toEqual({ seconds: 30 })
    const logged = warnings().length
    // During the pause even the right password is refused, in open and in setPassword, without new entries.
    await expect(lock.open('secret-pass')).rejects.toThrow('error.tooManyAttempts')
    await expect(lock.setPassword('secret-pass', 'next-pass')).rejects.toThrow('error.tooManyAttempts')
    for (let i = 0; i < 10; i++) await expect(lock.open('bad-guess')).rejects.toThrow('error.tooManyAttempts')
    expect(warnings()).toHaveLength(logged)
    expect(lock.isOpen()).toBe(false)
    vi.setSystemTime(1_000_000 + LOCKOUT_MS - 1)
    await expect(lock.open('secret-pass')).rejects.toThrow('error.tooManyAttempts')
    vi.setSystemTime(1_000_000 + LOCKOUT_MS + 1)
    await lock.open('secret-pass')
    expect(lock.isOpen()).toBe(true)
  })

  test('a right password resets the count', async () => {
    const { lock } = setup()
    await lock.setPassword(null, 'secret-pass')
    for (let i = 0; i < MAX_FAILURES - 1; i++) await expect(lock.open('bad-guess')).rejects.toThrow('error.wrongPassword')
    await lock.open('secret-pass')
    lock.close()
    for (let i = 0; i < MAX_FAILURES - 1; i++) await expect(lock.open('bad-guess')).rejects.toThrow('error.wrongPassword')
  })
})
