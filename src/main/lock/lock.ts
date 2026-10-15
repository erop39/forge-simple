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

/** A refused lock call; the message is the IPC error key. */
export class LockError extends Error {
  constructor(readonly key: 'error.wrongPassword' | 'error.invalidParams') {
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
): Lock {
  let open = false
  const stored = (): string | null => settings.get(HASH_KEY)
  const isPassword = (v: unknown): v is string =>
    typeof v === 'string' && v.length >= MIN_PASSWORD && v.length <= MAX_PASSWORD

  async function matches(password: unknown): Promise<boolean> {
    const current = stored()
    if (current === null || typeof password !== 'string' || password.length > MAX_PASSWORD) return false
    try {
      return await verify(password, current)
    } catch {
      return false
    }
  }

  const refuse = (): never => {
    oplog.write({ level: 'warn', category: 'lock', messageKey: 'log.lock.wrongPassword' })
    throw new LockError('error.wrongPassword')
  }

  return {
    state: () => ({ hasPassword: stored() !== null, open }),

    async setPassword(oldPassword, newPassword) {
      if (!isPassword(newPassword)) throw new LockError('error.invalidParams')
      const had = stored() !== null
      if (had && !(await matches(oldPassword))) refuse()
      settings.set(HASH_KEY, await hash(newPassword))
      oplog.write({ level: 'info', category: 'lock', messageKey: had ? 'log.lock.passwordChanged' : 'log.lock.passwordSet' })
    },

    async open(password) {
      if (!(await matches(password))) refuse()
      open = true
      oplog.write({ level: 'info', category: 'lock', messageKey: 'log.lock.opened' })
    },

    close() {
      if (!open) return
      open = false
      oplog.write({ level: 'info', category: 'lock', messageKey: 'log.lock.closed' })
    },

    isOpen: () => open,
  }
}
