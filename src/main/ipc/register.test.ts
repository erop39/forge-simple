import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultParams } from '@shared/profiles'
import type { AppEvents } from '@shared/ipc'
import type { GenerationParams } from '@shared/types'
import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'
import { createActiveForge } from '../forge/active-forge'
import { createForgeClient } from '../forge/client'
import { createConnectionMonitor } from '../forge/connection'
import { FINDINGS } from '../forge/findings'
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
let runner: ReturnType<typeof createRunner>
let kicks: number
let samples: number
let serverChanges: number
let removeFails: boolean
let catalogThrows: boolean
let imageStore: ReturnType<typeof createImageStore>
let forgeRef: ReturnType<typeof createActiveForge>

beforeEach(async () => {
  mock = await startMockForge({ stepMs: 5 })
  db = openDb(':memory:')
  dir = mkdtempSync(path.join(tmpdir(), 'fnc-ipc-'))
  const now = () => 1000
  repos = createRepos(db, now)
  oplog = createOplog(db, now)
  const forge = createActiveForge({
    activeUrl: () => repos.servers.active()?.url ?? null, familyOverride: () => null, oplog, now,
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
  const send = <K extends keyof AppEvents>(e: K, p: AppEvents[K]): void => { sent.push({ e, p }) }
  registerIpc(
    { handle: (ch, fn) => { handlers.set(ch, fn as never) } },
    {
      repos,
      catalog: () => (catalogThrows ? { get: () => Promise.reject(new TypeError('boom')) } : forge.catalog()),
      onServerChanged: () => { serverChanges++ },
      runner, monitor, images, oplog, imagesDir: () => dir,
      createClient: (url) => createForgeClient(url, { pingTimeoutMs: 500 }),
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

test('settings:setServerUrl normalizes, saves and returns ok with latency', async () => {
  const res = (await call('settings:setServerUrl', ` ${mock.url.replace('http://', '')}/ `)) as {
    ok: boolean; latencyMs: number; errorKey: null
  }
  expect(res.ok).toBe(true)
  expect(res.latencyMs).toBeGreaterThanOrEqual(0)
  expect(res.errorKey).toBeNull()
  expect(repos.servers.active()?.url).toBe(mock.url)
  expect(await call('settings:get')).toEqual({ serverUrl: mock.url, imagesDir: dir })
  expect(kicks).toBe(1)
  expect(serverChanges).toBe(1)
  expect(samples).toBe(1)
})

test('settings:setServerUrl on a dead address returns ok:false with errorKey "error.network" and does not save', async () => {
  expect(await call('settings:setServerUrl', DEAD)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
  expect(await call('settings:setServerUrl', 'ftp://nope')).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
  expect(repos.servers.active()).toBeNull()
  expect(kicks).toBe(0)
})

test('settings:setServerUrl on a non-Forge address returns errorKey "error.notForge"', async () => {
  mock.respond('/sdapi/v1/progress', { json: { hello: 'world' } })
  expect(await call('settings:setServerUrl', mock.url)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.notForge' })
  mock.respond('/sdapi/v1/progress', { status: 404, json: { detail: 'Not Found' } })
  expect(await call('settings:setServerUrl', mock.url)).toEqual({ ok: false, latencyMs: null, errorKey: 'error.notForge' })
  expect(repos.servers.active()).toBeNull()
})

test('settings change is logged with old and new value', async () => {
  repos.servers.setActiveUrl('http://old.test')
  await call('settings:setServerUrl', mock.url)
  const entry = oplog.list({ category: 'settings' })[0]!
  expect(entry.messageKey).toBe('log.settings.serverChanged')
  expect(entry.details).toEqual({ key: 'serverUrl', old: 'http://old.test', new: mock.url })
})

test('jobs:enqueue rejects params with count outside 1..8 or an empty prompt', async () => {
  await call('settings:setServerUrl', mock.url)
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
  await call('settings:setServerUrl', mock.url)
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
    id: row.id, url: 'fnc-img://local/2026-10/1-5.png', thumbUrl: 'fnc-img://local/thumbs/1-5.jpg',
  })
  expect(list[0]).not.toHaveProperty('filePath')
  await expect(call('images:list', { limit: 'x' })).rejects.toThrow('error.invalidParams')
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
  await call('settings:setServerUrl', mock.url)
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
  }, () => undefined)
  const err = await h.get('jobs:listActive')!({}).catch((e: Error) => e)
  expect((err as Error).message).toBe('error.unexpected')
  expect(spy).toHaveBeenCalledWith('ipc: jobs:listActive failed', boom)
  spy.mockRestore()
})

test('forwardEvents sends job events and converts ImageRow to ImageRecord without paths', () => {
  const out: { e: string; p: Record<string, unknown> }[] = []
  const ev = forwardEvents(() => dir, ((e: string, p: Record<string, unknown>) => { out.push({ e, p }) }) as never)
  const { row } = seedImage()
  ev.runner.imageAdded(row)
  ev.runner.jobUpdate({ id: 1 } as never)
  ev.runner.jobProgress({ jobId: 1 } as never)
  ev.connection({ state: 'connected', latencyMs: 1, attempts: 0, lastOkAt: 1 })
  expect(out.map((o) => o.e)).toEqual(['image:added', 'job:update', 'job:progress', 'connection'])
  expect(out[0]!.p).toMatchObject({ id: row.id, url: 'fnc-img://local/2026-10/1-5.png', thumbUrl: 'fnc-img://local/thumbs/1-5.jpg' })
  expect(out[0]!.p).not.toHaveProperty('filePath')
  expect(out[0]!.p).not.toHaveProperty('thumbPath')
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
  ]
  test.each(rejections)('rejects %s', async (_name, over) => {
    await call('settings:setServerUrl', mock.url)
    await expect(call('jobs:enqueue', goodParams(over))).rejects.toThrow('error.invalidParams')
    expect(repos.jobs.listActive()).toEqual([])
  })

  test('drops unknown extra keys', async () => {
    await call('settings:setServerUrl', mock.url)
    const jobs = (await call('jobs:enqueue', { ...goodParams(), evil: 'x', loras: [{ name: 'l', weight: 1, enabled: true, extra: 1 }] })) as { params: Record<string, unknown> }[]
    expect(jobs[0]!.params).not.toHaveProperty('evil')
    expect(jobs[0]!.params.loras).toEqual([{ name: 'l', weight: 1, enabled: true }])
  })
})
