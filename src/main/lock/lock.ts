import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { LockState } from '@shared/types'
import type { Oplog } from '../oplog/oplog'

/** Settings key of the password hash; deleting it resets a forgotten password (hidden images stay hidden). */
export const HASH_KEY = 'lock.hash'
export const MIN_PASSWORD = 4
export const MAX_PASSWORD = 1024

const N = 16384
const R = 8
const P = 1
const SALT_BYTES = 16
const KEY_BYTES = 32
const HEX = /^[0-9a-f]+$/
/** Wrong passwords in a row that start a lockout, and how long it lasts. */
export const MAX_FAILURES = 5
export const LOCKOUT_MS = 30_000

/** A refused lock call; the message is the IPC error key. */
export class LockError extends Error {
  constructor(readonly key: 'error.wrongPassword' | 'error.tooManyAttempts' | 'error.invalidParams') {
    super(key)
    this.name = 'LockError'
  }
}

export interface Lock {
  state(): LockState
  /** Without a stored password `oldPassword` is ignored; with one it must match. */
  setPassword(oldPassword: string | null, newPassword: string): Promise<void>
  open(password: string): Promise<void>
  close(): void
  isOpen(): boolean
}

const derive = (password: string, salt: Buffer, n: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes.
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, { N: n, r: R, p: P, maxmem: 256 * n * R }, (err, key) =>
      err ? reject(err) : resolve(key))
  })

async function hash(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, N)
  return `scrypt$${N}$${salt.toString('hex')}$${key.toString('hex')}`
}

/** False for a wrong password and for a stored value that is not a hash this module wrote. */
async function verify(password: string, stored: string): Promise<boolean> {
  const [scheme, nText, saltHex, keyHex, ...rest] = stored.split('$')
  if (scheme !== 'scrypt' || rest.length > 0 || nText !== String(N)) return false
  if (!saltHex || !keyHex || !HEX.test(saltHex) || !HEX.test(keyHex)) return false
  if (saltHex.length !== SALT_BYTES * 2 || keyHex.length !== KEY_BYTES * 2) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await derive(password, Buffer.from(saltHex, 'hex'), N)
  return timingSafeEqual(actual, expected)
}

/**
 * The session lock over hidden images. Only the scrypt hash is stored (in settings); the open state lives in
 * memory, so every start begins closed. Passwords never reach the log.
 */
export function createLock(
  settings: { get(k: string): string | null; set(k: string, v: string): void },
  oplog: Oplog,
  now: () => number = () => Date.now(),
): Lock {
  let open = false
  // Bumped by every close(): an open() whose check started before it must not open the lock afterwards.
  let epoch = 0
  let failures = 0
  let blockedUntil = 0
  const stored = (): string | null => settings.get(HASH_KEY)
  const isPassword = (v: unknown): v is string =>
    typeof v === 'string' && v.length >= MIN_PASSWORD && v.length <= MAX_PASSWORD

  async function matches(password: unknown, current: string | null): Promise<boolean> {
    if (current === null || typeof password !== 'string' || password.length > MAX_PASSWORD) return false
    try {
      return await verify(password, current)
    } catch {
      return false
    }
  }

  /** During a lockout every check is refused at once, the right password too. */
  const throttle = (): void => {
    if (now() < blockedUntil) throw new LockError('error.tooManyAttempts')
  }

  /**
   * A wrong password. Each is logged until the MAX_FAILURES-th in a row, which starts a lockout of LOCKOUT_MS
   * logged once; attempts during the lockout are not logged.
   */
  const refuse = (): never => {
    failures++
    if (failures >= MAX_FAILURES) {
      failures = 0
      blockedUntil = now() + LOCKOUT_MS
      oplog.write({
        level: 'warn', category: 'lock', messageKey: 'log.lock.lockedOut', details: { seconds: LOCKOUT_MS / 1000 },
      })
      throw new LockError('error.tooManyAttempts')
    }
    oplog.write({ level: 'warn', category: 'lock', messageKey: 'log.lock.wrongPassword' })
    throw new LockError('error.wrongPassword')
  }

  return {
    state: () => ({ hasPassword: stored() !== null, open }),

    async setPassword(oldPassword, newPassword) {
      if (!isPassword(newPassword)) throw new LockError('error.invalidParams')
      const before = stored()
      if (before !== null) {
        throttle()
        if (!(await matches(oldPassword, before))) refuse()
        failures = 0
      }
      const next = await hash(newPassword)
      // Another call set or changed the password while this one was hashing: its check no longer holds.
      if (stored() !== before) throw new LockError('error.wrongPassword')
      settings.set(HASH_KEY, next)
      oplog.write({
        level: 'info', category: 'lock', messageKey: before !== null ? 'log.lock.passwordChanged' : 'log.lock.passwordSet',
      })
    },

    async open(password) {
      throttle()
      const startedAt = epoch
      if (!(await matches(password, stored()))) refuse()
      failures = 0
      // Locked again while the password was being checked: that close wins.
      if (startedAt !== epoch) return
      open = true
      oplog.write({ level: 'info', category: 'lock', messageKey: 'log.lock.opened' })
    },

    close() {
      epoch++
      if (!open) return
      open = false
      oplog.write({ level: 'info', category: 'lock', messageKey: 'log.lock.closed' })
    },

    isOpen: () => open,
  }
}
