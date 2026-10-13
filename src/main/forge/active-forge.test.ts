import { createOplog } from '../oplog/oplog'
import { openDb, type Db } from '../storage/db'
import { ForgeError, type ForgeClient } from './client'
import { createActiveForge } from './active-forge'

let db: Db
afterEach(() => db?.close())

function setup() {
  db = openDb(':memory:')
  let url: string | null = null
  const created: string[] = []
  const forge = createActiveForge({
    activeUrl: () => url, familyOverride: () => null, oplog: createOplog(db, () => 0), now: () => 0,
    create: (u) => { created.push(u); return { ping: () => Promise.resolve(1) } as unknown as ForgeClient },
  })
  return { forge, created, setUrl: (u: string | null) => { url = u } }
}

test('with no server, client() throws a network ForgeError', () => {
  const { forge } = setup()
  expect(() => forge.client()).toThrow(ForgeError)
  try {
    forge.client()
  } catch (e) {
    expect((e as ForgeError).kind).toBe('network')
  }
})

test('client and catalog are reused for one URL and rebuilt when the URL changes', () => {
  const { forge, created, setUrl } = setup()
  setUrl('http://a.test')
  const c1 = forge.client()
  const cat1 = forge.catalog()
  expect(forge.client()).toBe(c1)
  expect(forge.catalog()).toBe(cat1)
  setUrl('http://b.test')
  expect(forge.client()).not.toBe(c1)
  expect(forge.catalog()).not.toBe(cat1)
  expect(created).toEqual(['http://a.test', 'http://b.test'])
})
