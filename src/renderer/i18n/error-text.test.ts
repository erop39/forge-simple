import { IPC_ERROR_KEYS } from '@shared/ipc'
import { en } from '../locales/en'
import { errorKeyOf, errorText } from './error-text'

test.each(IPC_ERROR_KEYS)('%s has catalog text of the same name', (key) => {
  expect(en[key].length).toBeGreaterThan(0)
  expect(errorText(new Error(key))).toBe(en[key])
})

test('maps an Error carrying a key to its catalog text', () => {
  expect(errorText(new Error('error.network'))).toBe("Can't reach the server. Check the address and your VPN.")
})

test('accepts a bare key string, as carried by a connection check', () => {
  expect(errorText('error.notForge')).toBe("That address isn't a Forge API. Check the port.")
})

test('falls back to error.unexpected for unknown messages and non-errors', () => {
  const fallback = en['error.unexpected']
  expect(errorText(new Error('ECONNRESET at 10.0.0.2'))).toBe(fallback)
  expect(errorText(null)).toBe(fallback)
  expect(errorText(42)).toBe(fallback)
})

test('never leaks the raw message of an unknown error', () => {
  expect(errorText(new Error('secret detail'))).not.toContain('secret')
})

test('errorKeyOf returns the key itself', () => {
  expect(errorKeyOf(new Error('error.noServer'))).toBe('error.noServer')
})
