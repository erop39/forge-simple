import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultParams } from '@shared/profiles'
import type { AppEvents } from '@shared/ipc'
import type { Catalog, GenerationParams } from '@shared/types'
import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'
import { createActiveForge } from '../forge/active-forge'
import { createCapabilities } from '../forge/capabilities'
import { createForgeClient } from '../forge/client'
import { createConnectionMonitor } from '../forge/connection'
import { FINDINGS } from '../forge/findings'
import { createLock } from '../lock/lock'
import { createOplog } from '../oplog/oplog'
import { createRunner } from '../queue/runner'
import { openDb, type Db } from '../storage/db'
import { createImageStore } from '../storage/image-store'
import { createRepos } from '../storage/repos'
import { forwardEvents, registerIpc } from './register'

const CKPT = String.raw`sdxl\sd_xl_base.safetensors [31e35c80fc]`
const DEAD = 'http://127.0.0.1:1'

let mock: MockForge
let db: Db
let dir: string
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
let sent: { e: string; p: unknown }[]
let repos: ReturnType<typeof createRepos>
let oplog: ReturnType<typeof createOplog>
let lock: ReturnType<typeof createLock>
let runner: ReturnType<typeof createRunner>
let kicks: number
let samples: number
let serverChanges: number
let removeFails: boolean
let catalogThrows: boolean
let imageStore: ReturnType<typeof createImageStore>
let forgeRef: ReturnType<typeof createActiveForge>
let copiedText: string | null
let revealed: string | null
let civitaiAsked: string[]
let customPreviews: { kind: string; file: string; bytes: string }[]
let clearedPreviews: string[]
let civitaiAnswers: Map<string, object>
let openedUrls: string[]
let exportPath: string | null
let exportNames: string[]
let selectedImagesDir: string | null
/** The address main treats as Forge on this PC; tests point it at the mock (or at nothing). */
let localServer: string

beforeEach(async () => {
  mock = await startMockForge({ stepMs: 5 })
  db = openDb(':memory:')
  dir = mkdtempSync(path.join(tmpdir(), 'fnc-ipc-'))
  const now = () => 1000
  repos = createRepos(db, now)
  oplog = createOplog(db, now)
  lock = createLock(repos.settings, oplog)
  const forge = createActiveForge({
    activeUrl: () => repos.servers.active()?.url ?? null, familyOverride: () => null, oplog, now,
    modelMeta: (kind) => {
      const id = repos.servers.active()?.id
      return id === undefined ? new Map() : repos.modelMeta.list(id, kind)
    },
    previewUrl: (kind, filename) => `fnc-model://local/${kind}/${filename.length}`,
  })
  forgeRef = forge
  const real0 = createImageStore(() => dir, () => ({ thumb: Buffer.from('t'), width: 1, height: 1 }))
  removeFails = false
  catalogThrows = false
  imageStore = { ...real0, remove: (f, t) => (removeFails ? Promise.reject(new Error('EBUSY: locked')) : real0.remove(f, t)) }
  const images = imageStore
  const real = createRunner({
    client: forge.client, catalog: () => forge.catalog().get(), findings: FINDINGS, repos, images, oplog,
    events: { jobUpdate: () => undefined, jobProgress: () => undefined, imageAdded: () => undefined },
    now, sleep: () => Promise.resolve(),
  })
  kicks = 0
  runner = { ...real, kick: () => { kicks++; real.kick() } }
  samples = 0
  serverChanges = 0
  const realMonitor = createConnectionMonitor({
    ping: () => forge.client().ping(), emit: () => undefined, now, oplog, address: forge.address,
  })
  const monitor = { ...realMonitor, sampleOnce: () => { samples++; return realMonitor.sampleOnce() } }
  handlers = new Map()
  sent = []
  copiedText = null
  revealed = null
  civitaiAsked = []
  customPreviews = []
  clearedPreviews = []
  civitaiAnswers = new Map()
  openedUrls = []
  exportPath = null
  exportNames = []
  selectedImagesDir = null
  localServer = mock.url
  const send = <K extends keyof AppEvents>(e: K, p: AppEvents[K]): void => { sent.push({ e, p }) }
  registerIpc(
    { handle: (ch, fn) => { handlers.set(ch, fn as never) } },
    {
      repos,
      catalog: () => (catalogThrows ? { get: () => Promise.reject(new TypeError('boom')) } : forge.catalog()),
      onServerChanged: () => { serverChanges++ },
      runner, monitor, images, oplog, imagesDir: () => repos.settings.get('imagesDir') ?? dir,
      imageRoots: () => [dir], chooseImagesDir: async () => selectedImagesDir,
      createClient: (url) => createForgeClient(url, { pingTimeoutMs: 500 }),
      copyToClipboard: (value) => { copiedText = value },
      revealFile: (path) => { revealed = path },
      civitai: { lookup: async (hash: string) => { civitaiAsked.push(hash); return (civitaiAnswers.get(hash) ?? null) as never } },
      openExternal: (url: string) => { openedUrls.push(url) },
      previews: {
        setCustom: async (kind: string, file: string, bytes: Buffer) => { customPreviews.push({ kind, file, bytes: bytes.toString() }); return 'custom-1' },
        clearCustom: (_kind: string, file: string) => { clearedPreviews.push(file) },
      },
      civitaiGapMs: 1,
      capabilities: createCapabilities({ client: forge.client, emit: (c) => send('forge:capabilities', c) }),
      lock,
      chooseExportPath: async (name) => { exportNames.push(name); return exportPath },
      exportPageSize: 3,
      get localUrl() { return localServer },
    },
    send,
  )
})

afterEach(async () => {
  await runner.stop()
  await mock.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args)
const logKeys = () => oplog.list().map((e) => e.messageKey)
const goodParams = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  ...defaultParams('sdxl', CKPT, { samplers: ['Euler a'], schedulers: ['Automatic'] }), prompt: 'a cat', ...over,
})

const addServer = (url: string, name = '') => call('servers:add', { name, url })
const sentOf = (e: string) => sent.filter((s) => s.e === e).map((s) => s.p)

test('choosing image storage validates writability and changes only the future-image folder', async () => {
  const next = path.join(dir, 'next')
  mkdirSync(next)
  selectedImagesDir = next
  expect(await call('settings:chooseImagesDir')).toBe(next)
  expect((await call('settings:get') as { imagesDir: string }).imagesDir).toBe(next)
  expect(JSON.parse(repos.settings.get('images.roots')!)).toEqual([dir, next])
  expect(logKeys()).toContain('log.settings.imagesDirChanged')
  selectedImagesDir = null
  expect(await call('settings:chooseImagesDir')).toBeNull()
  expect((await call('settings:get') as { imagesDir: string }).imagesDir).toBe(next)
  selectedImagesDir = path.join(dir, 'missing')
  await expect(call('settings:chooseImagesDir')).rejects.toThrow('error.storageUnavailable')
  expect((await call('settings:get') as { imagesDir: string }).imagesDir).toBe(next)
})

describe('servers', () => {
  test('add normalizes, tests, saves; the first server becomes active and the client follows it', async () => {
    const res = (await addServer(` ${mock.url.replace('http://', '')}/ `, ' Home ')) as {
      ok: boolean; latencyMs: number; errorKey: null
    }
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.errorKey).toBeNull()
    expect(repos.servers.active()).toMatchObject({ name: 'Home', url: mock.url })
    expect(await call('settings:get')).toEqual({ serverUrl: mock.url, imagesDir: dir, localUrl: mock.url,
      upscalers: { hires: null, finished: null }, familyNegatives: {}, civitaiEnabled: false })
    expect(forgeRef.address()).toBe(mock.url)
    expect(kicks).toBe(1)
    expect(serverChanges).toBe(1)
    expect(samples).toBe(1)
    expect(sentOf('servers').at(-1)).toEqual([{ id: 1, name: 'Home', url: mock.url, active: true }])
    expect(logKeys()).toEqual(expect.arrayContaining(['log.server.added', 'log.settings.serverChanged']))
  })

  test('addLocal on a first run saves the local Forge under the given name and makes it active', async () => {
    expect(await call('servers:addLocal', 'This PC')).toBe(true)
    expect(repos.servers.active()).toMatchObject({ name: 'This PC', url: mock.url })
    expect(forgeRef.address()).toBe(mock.url)
    expect(serverChanges).toBe(1)
    expect(kicks).toBe(1)
    expect(sentOf('servers').at(-1)).toEqual([{ id: 1, name: 'This PC', url: mock.url, active: true }])
    expect(oplog.list({ category: 'server' })[0]).toMatchObject({
      messageKey: 'log.server.added', details: { name: 'This PC', url: mock.url },
    })
    expect(logKeys()).toContain('log.settings.serverChanged')
  })

  test('addLocal with nothing listening saves nothing, logs nothing and does not reject', async () => {
    localServer = DEAD
    expect(await call('servers:addLocal', 'This PC')).toBe(false)
    expect(repos.servers.list()).toEqual([])
    expect(oplog.list({ category: 'server' })).toEqual([])
    expect(sentOf('servers')).toEqual([])
    expect(serverChanges).toBe(0)
  })

  test('addLocal does not answer for a server that is not Forge', async () => {
    mock.respond('/sdapi/v1/progress', { json: { hello: 'world' } })
    expect(await call('servers:addLocal', 'This PC')).toBe(false)
    expect(repos.servers.list()).toEqual([])
  })

  test('addLocal never adds or even pings when any server is saved', async () => {
    repos.servers.add('Studio', 'http://studio.test')
    const before = mock.requests.length
    expect(await call('servers:addLocal', 'This PC')).toBe(false)
    expect(mock.requests.length).toBe(before)
    expect(repos.servers.list().map((s) => s.name)).toEqual(['Studio'])
    expect(serverChanges).toBe(0)
  })

  test.each([
    ['a non-string name', 5],
    ['an overlong name', 'x'.repeat(101)],
  ])('addLocal rejects %s with error.invalidParams', async (_n, name) => {
    await expect(call('servers:addLocal', name)).rejects.toThrow('error.invalidParams')
  })

  test('a later server is saved inactive, named after its host when the name is blank', async () => {
    repos.servers.setActiveUrl('http://first.test')
    await addServer(mock.url)
    expect(repos.servers.active()?.url).toBe('http://first.test')
    expect(await call('servers:list')).toEqual([
      { id: 2, name: '127.0.0.1', url: mock.url, active: false },
      { id: 1, name: 'first.test', url: 'http://first.test', active: true },
    ])
    expect(serverChanges).toBe(0)
    const added = oplog.list({ category: 'server' })[0]!
    expect(added).toMatchObject({ messageKey: 'log.server.added', details: { name: '127.0.0.1', url: mock.url } })
  })

  test('add on a dead or invalid address returns error.network and saves nothing', async () => {
    expect(await addServer(DEAD)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
    expect(await addServer('ftp://nope')).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
    expect(repos.servers.list()).toEqual([])
    expect(kicks).toBe(0)
  })

  test('add on a non-Forge address returns error.notForge', async () => {
    mock.respond('/sdapi/v1/progress', { json: { hello: 'world' } })
    expect(await addServer(mock.url)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.notForge' })
    mock.respond('/sdapi/v1/progress', { status: 404, json: { detail: 'Not Found' } })
    expect(await addServer(mock.url)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.notForge' })
    expect(repos.servers.list()).toEqual([])
  })

  test('add of an address that is already saved rejects with error.duplicateServer', async () => {
    await addServer(mock.url)
    await expect(addServer(`${mock.url}/`, 'again')).rejects.toThrow('error.duplicateServer')
    expect(repos.servers.list()).toHaveLength(1)
  })

  test.each([
    ['no object', undefined],
    ['a non-string url', { name: '', url: 5 }],
    ['an overlong name', { name: 'x'.repeat(101), url: 'http://a.test' }],
    ['an overlong url', { name: '', url: `http://${'a'.repeat(2050)}` }],
  ])('add rejects %s with error.invalidParams', async (_n, input) => {
    await expect(call('servers:add', input)).rejects.toThrow('error.invalidParams')
  })

  test('update renames without a connection test and logs old and new', async () => {
    const s = repos.servers.add('old', DEAD)
    expect(await call('servers:update', s.id, { name: 'New', url: DEAD })).toEqual({ ok: true, latencyMs: null, errorKey: null })
    expect(repos.servers.get(s.id)?.name).toBe('New')
    expect(oplog.list({ category: 'server' })[0]).toMatchObject({
      messageKey: 'log.server.updated',
      details: { old: { name: 'old', url: DEAD }, new: { name: 'New', url: DEAD } },
    })
    expect(sentOf('servers')).toHaveLength(1)
  })

  test('update tests a changed address and keeps the old one when it fails', async () => {
    const s = repos.servers.add('a', 'http://a.test')
    expect(await call('servers:update', s.id, { name: 'a', url: DEAD })).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
    expect(repos.servers.get(s.id)?.url).toBe('http://a.test')
    expect((await call('servers:update', s.id, { name: 'a', url: mock.url }) as { ok: boolean }).ok).toBe(true)
    expect(repos.servers.get(s.id)?.url).toBe(mock.url)
  })

  test('update rejects an unknown id and a duplicate address', async () => {
    const a = repos.servers.add('a', 'http://a.test')
    repos.servers.add('b', mock.url)
    await expect(call('servers:update', 99, { name: 'x', url: mock.url })).rejects.toThrow('error.notFound')
    await expect(call('servers:update', a.id, { name: 'a', url: mock.url })).rejects.toThrow('error.duplicateServer')
  })

  test('changing the active server address re-points the client', async () => {
    const s = repos.servers.setActiveUrl('http://old.test')
    await call('servers:update', s.id, { name: 'home', url: mock.url })
    expect(forgeRef.address()).toBe(mock.url)
    expect(serverChanges).toBe(1)
    expect(kicks).toBe(1)
    expect(oplog.list({ category: 'settings' })[0]?.details).toEqual({ key: 'serverUrl', old: 'http://old.test', new: mock.url })
  })

  test('activate switches the server: client, catalog and runner follow, and the switch is logged', async () => {
    const other = await startMockForge({ stepMs: 5 })
    try {
      const a = repos.servers.setActiveUrl(mock.url)
      const b = repos.servers.add('b', other.url)
      await call('catalog:get')
      await call('servers:activate', b.id)
      expect(repos.servers.active()?.id).toBe(b.id)
      expect(forgeRef.address()).toBe(other.url)
      expect(kicks).toBe(1)
      expect(serverChanges).toBe(1)
      expect(samples).toBe(1)
      const entry = oplog.list({ category: 'settings' })[0]!
      expect(entry).toMatchObject({ messageKey: 'log.settings.serverChanged', details: { key: 'serverUrl', old: mock.url, new: other.url } })
      expect(sentOf('servers').at(-1)).toEqual([
        { id: a.id, name: '127.0.0.1', url: mock.url, active: false },
        { id: b.id, name: 'b', url: other.url, active: true },
      ])
      const before = other.requests.length
      await call('catalog:get')
      expect(other.requests.length).toBeGreaterThan(before)
    } finally {
      await other.close()
    }
  })

  test('activate is refused with error.jobRunning while a job runs, and with error.notFound for an unknown id', async () => {
    const a = repos.servers.setActiveUrl(mock.url)
    const b = repos.servers.add('b', 'http://b.test')
    const job = repos.jobs.insert(a.id, 'txt2img', goodParams())
    repos.jobs.setStatus(job.id, 'running')
    await expect(call('servers:activate', b.id)).rejects.toThrow('error.jobRunning')
    expect(repos.servers.active()?.id).toBe(a.id)
    expect(kicks).toBe(0)
    await expect(call('servers:activate', 99)).rejects.toThrow('error.notFound')
  })

  test('remove deletes queued jobs (announced), logs, and removing the active server leaves none', async () => {
    const a = repos.servers.setActiveUrl(mock.url)
    const q = repos.jobs.insert(a.id, 'txt2img', goodParams())
    await call('servers:remove', a.id)
    expect(repos.servers.list()).toEqual([])
    expect(repos.jobs.get(q.id)).toBeNull()
    expect(sentOf('job:removed')).toEqual([{ id: q.id }])
    expect(sentOf('servers').at(-1)).toEqual([])
    expect(await call('settings:get')).toEqual({ serverUrl: null, imagesDir: dir, localUrl: mock.url,
      upscalers: { hires: null, finished: null }, familyNegatives: {}, civitaiEnabled: false })
    expect(serverChanges).toBe(1)
    expect(oplog.list({ category: 'server' })[0]).toMatchObject({
      messageKey: 'log.server.removed', details: { name: '127.0.0.1', url: mock.url, deletedJobs: 1 },
    })
    await expect(call('servers:remove', a.id)).rejects.toThrow('error.notFound')
  })

  test('removing an inactive server keeps the active one and does not re-point anything', async () => {
    repos.servers.setActiveUrl(mock.url)
    const b = repos.servers.add('b', 'http://b.test')
    await call('servers:remove', b.id)
    expect(repos.servers.active()?.url).toBe(mock.url)
    expect(serverChanges).toBe(0)
  })

  test('remove is refused while a job of that server runs', async () => {
    const a = repos.servers.setActiveUrl(mock.url)
    const job = repos.jobs.insert(a.id, 'txt2img', goodParams())
    repos.jobs.setStatus(job.id, 'running')
    await expect(call('servers:remove', a.id)).rejects.toThrow('error.jobRunning')
    expect(repos.servers.active()?.id).toBe(a.id)
  })

  test("changing the active server's address is refused while a job runs; a rename alone is allowed", async () => {
    const a = repos.servers.setActiveUrl(mock.url)
    const job = repos.jobs.insert(a.id, 'txt2img', goodParams())
    repos.jobs.setStatus(job.id, 'running')
    await expect(call('servers:update', a.id, { name: 'Home', url: 'http://elsewhere.test' })).rejects.toThrow('error.jobRunning')
    expect(repos.servers.get(a.id)?.url).toBe(mock.url)
    await call('servers:update', a.id, { name: 'Home', url: mock.url })
    expect(repos.servers.get(a.id)?.name).toBe('Home')
    expect(serverChanges).toBe(0)
  })

  test('retry of a job whose server was removed, with no server left, rejects with error.noServer', async () => {
    const a = repos.servers.setActiveUrl(mock.url)
    const job = repos.jobs.insert(a.id, 'txt2img', goodParams())
    repos.jobs.setStatus(job.id, 'failed')
    await call('servers:remove', a.id)
    await expect(call('jobs:retry', job.id)).rejects.toThrow('error.noServer')
  })
})

test('jobs:enqueue rejects params with count outside 1..8 or an empty prompt', async () => {
  await addServer(mock.url)
  const bad = [
    goodParams({ count: 0 }), goodParams({ count: 9 }), goodParams({ count: 1.5 }), goodParams({ prompt: '  ' }),
    goodParams({ width: 32 }), goodParams({ height: 5000 }), goodParams({ steps: 0 }), goodParams({ checkpoint: '' }),
    null, 'x',
  ]
  for (const b of bad) await expect(call('jobs:enqueue', b)).rejects.toThrow('error.invalidParams')
  expect(repos.jobs.listActive()).toEqual([])
  const jobs = (await call('jobs:enqueue', goodParams({ count: 2 }))) as unknown[]
  expect(jobs).toHaveLength(2)
})

test('without a server, enqueue and catalog:get reject with error.noServer', async () => {
  await expect(call('jobs:enqueue', goodParams())).rejects.toThrow('error.noServer')
  await expect(call('catalog:get')).rejects.toThrow('error.noServer')
})

test('catalog:defaults and parts use the catalog; a dead server maps to error.network', async () => {
  await addServer(mock.url)
  const defaults = (await call('catalog:defaults', CKPT)) as GenerationParams
  expect(defaults.checkpoint).toBe(CKPT)
  expect(defaults.family).toBe('sdxl')
  const krea = (await call('catalog:defaults', String.raw`krea2\krea2_turbo_fp8.safetensors [a1b2c3d4e5]`)) as GenerationParams
  expect(krea.family).toBe('krea2')
  expect(krea.modules).toEqual([String.raw`C:\forge\models\VAE\ae.safetensors`, String.raw`C:\forge\models\text_encoder\clip_l.safetensors`])
  expect(defaults.modules).toEqual([])
  await expect(call('catalog:defaults', 'nope')).rejects.toThrow('error.notFound')
  expect(await call('catalog:parts', goodParams())).toEqual([{ role: 'model', value: CKPT, found: true }])

  repos.servers.setActiveUrl(DEAD)
  await expect(call('catalog:get', true)).rejects.toThrow('error.network')
})

test('jobs handlers reject unknown ids and bad arguments with stable keys', async () => {
  await expect(call('jobs:retry', 999)).rejects.toThrow('error.notFound')
  await expect(call('jobs:cancel', 'x')).rejects.toThrow('error.invalidParams')
})

function seedImage() {
  const job = repos.jobs.insert(repos.servers.setActiveUrl(mock.url).id, 'txt2img', goodParams())
  mkdirSync(path.join(dir, '2026-10'), { recursive: true })
  mkdirSync(path.join(dir, 'thumbs'), { recursive: true })
  const filePath = path.join(dir, '2026-10', '1-5.png')
  const thumbPath = path.join(dir, 'thumbs', '1-5.jpg')
  writeFileSync(filePath, 'png')
  writeFileSync(thumbPath, 'jpg')
  const row = repos.images.insert({ jobId: job.id, filePath, thumbPath, width: 64, height: 64, seed: 5, infotext: 'i', durationMs: 1 })
  return { row, filePath, thumbPath }
}

test('images:list maps file paths to fnc-img URLs', async () => {
  const { row } = seedImage()
  const list = (await call('images:list', { limit: 100000 })) as Record<string, unknown>[]
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({
    id: row.id, url: `fnc-img://local/image/${row.id}`, thumbUrl: `fnc-img://local/thumb/${row.id}`,
  })
  expect(list[0]).not.toHaveProperty('filePath')
  await expect(call('images:list', { limit: 'x' })).rejects.toThrow('error.invalidParams')
})

test('images:details returns the full image and saved generation settings', async () => {
  const { row } = seedImage()
  const details = await call('images:details', row.id)
  expect(details).toMatchObject({
    image: { id: row.id, url: `fnc-img://local/image/${row.id}` },
    params: { prompt: 'a cat', checkpoint: CKPT },
    jobType: 'txt2img',
  })
  expect((details as { image: object }).image).not.toHaveProperty('filePath')
  await expect(call('images:details', 0)).rejects.toThrow('error.invalidParams')
  await expect(call('images:details', row.id + 1)).rejects.toThrow('error.notFound')
})

test('clipboard:writeText copies a prompt without logging it', async () => {
  await call('clipboard:writeText', 'a private prompt')
  expect(copiedText).toBe('a private prompt')
  expect(JSON.stringify(oplog.list())).not.toContain('a private prompt')
  await expect(call('clipboard:writeText', 3)).rejects.toThrow('error.invalidParams')
})

test('images:reveal shows the saved file and refuses a hidden image while locked', async () => {
  const { row, filePath } = seedImage()
  await call('images:reveal', row.id)
  expect(revealed).toBe(filePath)
  revealed = null
  repos.images.setHidden([row.id], true)
  await expect(call('images:reveal', row.id)).rejects.toThrow('error.notFound')
  expect(revealed).toBeNull()
  await expect(call('images:reveal', 0)).rejects.toThrow('error.invalidParams')
})

test('images:delete removes the row and both files, emits image:removed, logs storage', async () => {
  const { row, filePath, thumbPath } = seedImage()
  await call('images:delete', row.id)
  expect(repos.images.list({ limit: 10 })).toEqual([])
  expect(existsSync(filePath)).toBe(false)
  expect(existsSync(thumbPath)).toBe(false)
  expect(sent).toContainEqual({ e: 'image:removed', p: { id: row.id } })
  expect(logKeys()).toContain('log.storage.imageDeleted')
  await expect(call('images:delete', row.id)).rejects.toThrow('error.notFound')
})

test('connection:get returns the monitor status', async () => {
  expect(await call('connection:get')).toMatchObject({ state: 'reconnecting' })
})

test('images:delete still emits, logs and resolves when file removal fails', async () => {
  const { row, filePath } = seedImage()
  removeFails = true
  await call('images:delete', row.id)
  expect(repos.images.list({ limit: 10 })).toEqual([])
  expect(sent).toContainEqual({ e: 'image:removed', p: { id: row.id } })
  expect(logKeys()).toContain('log.storage.imageDeleted')
  const warn = oplog.list({ level: 'warn', category: 'storage' })[0]!
  expect(warn.details).toMatchObject({ filePath, error: 'EBUSY: locked' })
})

test('a non-Forge exception surfaces as error.unexpected and is console.error-ed', async () => {
  await addServer(mock.url)
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  catalogThrows = true
  await expect(call('catalog:get')).rejects.toThrow('error.unexpected')
  expect(spy).toHaveBeenCalledOnce()
  expect(String(spy.mock.calls[0]![0])).toContain('catalog:get')
  expect(spy.mock.calls[0]![1]).toBeInstanceOf(TypeError)
  spy.mockRestore()
})

test('a handler throwing a plain Error rejects with error.unexpected, original logged', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const boom = new Error('secret internal text')
  const broken = { ...repos.jobs, listActive: () => { throw boom } }
  const h = new Map<string, (...a: unknown[]) => Promise<unknown>>()
  registerIpc({ handle: (c, f) => { h.set(c, f as never) } }, {
    repos: { ...repos, jobs: broken }, catalog: () => forgeRef.catalog(), runner,
    monitor: { sampleOnce: () => Promise.reject(new Error('x')), current: () => ({ state: 'offline', latencyMs: null, attempts: 0, lastOkAt: null }) },
    images: imageStore, oplog, imagesDir: () => dir, createClient: () => { throw boom },
    copyToClipboard: () => undefined,
    revealFile: () => undefined,
    capabilities: { current: () => ({ canRestart: false }), refresh: async () => ({ canRestart: false }), reset: () => undefined },
    chooseExportPath: async () => null, lock: createLock(repos.settings, oplog),
  }, () => undefined)
  const err = await h.get('jobs:listActive')!({}).catch((e: Error) => e)
  expect((err as Error).message).toBe('error.unexpected')
  expect(spy).toHaveBeenCalledWith('ipc: jobs:listActive failed', boom)
  spy.mockRestore()
})

test('forwardEvents sends job events and converts ImageRow to ImageRecord without paths', () => {
  const out: { e: string; p: Record<string, unknown> }[] = []
  const ev = forwardEvents(((e: string, p: Record<string, unknown>) => { out.push({ e, p }) }) as never, { isOpen: () => true })
  const { row } = seedImage()
  ev.runner.imageAdded(row)
  ev.runner.jobUpdate({ id: 1 } as never)
  ev.runner.jobProgress({ jobId: 1 } as never)
  ev.connection({ state: 'connected', latencyMs: 1, attempts: 0, lastOkAt: 1 })
  expect(out.map((o) => o.e)).toEqual(['image:added', 'job:update', 'job:progress', 'connection'])
  expect(out[0]!.p).toMatchObject({ id: row.id, url: `fnc-img://local/image/${row.id}`, thumbUrl: `fnc-img://local/thumb/${row.id}` })
  expect(out[0]!.p).not.toHaveProperty('filePath')
  expect(out[0]!.p).not.toHaveProperty('thumbPath')
})

test('forwardEvents redacts a hidden image while the lock is closed', () => {
  const out: Record<string, unknown>[] = []
  let open = false
  const ev = forwardEvents(((_e: string, p: Record<string, unknown>) => { out.push(p) }) as never, { isOpen: () => open })
  const { row } = seedImage()
  const hidden = { ...row, hidden: true, sourceImageId: 3 }
  ev.runner.imageAdded(hidden)
  expect(out[0]).toMatchObject({ id: row.id, hidden: true, locked: true, url: '', thumbUrl: '', infotext: '', jobId: 0, sourceImageId: null })
  open = true
  ev.runner.imageAdded(hidden)
  expect(out[1]).toMatchObject({ locked: false, sourceImageId: 3 })
})

describe('jobs:enqueue boundary', () => {
  const loras = (n: number) => Array.from({ length: n }, () => ({ name: 'l', weight: 1, enabled: true }))
  const rejections: [string, Partial<GenerationParams>][] = [
    ['seed below -1', { seed: -2 }], ['fractional seed', { seed: 1.5 }],
    ['cfgScale > 30', { cfgScale: 31 }], ['cfgScale NaN', { cfgScale: NaN }], ['distilledCfg < 0', { distilledCfg: -1 }],
    ['prompt too long', { prompt: 'a'.repeat(10001) }], ['negative prompt too long', { negativePrompt: 'a'.repeat(10001) }],
    ['9 modules', { modules: Array.from({ length: 9 }, () => 'm') }], ['non-string module', { modules: [1 as never] }],
    ['17 loras', { loras: loras(17) }], ['lora empty name', { loras: [{ name: '', weight: 1, enabled: true }] }],
    ['lora weight 6', { loras: [{ name: 'l', weight: 6, enabled: true }] }],
    ['lora enabled not boolean', { loras: [{ name: 'l', weight: 1, enabled: 1 as never }] }],
    ['empty sampler', { sampler: '' }], ['empty scheduler', { scheduler: ' ' }],
    ['unknown family', { family: 'nope' as never }], ['prototype family', { family: 'toString' as never }],
    ['hires scale', { hires: { scale: 3, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } as never }],
    ['hires upscaler', { hires: { scale: 2, upscaler: '', secondPassSteps: 12, denoisingStrength: 0.4 } }],
    ['hires denoising', { hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 2 } }],
    ['hires steps', { hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 0, denoisingStrength: 0.4 } }],
    ['hires target too wide', { width: 4096, hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }],
    ['hires primitive', { hires: 'on' as never }],
    ['img2img source zero', { img2img: { sourceImageId: 0, denoisingStrength: 0.5, resizeMode: 0 } }],
    ['img2img denoising', { img2img: { sourceImageId: 1, denoisingStrength: 2, resizeMode: 0 } }],
    ['img2img resize mode', { img2img: { sourceImageId: 1, denoisingStrength: 0.5, resizeMode: 8 } as never }],
    ['img2img with hires', { img2img: { sourceImageId: 1, denoisingStrength: 0.5, resizeMode: 0 }, hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }],
  ]
  test.each(rejections)('rejects %s', async (_name, over) => {
    await addServer(mock.url)
    await expect(call('jobs:enqueue', goodParams(over))).rejects.toThrow('error.invalidParams')
    expect(repos.jobs.listActive()).toEqual([])
  })

  test('drops unknown extra keys', async () => {
    await addServer(mock.url)
    const jobs = (await call('jobs:enqueue', { ...goodParams(), evil: 'x', loras: [{ name: 'l', weight: 1, enabled: true, extra: 1 }] })) as { params: Record<string, unknown> }[]
    expect(jobs[0]!.params).not.toHaveProperty('evil')
    expect(jobs[0]!.params.loras).toEqual([{ name: 'l', weight: 1, enabled: true }])
  })

  test('stores only checked hires settings', async () => {
    await addServer(mock.url)
    const jobs = (await call('jobs:enqueue', {
      ...goodParams(), hires: { scale: 1.5, upscaler: 'Latent', secondPassSteps: 14, denoisingStrength: 0.45, extra: 'x' },
    })) as { params: Record<string, unknown> }[]
    expect(jobs[0]!.params.hires).toEqual({ scale: 1.5, upscaler: 'Latent', secondPassSteps: 14, denoisingStrength: 0.45 })
  })

  test('img2img accepts only an existing accessible image ID and strips extra settings', async () => {
    await addServer(mock.url)
    const settings = { sourceImageId: 1, denoisingStrength: 0.5, resizeMode: 0, sourceBytes: 'secret' }
    await expect(call('jobs:enqueue', { ...goodParams(), img2img: settings })).rejects.toThrow('error.notFound')
    const origin = repos.jobs.insert(repos.servers.active()!.id, 'txt2img', goodParams())
    const source = repos.images.insert({ jobId: origin.id, filePath: path.join(dir, 'source.png'),
      thumbPath: path.join(dir, 'source.jpg'), width: 64, height: 64, seed: 1, infotext: '', durationMs: 1 })
    await lock.setPassword(null, 'secret-pass')
    repos.images.setHidden([source.id], true)
    await expect(call('jobs:enqueue', { ...goodParams(), img2img: settings })).rejects.toThrow('error.notFound')
    await lock.open('secret-pass')
    const jobs = await call('jobs:enqueue', { ...goodParams(), img2img: settings }) as { id: number; type: string; params: Record<string, unknown> }[]
    expect(jobs[0]).toMatchObject({ type: 'img2img', params: { img2img: { sourceImageId: source.id, denoisingStrength: 0.5, resizeMode: 0 } } })
    expect(JSON.stringify(jobs)).not.toContain('sourceBytes')
    repos.jobs.setStatus(jobs[0]!.id, 'failed')
    lock.close()
    await expect(call('jobs:retry', jobs[0]!.id)).rejects.toThrow('error.notFound')
  })

  test('upscale validates source, scale and lock, and keeps only typed settings', async () => {
    await addServer(mock.url)
    const upscale = { sourceImageId: 1, upscaler: 'R-ESRGAN 4x+', scale: 2, image: 'secret' }
    await expect(call('jobs:enqueue', { ...goodParams(), prompt: '', upscale })).rejects.toThrow('error.notFound')
    const origin = repos.jobs.insert(repos.servers.active()!.id, 'txt2img', goodParams())
    const source = repos.images.insert({ jobId: origin.id, filePath: path.join(dir, 'upscale-source.png'),
      thumbPath: path.join(dir, 'upscale-source.jpg'), width: 1200, height: 1200, seed: 1, infotext: '', durationMs: 1 })
    await expect(call('jobs:enqueue', { ...goodParams(), prompt: '', upscale: { ...upscale, upscaler: 'unknown' } })).rejects.toThrow('error.invalidParams')
    await expect(call('jobs:enqueue', { ...goodParams(), prompt: '', upscale: { ...upscale, scale: 8 } })).rejects.toThrow('error.invalidParams')
    await expect(call('jobs:enqueue', { ...goodParams(), prompt: '', upscale: { ...upscale, scale: 4 } })).rejects.toThrow('error.invalidParams')
    await lock.setPassword(null, 'secret-pass')
    repos.images.setHidden([source.id], true)
    await expect(call('jobs:enqueue', { ...goodParams(), prompt: '', upscale })).rejects.toThrow('error.notFound')
    await lock.open('secret-pass')
    const jobs = await call('jobs:enqueue', { ...goodParams(), prompt: '', upscale }) as { id: number; type: string; params: Record<string, unknown> }[]
    expect(jobs[0]).toMatchObject({ type: 'upscale', params: { upscale: { sourceImageId: source.id, upscaler: 'R-ESRGAN 4x+', scale: 2 } } })
    expect(JSON.stringify(jobs)).not.toContain('secret')
    repos.jobs.setStatus(jobs[0]!.id, 'failed')
    lock.close()
    await expect(call('jobs:retry', jobs[0]!.id)).rejects.toThrow('error.notFound')
  })

  test('upscaler preferences accept only names offered by Forge and feed hires defaults', async () => {
    await addServer(mock.url)
    await expect(call('settings:setUpscalers', { hires: 'missing', finished: 'R-ESRGAN 4x+' })).rejects.toThrow('error.invalidParams')
    await call('settings:setUpscalers', { hires: 'R-ESRGAN 4x+', finished: 'Latent' })
    expect(await call('settings:get')).toMatchObject({ upscalers: { hires: 'R-ESRGAN 4x+', finished: 'Latent' } })
    const catalog = await call('catalog:get') as { checkpoints: { title: string }[] }
    const defaults = await call('catalog:defaults', catalog.checkpoints[0]!.title) as { hires: { upscaler: string } }
    expect(defaults.hires.upscaler).toBe('R-ESRGAN 4x+')
  })
})

describe('negative presets', () => {
  const SECRET = 'a very private negative text'
  const presetLog = () => oplog.list({ category: 'preset' })

  test('add trims the name, saves, logs the name only, and list returns it', async () => {
    const created = (await call('negativePresets:add', { name: '  Hands  ', text: SECRET })) as { id: number; name: string }
    expect(created).toMatchObject({ name: 'Hands', text: SECRET })
    expect(await call('negativePresets:list')).toEqual([created])
    expect(presetLog()[0]).toMatchObject({ messageKey: 'log.preset.created', details: { name: 'Hands' } })
  })

  test('rename, text change and delete log names and never the text', async () => {
    const p = (await call('negativePresets:add', { name: 'one', text: SECRET })) as { id: number }
    expect(await call('negativePresets:update', p.id, { name: 'two' })).toMatchObject({ name: 'two', text: SECRET })
    expect(await call('negativePresets:update', p.id, { text: `${SECRET} 2` })).toMatchObject({ text: `${SECRET} 2` })
    await call('negativePresets:remove', p.id)
    expect(await call('negativePresets:list')).toEqual([])
    expect(presetLog().map((e) => [e.messageKey, e.details]).reverse()).toEqual([
      ['log.preset.created', { name: 'one' }],
      ['log.preset.renamed', { old: 'one', new: 'two' }],
      ['log.preset.updated', { name: 'two' }],
      ['log.preset.deleted', { name: 'two' }],
    ])
    const rows = db.prepare('SELECT message_key, details FROM oplog').all()
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  test('a taken name (any case) is refused with error.presetNameTaken', async () => {
    const a = (await call('negativePresets:add', { name: 'Hands', text: 'x' })) as { id: number }
    await expect(call('negativePresets:add', { name: 'hands', text: 'y' })).rejects.toThrow('error.presetNameTaken')
    const b = (await call('negativePresets:add', { name: 'Eyes', text: 'y' })) as { id: number }
    await expect(call('negativePresets:update', b.id, { name: 'HANDS' })).rejects.toThrow('error.presetNameTaken')
    expect(a.id).not.toBe(b.id)
  })

  test('validation: name trimmed non-empty and at most 80 characters, text a string within the prompt limit', async () => {
    const bad: unknown[] = [
      null, 'x', { name: '   ', text: 'x' }, { name: 'n'.repeat(81), text: 'x' }, { name: 'n', text: 5 },
      { name: 'n', text: 't'.repeat(10_001) }, { name: 5, text: 'x' },
    ]
    for (const input of bad) {
      await expect(call('negativePresets:add', input)).rejects.toThrow('error.invalidParams')
    }
    expect(await call('negativePresets:add', { name: 'n'.repeat(80), text: 't'.repeat(10_000) })).toBeTruthy()
    const p = (await call('negativePresets:add', { name: 'ok', text: '' })) as { id: number }
    await expect(call('negativePresets:update', p.id, { name: '' })).rejects.toThrow('error.invalidParams')
    await expect(call('negativePresets:update', p.id, {})).rejects.toThrow('error.invalidParams')
    await expect(call('negativePresets:update', 0, { name: 'x' })).rejects.toThrow('error.invalidParams')
    await expect(call('negativePresets:update', 999, { name: 'x' })).rejects.toThrow('error.notFound')
    await expect(call('negativePresets:remove', 'one')).rejects.toThrow('error.invalidParams')
    await expect(call('negativePresets:remove', 999)).rejects.toThrow('error.notFound')
    expect(presetLog().every((e) => e.messageKey === 'log.preset.created')).toBe(true)
  })
})

describe('forge control', () => {
  test('capabilities follow api_server_stop of the active server and are re-read on a switch', async () => {
    expect(await call('forge:capabilities')).toEqual({ canRestart: false })
    const restartable = await startMockForge({ stepMs: 5, apiServerStop: true })
    try {
      await addServer(restartable.url)
      await vi.waitFor(async () => expect(await call('forge:capabilities')).toEqual({ canRestart: true }))
      expect(sentOf('forge:capabilities')).toEqual([{ canRestart: true }])
      const other = repos.servers.add('plain', mock.url)
      await call('servers:activate', other.id)
      expect(await call('forge:capabilities')).toEqual({ canRestart: false })
      expect(sentOf('forge:capabilities').at(-1)).toEqual({ canRestart: false })
    } finally {
      await restartable.close()
    }
  })

  test('restart and unload need an active server', async () => {
    await expect(call('forge:restart')).rejects.toThrow('error.noServer')
    await expect(call('forge:unload')).rejects.toThrow('error.noServer')
  })

  test('restart without the flag answers notAllowed, logs it, and leaves the queue alone', async () => {
    repos.servers.setActiveUrl(mock.url)
    expect(await call('forge:restart')).toBe('notAllowed')
    expect(oplog.list({ category: 'server' })[0]).toMatchObject({
      level: 'warn', messageKey: 'log.server.restartRefused', details: { url: mock.url, outcome: 'notAllowed' },
    })
    expect(logKeys()).not.toContain('log.queue.paused')
  })

  test('restart of an unreachable server rejects with error.network', async () => {
    repos.servers.setActiveUrl(DEAD)
    await expect(call('forge:restart')).rejects.toThrow('error.network')
  })

  test('restart interrupts the running job (stopped), pauses the queue, and the queue resumes when Forge is back', async () => {
    const forge = await startMockForge({ stepMs: 100, apiServerStop: true, restartMs: 300 })
    try {
      repos.servers.setActiveUrl(forge.url)
      runner.start()
      const [job, next] = runner.enqueue(goodParams({ steps: 200, count: 2 }))
      await vi.waitFor(() => expect(repos.jobs.get(job!.id)?.status).toBe('running'), { timeout: 5000 })
      expect(await call('forge:restart')).toBe('restarting')
      await vi.waitFor(() => expect(repos.jobs.get(job!.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } }))
      expect(oplog.list().find((e) => e.messageKey === 'log.queue.paused')?.details).toEqual({ reason: 'restart' })
      expect(oplog.list({ category: 'server' })[0]).toMatchObject({
        level: 'info', messageKey: 'log.server.restartRequested', details: { url: forge.url, outcome: 'restarting' },
      })
      await vi.waitFor(() => expect(forge.stats().restarts).toBe(1), { timeout: 5000 })
      await vi.waitFor(() => expect(repos.jobs.get(next!.id)?.status).toBe('running'), { timeout: 10_000 })
    } finally {
      await runner.stop()
      await forge.close()
    }
  }, 20_000)

  test('unload posts to Forge and logs the server; refused while a job runs', async () => {
    const s = repos.servers.setActiveUrl(mock.url)
    await call('forge:unload')
    expect(mock.stats().unloads).toBe(1)
    expect(oplog.list({ category: 'server' })[0]).toMatchObject({
      messageKey: 'log.server.unloaded', details: { name: s.name, url: mock.url },
    })
    const job = repos.jobs.insert(s.id, 'txt2img', goodParams())
    repos.jobs.setStatus(job.id, 'running')
    await expect(call('forge:unload')).rejects.toThrow('error.jobRunning')
  })

  test('health reports the runner flag', async () => {
    expect(await call('forge:health')).toEqual({ unhealthy: false })
  })
})

describe('operation log', () => {
  const seed = () => {
    oplog.write({ level: 'info', category: 'app', messageKey: 'log.app.started' })
    oplog.write({ level: 'error', category: 'error', messageKey: 'log.error.generation', jobId: 4, details: { kind: 'http', status: 500 } })
    oplog.write({ level: 'warn', category: 'queue', messageKey: 'log.queue.paused', details: { reason: 'restart' } })
  }

  test('list filters by level, category, time and limit, newest first', async () => {
    seed()
    expect((await call('oplog:list', {}) as { messageKey: string }[]).map((e) => e.messageKey))
      .toEqual(['log.queue.paused', 'log.error.generation', 'log.app.started'])
    expect(await call('oplog:list', { level: 'error' })).toHaveLength(1)
    expect(await call('oplog:list', { category: 'queue' })).toHaveLength(1)
    expect(await call('oplog:list', { from: 1001 })).toHaveLength(0)
    expect(await call('oplog:list', { limit: 2 })).toHaveLength(2)
  })

  test.each([
    ['a bad level', { level: 'debug' }],
    ['a bad category', { category: 'nope' }],
    ['a negative from', { from: -1 }],
    ['a zero limit', { limit: 0 }],
    ['not an object', 'all'],
  ])('list rejects %s with error.invalidParams', async (_n, query) => {
    await expect(call('oplog:list', query)).rejects.toThrow('error.invalidParams')
  })

  test('export writes the matching entries as JSON Lines to the chosen file and logs the export', async () => {
    seed()
    exportPath = path.join(dir, 'log.jsonl')
    expect(await call('oplog:export', { level: 'error' })).toBe(true)
    expect(exportNames[0]).toMatch(/^forge-neo-client-log-\d{4}-\d{2}-\d{2}\.jsonl$/)
    const lines = readFileSync(exportPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([expect.objectContaining({ messageKey: 'log.error.generation', jobId: 4, time: new Date(1000).toISOString() })])
    expect(oplog.list({ category: 'backup' })[0]).toMatchObject({ messageKey: 'log.backup.logExported', details: { file: 'log.jsonl', count: 1 } })
    expect(JSON.stringify(oplog.list({ category: 'backup' })[0]!.details)).not.toContain(dir)
  })

  test('export pages through every matching entry, beyond one page, and counts them all', async () => {
    for (let i = 0; i < 10; i++) oplog.write({ level: 'info', category: 'queue', messageKey: 'log.queue.added', jobId: i + 1 })
    oplog.write({ level: 'info', category: 'app', messageKey: 'log.app.started' })
    exportPath = path.join(dir, 'all.jsonl')
    expect(await call('oplog:export', { category: 'queue', limit: 2 })).toBe(true)
    const lines = readFileSync(exportPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { jobId: number })
    expect(lines.map((l) => l.jobId)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    expect(oplog.list({ category: 'backup' })[0]?.details).toEqual({ file: 'all.jsonl', count: 10 })
  })

  test('export with ids writes exactly those entries (the panel search results)', async () => {
    seed()
    exportPath = path.join(dir, 'some.jsonl')
    await call('oplog:export', { ids: [1, 3] })
    const lines = readFileSync(exportPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { id: number })
    expect(lines.map((l) => l.id)).toEqual([3, 1])
    await expect(call('oplog:export', { ids: [0] })).rejects.toThrow('error.invalidParams')
    await expect(call('oplog:export', { ids: 'x' })).rejects.toThrow('error.invalidParams')
  })

  test('the default export file name carries the local date', async () => {
    await call('oplog:export', {})
    const d = new Date()
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(exportNames[0]).toBe(`forge-neo-client-log-${local}.jsonl`)
  })

  test('a cancelled save dialog writes nothing', async () => {
    seed()
    expect(await call('oplog:export', {})).toBe(false)
    expect(oplog.list({ category: 'backup' })).toEqual([])
  })

  test('retention defaults to 90 days; a change is saved, validated and logged as a settings change', async () => {
    expect(await call('oplog:retention')).toBe(90)
    await call('oplog:setRetention', 30)
    expect(await call('oplog:retention')).toBe(30)
    expect(repos.settings.get('oplog.retentionDays')).toBe('30')
    expect(oplog.list({ category: 'settings' })[0]).toMatchObject({
      messageKey: 'log.settings.changed', details: { key: 'oplog.retentionDays', old: 90, new: 30 },
    })
    for (const bad of [0, 3651, 1.5, '30', null]) {
      await expect(call('oplog:setRetention', bad)).rejects.toThrow('error.invalidParams')
    }
  })

  test('new entries are pushed live through the listener', () => {
    const pushed: unknown[] = []
    const live = createOplog(db, () => 5, (e) => pushed.push(e))
    live.write({ level: 'info', category: 'app', messageKey: 'log.app.started' })
    expect(pushed).toEqual([expect.objectContaining({ messageKey: 'log.app.started', time: 5 })])
  })
})

test('jobs:get returns any stored job, with its error; unknown ids are error.notFound', async () => {
  const s = repos.servers.setActiveUrl(mock.url)
  const job = repos.jobs.insert(s.id, 'txt2img', goodParams())
  repos.jobs.setStatus(job.id, 'failed', { error: { code: 'forgeHttp', status: 500, detail: 'TypeError: x' } })
  expect(await call('jobs:get', job.id)).toMatchObject({ id: job.id, status: 'failed', error: { code: 'forgeHttp', status: 500, detail: 'TypeError: x' } })
  await expect(call('jobs:get', 999)).rejects.toThrow('error.notFound')
  await expect(call('jobs:get', 'x')).rejects.toThrow('error.invalidParams')
})

describe('images:query', () => {
  const ids = async (q: unknown) => ((await call('images:query', q)) as { id: number }[]).map((r) => r.id)

  test('filters by text and tags, newest first, with each record carrying its tags', async () => {
    const a = seedImage().row.id
    const b = seedImage().row.id
    repos.tags.add([a], ['night', 'cat'])
    const list = (await call('images:query', { limit: 10 })) as { id: number; tags: string[]; locked: boolean }[]
    expect(list.map((r) => [r.id, r.tags, r.locked])).toEqual([[b, [], false], [a, ['cat', 'night'], false]])
    expect(await ids({ limit: 10, text: '  A CAT  ' })).toEqual([b, a])
    expect(await ids({ limit: 10, tags: ['  NIGHT '] })).toEqual([a])
  })

  test('limit is clamped to 1..200', async () => {
    const all = Array.from({ length: 3 }, () => seedImage().row.id).reverse()
    expect(await ids({ limit: 0 })).toEqual([all[0]])
    expect(await ids({ limit: -5 })).toEqual([all[0]])
    expect(await ids({ limit: 1e9 })).toEqual(all)
    expect(await ids({ limit: 2.7 })).toEqual(all.slice(0, 2))
  })

  test.each([
    ['not an object', 5],
    ['a limit that is not a number', { limit: '10' }],
    ['an infinite limit', { limit: Infinity }],
    ['a zero cursor', { limit: 10, beforeId: 0 }],
    ['a negative cursor', { limit: 10, beforeId: -1 }],
    ['a fractional cursor', { limit: 10, beforeId: 1.5 }],
    ['text that is not a string', { limit: 10, text: 5 }],
    ['text over 500 characters', { limit: 10, text: 'x'.repeat(501) }],
    ['tags that are not a list', { limit: 10, tags: 'cat' }],
    ['more than 20 tags', { limit: 10, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ['a tag that is not a string', { limit: 10, tags: [5] }],
    ['an empty tag', { limit: 10, tags: ['   '] }],
    ['a tag over 40 characters', { limit: 10, tags: ['x'.repeat(41)] }],
  ])('refuses %s with error.invalidParams', async (_name, q) => {
    await expect(call('images:query', q)).rejects.toThrow('error.invalidParams')
  })

  test('text of 500 characters after trimming, 20 tags and a 40-character tag are accepted', async () => {
    await expect(call('images:query', { limit: 10, text: ` ${'x'.repeat(500)} ` })).resolves.toEqual([])
    await expect(call('images:query', { limit: 10, tags: Array.from({ length: 20 }, (_, i) => `t${i}`) })).resolves.toEqual([])
    await expect(call('images:query', { limit: 10, tags: [`  ${'x'.repeat(40)}  `] })).resolves.toEqual([])
  })

  test('beforeId pages through a tag filter while hidden images stay out', async () => {
    const all = Array.from({ length: 5 }, () => seedImage().row.id)
    repos.tags.add(all, ['t'])
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [all[2]], true)
    expect(await ids({ limit: 2, tags: ['t'] })).toEqual([all[4], all[3]])
    expect(await ids({ limit: 2, tags: ['t'], beforeId: all[3] })).toEqual([all[1], all[0]])
  })
})

describe('hidden images and the lock', () => {
  const record = async (id: number) =>
    ((await call('images:list', { limit: 100 })) as Record<string, unknown>[]).find((r) => r['id'] === id)!

  test('while locked a hidden image is a redacted row; text and tag queries skip it; details refuse it', async () => {
    const { row } = seedImage()
    repos.tags.add([row.id], ['secret-tag'])
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    expect(await record(row.id)).toEqual({
      id: row.id, jobId: 0, width: 64, height: 64, createdAt: row.createdAt, durationMs: 1, hidden: true,
      sourceImageId: null, enhanced: false, url: '', thumbUrl: '', infotext: '', seed: 0, tags: [], locked: true,
    })
    expect(await call('images:query', { limit: 10, text: 'cat' })).toEqual([])
    expect(await call('images:query', { limit: 10, tags: ['secret-tag'] })).toEqual([])
    await expect(call('images:details', row.id)).rejects.toThrow('error.notFound')
  })

  test('with the lock open the hidden image comes back whole, with its tags, and details work', async () => {
    const { row } = seedImage()
    repos.tags.add([row.id], ['secret-tag'])
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    await call('lock:open', 'secret-pass')
    expect(await record(row.id)).toMatchObject({
      hidden: true, locked: false, url: `fnc-img://local/image/${row.id}`, seed: 5, infotext: 'i', tags: ['secret-tag'],
    })
    expect(await call('images:query', { limit: 10, tags: ['secret-tag'] })).toHaveLength(1)
    expect(await call('images:details', row.id)).toMatchObject({ image: { id: row.id, locked: false }, params: { prompt: 'a cat' } })
    await call('lock:close')
    await expect(call('images:details', row.id)).rejects.toThrow('error.notFound')
  })

  test('hiding needs a password to be set first', async () => {
    const { row } = seedImage()
    await expect(call('images:setHidden', [row.id], true)).rejects.toThrow('error.noPassword')
    expect(repos.images.get(row.id)!.hidden).toBe(false)
    expect(sentOf('images:changed')).toEqual([])
  })

  test('hiding while locked works without the password, logs ids only and pushes images:changed', async () => {
    const a = seedImage().row.id
    const b = seedImage().row.id
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [a, b, a, 999], true)
    expect(repos.images.get(a)!.hidden).toBe(true)
    expect(repos.images.get(b)!.hidden).toBe(true)
    expect(sentOf('images:changed')).toEqual([{ ids: [a, b] }])
    expect(oplog.list({ category: 'storage' })[0]).toMatchObject({
      messageKey: 'log.storage.imagesHidden', details: { ids: [a, b], count: 2 },
    })
    expect(JSON.stringify(oplog.list())).not.toContain('a cat')
  })

  test('unhiding needs the lock open', async () => {
    const { row } = seedImage()
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    await expect(call('images:setHidden', [row.id], false)).rejects.toThrow('error.notFound')
    expect(repos.images.get(row.id)!.hidden).toBe(true)
    await call('lock:open', 'secret-pass')
    await call('images:setHidden', [row.id], false)
    expect(repos.images.get(row.id)!.hidden).toBe(false)
    expect(oplog.list({ category: 'storage' })[0]).toMatchObject({ messageKey: 'log.storage.imagesUnhidden' })
  })

  test.each([
    [[], true], [[0], true], [[1.5], true], ['1', true], [[1], 'yes'], [Array.from({ length: 1001 }, (_, i) => i + 1), true],
  ])('setHidden refuses ids %j with hidden %j', async (ids, hidden) => {
    await lock.setPassword(null, 'secret-pass')
    await expect(call('images:setHidden', ids, hidden)).rejects.toThrow('error.invalidParams')
  })

  test('lock calls push the new state; a wrong password is error.wrongPassword and changes nothing', async () => {
    expect(await call('lock:state')).toEqual({ hasPassword: false, open: false })
    await expect(call('lock:setPassword', null, 'abc')).rejects.toThrow('error.invalidParams')
    await call('lock:setPassword', null, 'secret-pass')
    expect(sentOf('lock')).toEqual([{ hasPassword: true, open: false }])
    await expect(call('lock:open', 'bad-guess')).rejects.toThrow('error.wrongPassword')
    expect(sentOf('lock')).toHaveLength(1)
    await call('lock:open', 'secret-pass')
    await call('lock:close')
    expect(sentOf('lock').slice(1)).toEqual([{ hasPassword: true, open: true }, { hasPassword: true, open: false }])
    await expect(call('lock:setPassword', 'bad-guess', 'new-pass')).rejects.toThrow('error.wrongPassword')
    await call('lock:setPassword', 'secret-pass', 'new-pass')
    await expect(call('lock:open', 5)).rejects.toThrow('error.invalidParams')
    await expect(call('lock:setPassword', 5, 'new-pass')).rejects.toThrow('error.invalidParams')
    expect(JSON.stringify(oplog.list())).not.toMatch(/secret-pass|new-pass|bad-guess/)
  })
})

describe('fix round 1: nothing of a hidden image leaks while locked', () => {
  test('jobs:get refuses the job of a hidden image while locked and returns it whole once open', async () => {
    const { row } = seedImage()
    const other = seedImage().row
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    await expect(call('jobs:get', row.jobId)).rejects.toThrow('error.notFound')
    expect(await call('jobs:get', other.jobId)).toMatchObject({ id: other.jobId, params: { prompt: 'a cat' } })
    await call('lock:open', 'secret-pass')
    expect(await call('jobs:get', row.jobId)).toMatchObject({ id: row.jobId, params: { prompt: 'a cat' } })
  })

  test('a redacted row carries no real job id', async () => {
    const { row } = seedImage()
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    const list = (await call('images:list', { limit: 10 })) as { id: number; jobId: number }[]
    expect(list.find((r) => r.id === row.id)!.jobId).toBe(0)
    expect(row.jobId).toBeGreaterThan(0)
  })

  test('images:delete refuses a hidden image while locked and deletes it once open', async () => {
    const { row, filePath } = seedImage()
    await lock.setPassword(null, 'secret-pass')
    await call('images:setHidden', [row.id], true)
    await expect(call('images:delete', row.id)).rejects.toThrow('error.notFound')
    expect(repos.images.get(row.id)).not.toBeNull()
    expect(existsSync(filePath)).toBe(true)
    expect(sentOf('image:removed')).toEqual([])
    await call('lock:open', 'secret-pass')
    await call('images:delete', row.id)
    expect(repos.images.get(row.id)).toBeNull()
  })

  test('a lockout answers error.tooManyAttempts', async () => {
    await call('lock:setPassword', null, 'secret-pass')
    for (let i = 0; i < 4; i++) await expect(call('lock:open', 'bad-guess')).rejects.toThrow('error.wrongPassword')
    await expect(call('lock:open', 'bad-guess')).rejects.toThrow('error.tooManyAttempts')
    await expect(call('lock:open', 'secret-pass')).rejects.toThrow('error.tooManyAttempts')
  })
})

test('jobs:clearUnfinished removes failed jobs and tells the renderer', async () => {
  const server = repos.servers.setActiveUrl('http://a:7860')
  const job = repos.jobs.insert(server.id, 'txt2img', {
    family: 'sdxl', checkpoint: 'm', modules: [], prompt: 'p', negativePrompt: '', width: 64, height: 64, steps: 1,
    cfgScale: 1, distilledCfg: 1, shift: null, clipSkip: null, sampler: 's', scheduler: 'a', seed: 1, count: 1, loras: [],
  })
  repos.jobs.setStatus(job.id, 'failed')
  expect(await call('jobs:clearUnfinished')).toBe(1)
  expect(repos.jobs.get(job.id)).toBeNull()
  expect(sent.some((s) => s.e === 'job:removed' && (s.p as { id: number }).id === job.id)).toBe(true)
})

test('a family negative is saved, reported by settings:get, validated and cleared with its preset', async () => {
  const preset = (await call('negativePresets:add', { name: 'Anima base', text: 'worst quality' })) as { id: number }
  await call('settings:setFamilyNegative', 'anima', preset.id)
  expect(((await call('settings:get')) as { familyNegatives: Record<string, number> }).familyNegatives).toEqual({ anima: preset.id })
  await expect(call('settings:setFamilyNegative', 'nope', preset.id)).rejects.toThrow('error.invalidParams')
  await expect(call('settings:setFamilyNegative', 'anima', 999)).rejects.toThrow('error.notFound')
  await call('negativePresets:remove', preset.id)
  expect(((await call('settings:get')) as { familyNegatives: Record<string, number> }).familyNegatives).toEqual({})
  const again = (await call('negativePresets:add', { name: 'Other', text: 'x' })) as { id: number }
  await call('settings:setFamilyNegative', 'sdxl', again.id)
  await call('settings:setFamilyNegative', 'sdxl', null)
  expect(((await call('settings:get')) as { familyNegatives: Record<string, number> }).familyNegatives).toEqual({})
})

describe('model marks', () => {
  const SDXL_FILE = String.raw`C:\forge\models\Stable-diffusion\sd_xl_base.safetensors`
  const LORA_PATH = String.raw`C:\forge\models\Lora\detail_tweaker.safetensors`

  beforeEach(() => { repos.servers.setActiveUrl(mock.url) })

  test('favorite, note, family and trigger words are saved per file and show in the catalog without a refetch', async () => {
    await call('models:setFavorite', 'checkpoint', SDXL_FILE, true)
    await call('models:setNote', 'checkpoint', SDXL_FILE, '  my base  ')
    await call('models:setFamily', SDXL_FILE, 'qwen')
    await call('models:setFavorite', 'lora', LORA_PATH, true)
    await call('models:setTriggers', 'lora', LORA_PATH, ['my word', 'my word', ' other '])
    const before = mock.requests.length
    const catalog = (await call('catalog:get')) as Catalog
    expect(mock.requests.length).toBe(before)
    expect(catalog.checkpoints.find((c) => c.filename === SDXL_FILE)).toMatchObject({
      favorite: true, note: 'my base', family: 'qwen', familyOverridden: true,
    })
    expect(catalog.loras.find((l) => l.path === LORA_PATH)).toMatchObject({
      favorite: true, triggers: ['my word', 'other'], triggersEdited: true,
    })
    expect(oplog.list().some((e) => e.messageKey === 'log.checkpoint.familyChanged')).toBe(true)
    await call('models:setFamily', SDXL_FILE, null)
    await call('models:setTriggers', 'lora', LORA_PATH, null)
    const reset = (await call('catalog:get')) as Catalog
    expect(reset.checkpoints.find((c) => c.filename === SDXL_FILE)).toMatchObject({ family: 'sdxl', familyOverridden: false })
    expect(reset.loras.find((l) => l.path === LORA_PATH)).toMatchObject({ triggers: ['1girl', 'detailed skin', 'sharp'], triggersEdited: false })
  })

  test('unknown files and malformed values are refused', async () => {
    await expect(call('models:setFavorite', 'checkpoint', 'C:\nope.safetensors', true)).rejects.toThrow('error.notFound')
    await expect(call('models:setFavorite', 'other', SDXL_FILE, true)).rejects.toThrow('error.invalidParams')
    await expect(call('models:setFavorite', 'lora', LORA_PATH, 'yes')).rejects.toThrow('error.invalidParams')
    await expect(call('models:setNote', 'lora', LORA_PATH, 'x'.repeat(2001))).rejects.toThrow('error.invalidParams')
    await expect(call('models:setFamily', SDXL_FILE, 'nope')).rejects.toThrow('error.invalidParams')
    await expect(call('models:setTriggers', 'lora', LORA_PATH, [''])).rejects.toThrow('error.invalidParams')
    await expect(call('models:setTriggers', 'lora', LORA_PATH, 'a')).rejects.toThrow('error.invalidParams')
    await expect(call('models:setTriggers', 'other', LORA_PATH, ['a'])).rejects.toThrow('error.invalidParams')
  })

  test('an explicit catalog refresh forgets the "no preview" answers', async () => {
    const server = repos.servers.active()!
    repos.modelMeta.setPreview(server.id, 'checkpoint', SDXL_FILE, '')
    await call('catalog:get', true)
    expect(repos.modelMeta.get(server.id, 'checkpoint', SDXL_FILE)?.preview).toBeNull()
  })
})

test('hires presets: add, list ordered, duplicate name refused, rename, remove; malformed settings refused', async () => {
  const hires = { scale: 2, upscaler: 'Latent', secondPassSteps: 10, denoisingStrength: 0.45, cfgScale: 4, junk: 1 }
  const a = (await call('hiresPresets:add', { name: ' Soft ', settings: hires })) as { id: number; name: string; settings: object }
  expect(a.name).toBe('Soft')
  expect(a.settings).toEqual({ scale: 2, upscaler: 'Latent', secondPassSteps: 10, denoisingStrength: 0.45, cfgScale: 4 })
  await expect(call('hiresPresets:add', { name: 'soft', settings: hires })).rejects.toThrow('error.presetNameTaken')
  await expect(call('hiresPresets:add', { name: 'Bad', settings: { ...hires, scale: 3 } })).rejects.toThrow('error.invalidParams')
  await expect(call('hiresPresets:add', { name: '', settings: hires })).rejects.toThrow('error.invalidParams')
  const b = (await call('hiresPresets:add', { name: 'Alpha', settings: { ...hires, scale: 1.5 } })) as { id: number }
  expect(((await call('hiresPresets:list')) as { name: string }[]).map((p) => p.name)).toEqual(['Alpha', 'Soft'])
  expect(((await call('hiresPresets:rename', b.id, 'Zeta')) as { name: string }).name).toBe('Zeta')
  await call('hiresPresets:remove', a.id)
  expect(((await call('hiresPresets:list')) as { name: string }[]).map((p) => p.name)).toEqual(['Zeta'])
  await expect(call('hiresPresets:remove', a.id)).rejects.toThrow('error.notFound')
  expect(JSON.stringify(oplog.list())).toContain('log.preset.hiresCreated')
})

test('tags: add, suggest, remove; hidden images are left alone while locked; bad input is refused', async () => {
  const { row } = seedImage()
  await call('tags:add', [row.id], [' Night ', 'sea', 'night'])
  expect(sent.some((s) => s.e === 'images:changed')).toBe(true)
  const withTags = (await call('images:query', { limit: 10, tags: ['night'] })) as { id: number; tags: string[] }[]
  expect(withTags.map((i) => i.id)).toEqual([row.id])
  expect(withTags[0]!.tags).toEqual(['Night', 'sea'])
  expect(await call('tags:suggest', 'n')).toEqual(['Night'])
  expect(await call('tags:suggest', 'zzz')).toEqual([])
  await call('tags:remove', [row.id], ['NIGHT'])
  expect(await call('tags:suggest', 'n')).toEqual([])
  repos.images.setHidden([row.id], true)
  await call('tags:add', [row.id], ['secret'])
  expect(repos.tags.forImages([row.id]).get(row.id)).toEqual(['sea'])
  await expect(call('tags:add', [], ['x'])).rejects.toThrow('error.invalidParams')
  await expect(call('tags:add', [row.id], 'x')).rejects.toThrow('error.invalidParams')
  await expect(call('tags:add', ['a'], ['x'])).rejects.toThrow('error.invalidParams')
  await expect(call('tags:suggest', 5)).rejects.toThrow('error.invalidParams')
})

describe('model previews from generations', () => {
  const CKPT_FILE = ['C:', 'forge', 'models', 'Stable-diffusion', 'sd_xl_base.safetensors'].join(String.fromCharCode(92))
  beforeEach(() => { repos.servers.setActiveUrl(mock.url) })

  test('the generations of a checkpoint are its visible images, and one can become its preview (thumbnail bytes)', async () => {
    const catalog = (await call('catalog:get')) as Catalog
    const title = catalog.checkpoints.find((c) => c.filename === CKPT_FILE)!.title
    const server = repos.servers.active()!
    const job = repos.jobs.insert(server.id, 'txt2img', { ...goodParams(), checkpoint: title })
    repos.jobs.setStatus(job.id, 'done')
    mkdirSync(path.join(dir, 'thumbs'), { recursive: true })
    const thumbPath = path.join(dir, 'thumbs', 'gen.jpg')
    writeFileSync(thumbPath, 'jpg-thumb')
    const row = repos.images.insert({ jobId: job.id, filePath: path.join(dir, 'x.png'), thumbPath, width: 8, height: 8, seed: 1, infotext: '', durationMs: 1 })
    const hiddenRow = repos.images.insert({ jobId: job.id, filePath: path.join(dir, 'y.png'), thumbPath, width: 8, height: 8, seed: 2, infotext: '', durationMs: 1, hidden: true })
    const list = (await call('models:generations', 'checkpoint', CKPT_FILE)) as { id: number; url: string }[]
    expect(list.map((i) => i.id)).toEqual([row.id])
    expect(list[0]!.url).toContain('fnc-img://')
    await call('models:setPreviewFromImage', 'checkpoint', CKPT_FILE, row.id)
    expect(customPreviews).toHaveLength(1)
    expect(customPreviews[0]).toMatchObject({ kind: 'checkpoint', file: CKPT_FILE, bytes: 'jpg-thumb' })
    await expect(call('models:setPreviewFromImage', 'checkpoint', CKPT_FILE, hiddenRow.id)).rejects.toThrow('error.notFound')
    await expect(call('models:setPreviewFromImage', 'checkpoint', CKPT_FILE, 9999)).rejects.toThrow('error.notFound')
    await expect(call('models:setPreviewFromImage', 'checkpoint', 'C:\nope', row.id)).rejects.toThrow('error.notFound')
    await expect(call('models:setPreviewFromImage', 'checkpoint', CKPT_FILE, 'x')).rejects.toThrow('error.invalidParams')
    await call('models:clearPreview', 'checkpoint', CKPT_FILE)
    expect(clearedPreviews).toEqual([CKPT_FILE])
  })
})

describe('civitai lookup', () => {
  const LORA_PATH = ['C:', 'forge', 'models', 'Lora', 'detail_tweaker.safetensors'].join(String.fromCharCode(92))
  const LORA_STYLE = ['C:', 'forge', 'models', 'Lora', 'style_anima.safetensors'].join(String.fromCharCode(92))
  const LORA_NOHASH = ['C:', 'forge', 'models', 'Lora', 'nohash.safetensors'].join(String.fromCharCode(92))
  const LORA_HASH = 'b'.repeat(64)
  const answer = {
    modelId: 7, versionId: 70, name: 'Detail Tweaker', versionName: 'v2', baseModel: 'Illustrious',
    trainedWords: ['civi word'], imageUrl: null, checkedAt: 1,
  }

  beforeEach(() => { repos.servers.setActiveUrl(mock.url) })

  test('nothing is looked up until the user switches it on', async () => {
    await expect(call('civitai:update')).rejects.toThrow('error.invalidParams')
    expect(civitaiAsked).toEqual([])
    expect(((await call('settings:get')) as { civitaiEnabled: boolean }).civitaiEnabled).toBe(false)
    await expect(call('civitai:setEnabled', 'yes')).rejects.toThrow('error.invalidParams')
  })

  test('with consent files are looked up by hash; answers are kept, shown in the catalog and openable', async () => {
    mock.respond('/sdapi/v1/loras', { json: [{ name: 'detail_tweaker', alias: 'detail_tweaker', path: LORA_PATH,
      metadata: { sshs_model_hash: LORA_HASH } }] })
    civitaiAnswers.set(LORA_HASH, answer)
    await call('catalog:get', true)
    await call('civitai:setEnabled', true)
    await call('civitai:update')
    await vi.waitFor(() => expect(sent.filter((s) => s.e === 'civitai:progress').some((s) => (s.p as { running: boolean; done: number }).done > 0)).toBe(true))
    await vi.waitFor(async () => expect(((await call('civitai:state')) as { running: boolean }).running).toBe(false))
    expect(civitaiAsked).toContain(LORA_HASH)
    const catalog = (await call('catalog:get')) as Catalog
    const lora = catalog.loras.find((l) => l.path === LORA_PATH)!
    expect(lora).toMatchObject({ triggers: ['civi word'], baseFamily: 'sdxl', hash: LORA_HASH,
      civitai: { url: 'https://civitai.com/models/7?modelVersionId=70', name: 'Detail Tweaker' } })
    await call('civitai:open', 'lora', LORA_PATH)
    expect(openedUrls).toEqual(['https://civitai.com/models/7?modelVersionId=70'])
    await expect(call('civitai:open', 'lora', 'C:\nope')).rejects.toThrow('error.notFound')
  })

  test('one file can be updated on its own: needs consent, reports found / unknown / no hash', async () => {
    mock.respond('/sdapi/v1/loras', { json: [
      { name: 'detail_tweaker', alias: 'detail_tweaker', path: LORA_PATH, metadata: { sshs_model_hash: LORA_HASH } },
      { name: 'style_anima', alias: 'style_anima', path: LORA_STYLE, metadata: { sshs_model_hash: 'c'.repeat(64) } },
      { name: 'nohash', alias: 'nohash', path: LORA_NOHASH, metadata: {} },
    ] })
    civitaiAnswers.set(LORA_HASH, answer)
    await call('catalog:get', true)
    await expect(call('civitai:updateOne', 'lora', LORA_PATH)).rejects.toThrow('error.invalidParams')
    await call('civitai:setEnabled', true)
    expect(await call('civitai:updateOne', 'lora', LORA_PATH)).toBe('found')
    expect(await call('civitai:updateOne', 'lora', LORA_STYLE)).toBe('missing')
    expect(await call('civitai:updateOne', 'lora', LORA_NOHASH)).toBe('noHash')
    await expect(call('civitai:updateOne', 'lora', 'C:' + String.fromCharCode(92) + 'nope')).rejects.toThrow('error.notFound')
    expect(civitaiAsked).toEqual([LORA_HASH, 'c'.repeat(64)])
    const lora = ((await call('catalog:get')) as Catalog).loras.find((l) => l.path === LORA_PATH)!
    expect(lora.triggers).toEqual(['civi word'])
  })

  test('switching it off is logged', async () => {
    await call('civitai:setEnabled', true)
    await call('civitai:setEnabled', false)
    expect(oplog.list().map((e) => e.messageKey)).toEqual(expect.arrayContaining(['log.civitai.enabled', 'log.civitai.disabled']))
  })
})

test('job tags are cleaned on the way in and refused when malformed', async () => {
  repos.servers.setActiveUrl(mock.url)
  const jobs = (await call('jobs:enqueue', goodParams({ tags: ['  Night ', 'night', 'sea'] } as never))) as { params: { tags?: string[] } }[]
  expect(jobs[0]!.params.tags).toEqual(['Night', 'sea'])
  const plain = (await call('jobs:enqueue', goodParams({ tags: [] } as never))) as { params: { tags?: string[] } }[]
  expect(plain[0]!.params).not.toHaveProperty('tags')
  await expect(call('jobs:enqueue', goodParams({ tags: ['x'.repeat(41)] } as never))).rejects.toThrow('error.invalidParams')
  await expect(call('jobs:enqueue', goodParams({ tags: 'sea' } as never))).rejects.toThrow('error.invalidParams')
  await expect(call('jobs:enqueue', goodParams({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } as never))).rejects.toThrow('error.invalidParams')
})
