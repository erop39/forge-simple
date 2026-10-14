import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { en } from '../locales/en'

const mainDir = join(import.meta.dirname, '..', '..', 'main')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** Every `'log.x.y'` literal in the main process: the message keys it can write to the operation log. */
function writtenKeys(): string[] {
  const keys = new Set<string>()
  for (const file of sources(mainDir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'(log\.[A-Za-z]+\.[A-Za-z.]+)'/g)) keys.add(match[1]!)
  }
  return [...keys].sort()
}

test('the scan finds the keys main writes', () => {
  expect(writtenKeys()).toEqual(expect.arrayContaining(['log.app.started', 'log.recovery.unloaded', 'log.server.restartRequested']))
})

test('every log message key main can write has a catalog string', () => {
  const missing = writtenKeys().filter((key) => !Object.hasOwn(en, key))
  expect(missing).toEqual([])
})
