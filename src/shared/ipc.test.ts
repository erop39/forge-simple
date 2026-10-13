import { eventChannel, extractErrorKey, isEventName } from './ipc'

describe('extractErrorKey', () => {
  test('reads the key out of a wrapped Electron message', () => {
    expect(extractErrorKey("Error invoking remote method 'jobs:enqueue': IpcError: error.invalidParams")).toBe('error.invalidParams')
  })
  test('accepts a bare key', () => {
    expect(extractErrorKey('error.noServer')).toBe('error.noServer')
  })
  test('unknown key and empty string become error.unexpected', () => {
    expect(extractErrorKey('IpcError: error.bogus')).toBe('error.unexpected')
    expect(extractErrorKey('')).toBe('error.unexpected')
    expect(extractErrorKey('something broke')).toBe('error.unexpected')
  })
  test('with two keys the last one wins', () => {
    expect(extractErrorKey('error.network then error.notFound')).toBe('error.notFound')
  })
})

test('event helpers', () => {
  expect(isEventName('job:update')).toBe(true)
  expect(isEventName('nope')).toBe(false)
  expect(eventChannel('connection')).toBe('event:connection')
})
