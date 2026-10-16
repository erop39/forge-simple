import { browseCivitai, fetchThumb, CivitaiBusyError, createCivitaiClient, isCivitaiImage, parseLatest, parseVersion } from './civitai'
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
    trainedWords: ['sharp', 'skin'], imageUrl: 'https://image.civitai.com/a/b.jpeg', checkedAt: 99, publishedAt: null,
  })
  expect(parseVersion({ ...version, publishedAt: '2026-03-04T10:00:00.000Z' }, 1)?.publishedAt).toBe(Date.parse('2026-03-04T10:00:00.000Z'))
  expect(parseVersion({ ...version, publishedAt: 'soon' }, 1)?.publishedAt).toBeNull()
  expect(parseVersion({ id: 1 }, 1)).toBeNull()
  expect(parseVersion('x', 1)).toBeNull()
  expect(isCivitaiImage('http://image.civitai.com/a.png')).toBe(false)
  expect(isCivitaiImage('https://civitai.com.evil.example/a.png')).toBe(false)
})

test('lookup sends the hash only, maps 404 to null and busy answers to CivitaiBusyError', async () => {
  const urls: string[] = []
  const answers = [
    new Response(JSON.stringify(version), { status: 200 }),
    new Response(JSON.stringify({ modelVersions: [{ id: 11, name: 'v2', publishedAt: '2026-01-01T00:00:00Z' }, { id: 15, name: 'v3', publishedAt: '2026-05-01T00:00:00Z' }] }), { status: 200 }),
    new Response('', { status: 404 }),
    new Response('', { status: 429, headers: { 'retry-after': '7' } }),
  ]
  const client = createCivitaiClient({ now: () => 1, fetch: (async (url: string) => { urls.push(url); return answers.shift()! }) as never })
  const found = await client.lookup(HASH)
  expect(found?.name).toBe('Detail Tweaker')
  expect(found?.latest).toEqual({ versionId: 15, name: 'v3', publishedAt: Date.parse('2026-05-01T00:00:00Z') })
  expect(await client.lookup(HASH)).toBeNull()
  await expect(client.lookup(HASH)).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 })
  expect(await client.lookup('not a hash')).toBeNull()
  expect(urls[0]).toBe(`https://civitai.com/api/v1/model-versions/by-hash/${HASH}`)
  expect(urls[1]).toBe('https://civitai.com/api/v1/models/5')
  expect(urls).toHaveLength(4)
})

test('the newest version is chosen by publish date; a model without versions has none', () => {
  expect(parseLatest({ modelVersions: [{ id: 3, name: 'a', publishedAt: '2026-02-01T00:00:00Z' }, { id: 2, name: 'b', publishedAt: '2026-03-01T00:00:00Z' }] })?.versionId).toBe(2)
  expect(parseLatest({ modelVersions: [] })).toBeNull()
  expect(parseLatest({})).toBeNull()
})

test('when the model request fails the version is still returned, without the newest-version field', async () => {
  const answers = [new Response(JSON.stringify(version), { status: 200 }), new Response('', { status: 429 })]
  const client = createCivitaiClient({ now: () => 1, fetch: (async () => answers.shift()!) as never })
  const found = await client.lookup(HASH)
  expect(found?.name).toBe('Detail Tweaker')
  expect(found).not.toHaveProperty('latest')
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
    { serverId: 1, kind: 'lora', id: 'a', hash: 'h1', checkedAt: null },
    { serverId: 1, kind: 'checkpoint', id: 'b', hash: 'h2', checkedAt: null },
    { serverId: 1, kind: 'lora', id: 'fresh', hash: 'h3', checkedAt: 1_000_000_000 - 10 },
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
    [{ serverId: 1, kind: 'lora', id: 'a', hash: 'h1', checkedAt: null }, { serverId: 1, kind: 'lora', id: 'b', hash: 'h2', checkedAt: null }],
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
    [{ serverId: 1, kind: 'lora', id: 'a', hash: 'h1', checkedAt: null }, { serverId: 1, kind: 'lora', id: 'b', hash: 'h2', checkedAt: null }],
    async () => ({ name: 'ok' }),
  )
  const run = cancelling.updater.start()
  cancelling.updater.cancel()
  await run
  expect(cancelling.saved.length).toBeLessThan(2)
  expect(cancelling.updater.state().running).toBe(false)
})

test('browsing: the newest version of each model is kept, and a date sort stops at the first version outside the period', async () => {
  const day = 86_400_000
  const now = Date.parse('2026-10-16T12:00:00Z')
  const model = (id: number, ago: number) => ({ id, name: `m${id}`, modelVersions: [
    { id: id * 10, name: 'old', publishedAt: new Date(now - ago - 5 * day).toISOString(), images: [] },
    { id: id * 10 + 1, name: 'new', publishedAt: new Date(now - ago).toISOString(), images: [] },
  ] })
  const fetchFn = (async () => new Response(JSON.stringify({ items: [model(1, day / 2), model(2, 2 * day), model(3, 1.5 * day)], metadata: { nextCursor: 'n' } }))) as typeof fetch
  const q = { kind: 'checkpoint' as const, period: 'day' as const, sort: 'newest' as const, baseModels: [], text: '' }
  const page = await browseCivitai(q, { fetch: fetchFn, now: () => now })
  expect(page.entries.map((e) => [e.modelId, e.versionId, e.versionName])).toEqual([[1, 11, 'new']])
  expect(page.next).toBeNull()
  const popular = await browseCivitai({ ...q, sort: 'downloads' }, { fetch: fetchFn, now: () => now })
  expect(popular.entries).toHaveLength(3)
  expect(popular.next).toBe('n')
  const busy = (async () => new Response('', { status: 429 })) as typeof fetch
  await expect(browseCivitai(q, { fetch: busy, now: () => now })).rejects.toBeInstanceOf(CivitaiBusyError)
})

test('thumbnails ask Civitai for a small size, whether the URL carries a width or original=true', async () => {
  const asked: string[] = []
  const fetchFn = (async (u: RequestInfo | URL) => { asked.push(String(u)); return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }) }) as typeof fetch
  expect(await fetchThumb('https://image.civitai.com/k/u/original=true/1.jpeg', fetchFn)).toMatch(/^data:image\/jpeg;base64,/)
  await fetchThumb('https://image.civitai.com/k/u/width=450/1.jpeg', fetchFn)
  expect(asked).toEqual(['https://image.civitai.com/k/u/width=320/1.jpeg', 'https://image.civitai.com/k/u/width=320/1.jpeg'])
  expect(await fetchThumb('https://evil.example/x.jpeg', fetchFn)).toBeNull()
})
