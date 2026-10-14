import type { OplogEntry } from '@shared/types'
import { logText } from './log-text'

const entry = (messageKey: string, details: Record<string, unknown> = {}): OplogEntry => ({
  id: 1, time: 0, level: 'info', category: 'app', messageKey, durationMs: null, jobId: null, details,
})

test('fills the catalog text from the details', () => {
  expect(logText(entry('log.app.started', { version: '0.1.0', platform: 'win32' }))).toBe('App started (version 0.1.0).')
  expect(logText(entry('log.queue.recovered', { count: 2 }))).toBe('2 jobs that were running when the app closed are marked interrupted.')
})

test('lists become comma-separated, missing or null values a dash', () => {
  expect(logText(entry('log.error.missingParts', { missing: ['a.safetensors', 'b.safetensors'] })))
    .toBe('A job needs files the server does not have: a.safetensors, b.safetensors.')
  expect(logText(entry('log.settings.serverChanged', { new: null }))).toBe('Active server is now —.')
  expect(logText(entry('log.server.removed'))).toBe('Server — removed.')
})

test('an unknown key is shown as it is', () => {
  expect(logText(entry('log.future.thing'))).toBe('log.future.thing')
})
