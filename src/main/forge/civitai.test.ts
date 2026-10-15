import { CivitaiBusyError, createCivitaiClient, isCivitaiImage, parseVersion } from './civitai'
import { createCivitaiUpdater, type UpdaterItem } from './civitai-updater'

const HASH = 'a'.repeat(64)
const version = {
  id: 11, modelId: 5, name: 'v2', baseModel: 'Illustrious', trainedWords: [' sharp ', '', 'skin'],
  model: { name: 'Detail Tweaker', type: 'LORA' },
  images: [
    { url: 'https://evil.example/x.png', type: 'image' },
    { url: 'https://image.civitai.com/a/b.jpeg', type: 'image' },
  ],
}

test('a version is reduced to the kept fields; only civitai https images count', () => {
  expect(parseVersion(version, 99)).toEqual({
    modelId: 5, versionId: 11, name: 'Detail Tweaker', versionName: 'v2', baseModel: 'Illustrious',
    trainedWords: ['sharp', 'skin'], imageUrl: 'https://image.civitai.com/a/b.jpeg', checkedAt: 99,
  })
  expect(parseVersion({ id: 1 }, 1)).toBeNull()
  expect(parseVersion('x', 1)).toBeNull()
  expect(isCivitaiImage('http://image.civitai.com/a.png')).toBe(false)
  expect(isCivitaiImage('https://civitai.com.evil.example/a.png')).toBe(false)
})

test('lookup sends the hash only, maps 404 to null and busy answers to CivitaiBusyError', async () => {
  const urls: string[] = []
  const answers = [
    new Response(JSON.stringify(version), { status: 200 }),
    new Response('', { status: 404 }),
    new Response('', { status: 429, headers: { 'retry-after': '7' } }),
  ]
  const client = createCivitaiClient({ now: () => 1, fetch: (async (url: string) => { urls.push(url); return answers.shift()! }) as never })
  expect((await client.lookup(HASH))?.name).toBe('Detail Tweaker')
  expect(await client.lookup(HASH)).toBeNull()
  await expect(client.lookup(HASH)).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 })
  expect(await client.lookup('not a hash')).toBeNull()
  expect(urls[0]).toBe(`https://civitai.com/api/v1/model-versions/by-hash/${HASH}`)
  expect(urls).toHaveLength(3)
})

function setup(items: UpdaterItem[], lookup: (hash: string) => Promise<unknown>) {
  const saved: [string, unknown][] = []
  const events: { done: number; total: number; found: number; running: boolean; paused: boolean }[] = []
  const slept: number[] = []
  const updater = createCivitaiUpdater({
    client: { lookup: lookup as never }, items: () => items, now: () => 1_000_000_000,
    save: (item, info) => { saved.push([item.id, info]) }, emit: (p) => events.push(p),
    sleep: async (ms) => { slept.push(ms) }, gapMs: 5, freshMs: 1000,
  })
  return { updater, saved, events, slept }
}

test('a run looks every stale file up once, counts the found ones and reports progress', async () => {
  const items: UpdaterItem[] = [
    { kind: 'lora', id: 'a', hash: 'h1', checkedAt: null },
    { kind: 'checkpoint', id: 'b', hash: 'h2', checkedAt: null },
    { kind: 'lora', id: 'fresh', hash: 'h3', checkedAt: 1_000_000_000 - 10 },
  ]
  const { updater, saved, events } = setup(items, async (hash) => (hash === 'h1' ? { name: 'x' } : null))
  await updater.start()
  expect(saved.map(([id]) => id)).toEqual(['a', 'b'])
  expect(updater.state()).toMatchObject({ running: false, done: 2, total: 2, found: 1 })
  expect(events[0]).toMatchObject({ running: true, total: 2 })
  await updater.start({ force: true })
  expect(saved).toHaveLength(5)
})

test('a busy answer pauses and retries; a failing file is skipped; cancel stops between requests', async () => {
  let calls = 0
  const { updater, saved, slept } = setup(
    [{ kind: 'lora', id: 'a', hash: 'h1', checkedAt: null }, { kind: 'lora', id: 'b', hash: 'h2', checkedAt: null }],
    async (hash) => {
      calls++
      if (hash === 'h1' && calls === 1) throw new CivitaiBusyError(429, 5000)
      if (hash === 'h2') throw new Error('network')
      return { name: 'ok' }
    },
  )
  await updater.start()
  expect(slept).toContain(5000)
  expect(saved.map(([id]) => id)).toEqual(['a'])
  expect(updater.state().done).toBe(2)

  const cancelling = setup(
    [{ kind: 'lora', id: 'a', hash: 'h1', checkedAt: null }, { kind: 'lora', id: 'b', hash: 'h2', checkedAt: null }],
    async () => ({ name: 'ok' }),
  )
  const run = cancelling.updater.start()
  cancelling.updater.cancel()
  await run
  expect(cancelling.saved.length).toBeLessThan(2)
  expect(cancelling.updater.state().running).toBe(false)
})
