import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLiterals } from './find-literals'

const rendererDir = join(import.meta.dirname, '..')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : []
  })
}

test('renderer components contain no user-visible string literals', () => {
  const offenders = tsxFiles(rendererDir).flatMap((file) =>
    findLiterals(readFileSync(file, 'utf8')).map((literal) => `${file}: ${literal}`),
  )
  expect(offenders).toEqual([])
})
