import Database from 'better-sqlite3'

test('better-sqlite3 loads under the Electron ABI', () => {
  const db = new Database(':memory:')
  expect(db.prepare('select 1 as n').get()).toEqual({ n: 1 })
})
