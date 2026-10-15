import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'
import { openDb, type Db } from '../storage/db'
import { createOplog, type Oplog } from '../oplog/oplog'
import { createForgeClient } from './client'
import { checkParts, createCatalog, moduleValue } from './catalog'
import type { Catalog, Family, GenerationParams } from '@shared/types'
import type { ProbeFindings } from './findings'

let mock: MockForge
let db: Db
let log: Oplog

beforeEach(async () => {
  mock = await startMockForge({ stepMs: 10 })
  db = openDb(':memory:')
  log = createOplog(db, () => 5000)
})

afterEach(async () => {
  await mock.close()
  if (db.open) db.close()
})

function make(override: (f: string) => Family | null = () => null) {
  return createCatalog({
    client: () => createForgeClient(mock.url),
    familyOverride: override,
    oplog: log,
    now: () => 1234,
  })
}

const listPaths = () => mock.requests.filter((r) => r.method === 'GET').map((r) => r.path)

test('get() loads every list once and caches it', async () => {
  const cat = make()
  const first = await cat.get()
  const count = mock.requests.length
  expect(count).toBeGreaterThanOrEqual(7)
  const second = await cat.get()
  expect(mock.requests.length).toBe(count)
  expect(second).toEqual(first)
  expect(first.fetchedAt).toBe(1234)
  expect(first.checkpoints).toHaveLength(2)
  expect(first.modules).toHaveLength(2)
  expect(first.loras).toMatchObject([
    { name: 'detail_tweaker', path: String.raw`C:\forge\models\Lora\detail_tweaker.safetensors`, baseFamily: 'sdxl',
      triggers: ['1girl', 'detailed skin', 'sharp'], triggersEdited: false, favorite: false },
    { name: 'style_anima', baseFamily: 'anima', triggers: [] },
  ])
  expect(first.samplers).toEqual(['Euler', 'Euler a'])
  expect(first.schedulers).toEqual(['Automatic', 'Simple'])
  expect(first.upscalers).toEqual(['Latent', 'R-ESRGAN 4x+'])
})

test('get(true) refetches', async () => {
  const cat = make()
  await cat.get()
  const count = mock.requests.length
  await cat.get(true)
  expect(mock.requests.length).toBe(count * 2)
})

test('concurrent get() calls share one fetch', async () => {
  const cat = make()
  const [a, b] = await Promise.all([cat.get(), cat.get()])
  expect(a).toEqual(b)
  expect(listPaths().filter((p) => p === '/sdapi/v1/sd-models')).toHaveLength(1)
})

test('family comes from the override, else from detectFamily', async () => {
  const cat = make((f) => (f.endsWith('sd_xl_base.safetensors') ? 'qwen' : null))
  const c = await cat.get()
  const byName = Object.fromEntries(c.checkpoints.map((x) => [x.name, x]))
  expect(byName['sd_xl_base']).toMatchObject({
    title: String.raw`sdxl\sd_xl_base.safetensors [31e35c80fc]`,
    filename: String.raw`C:\forge\models\Stable-diffusion\sd_xl_base.safetensors`,
    family: 'qwen',
  })
  expect(byName['krea2_turbo_fp8']?.family).toBe('krea2')
})

test('familyModules come from the per-preset options; non-string-array values are dropped', async () => {
  const c = await make().get()
  expect(c.familyModules).toEqual({ sdxl: [], krea2: [String.raw`C:\forge\models\VAE\ae.safetensors`, String.raw`C:\forge\models\text_encoder\clip_l.safetensors`] })
  mock.respond('/sdapi/v1/options', {
    json: { forge_additional_modules_zit: ['a'], forge_additional_modules_qwen: 'x', forge_additional_modules_lumina: [1], forge_additional_modules_anima: ['b', 'c'] },
  })
  expect((await make().get(true)).familyModules).toEqual({ zimage: ['a'], anima: ['b', 'c'] })
})

test('family is computed from the title, folders included', async () => {
  const c = await make().get()
  expect(c.checkpoints.map((x) => [x.title, x.family])).toEqual([
    [String.raw`sdxl\sd_xl_base.safetensors [31e35c80fc]`, 'sdxl'],
    [String.raw`krea2\krea2_turbo_fp8.safetensors [a1b2c3d4e5]`, 'krea2'],
  ])
})

test('a failing loras() is non-fatal: empty list and a warn entry', async () => {
  mock.respond('/sdapi/v1/loras', { status: 500, json: { detail: 'boom' } })
  const c = await make().get()
  expect(c.loras).toEqual([])
  expect(c.checkpoints).toHaveLength(2)
  const [w] = log.list({ category: 'catalog' }).filter((e) => e.level === 'warn')
  expect(w).toMatchObject({ messageKey: 'log.catalog.lorasFailed', details: { kind: 'http', status: 500 } })
})

test('a hanging loras() times out without failing the catalog', async () => {
  mock.respond('/sdapi/v1/loras', { hang: true })
  const cat = createCatalog({
    client: () => createForgeClient(mock.url, { lorasTimeoutMs: 50 }),
    familyOverride: () => null, oplog: log, now: () => 1234,
  })
  const c = await cat.get()
  expect(c.loras).toEqual([])
  const [w] = log.list({ category: 'catalog' }).filter((e) => e.level === 'warn')
  expect(w).toMatchObject({ messageKey: 'log.catalog.lorasFailed', details: { kind: 'timeout', status: null } })
})

test('loadedCheckpoint is read from options.sd_model_checkpoint', async () => {
  const c = await make().get()
  expect(c.loadedCheckpoint).toBe(String.raw`sdxl\sd_xl_base.safetensors [31e35c80fc]`)
})

test('loadedCheckpoint is null when the option is missing or empty', async () => {
  mock.respond('/sdapi/v1/options', { json: { sd_model_checkpoint: '' } })
  expect((await make().get()).loadedCheckpoint).toBeNull()
})

test('writes a catalog log entry with item counts and duration', async () => {
  await make().get()
  const [e] = log.list({ category: 'catalog' })
  expect(e).toMatchObject({
    level: 'info',
    messageKey: 'log.catalog.loaded',
    details: { checkpoints: 2, modules: 2, loras: 2, samplers: 2, schedulers: 2, upscalers: 2 },
  })
  expect(e?.durationMs).toBeGreaterThanOrEqual(0)
})

test('a failing list rejects and writes an error entry', async () => {
  mock.respond('/sdapi/v1/samplers', { status: 500, json: { detail: 'boom' } })
  await expect(make().get()).rejects.toMatchObject({ name: 'ForgeError', kind: 'http', status: 500 })
  const [e] = log.list({ category: 'error' })
  expect(e).toMatchObject({ level: 'error', messageKey: 'log.catalog.failed' })
  expect(e?.details).toMatchObject({ kind: 'http', status: 500 })
})

test('a failed refresh keeps the cached catalog', async () => {
  const cat = make()
  const first = await cat.get()
  mock.respond('/sdapi/v1/samplers', { status: 500, json: { detail: 'boom' } })
  await expect(cat.get(true)).rejects.toBeDefined()
  expect(await cat.get()).toEqual(first)
})

const findings = (modulesAs: 'name' | 'path'): ProbeFindings => ({ shiftField: null, modulesAs, thumbRoute: false })

const params = (checkpoint: string, modules: string[]): GenerationParams => ({
  family: 'sdxl', checkpoint, modules, prompt: '', negativePrompt: '', width: 512, height: 512, steps: 4,
  cfgScale: 1, distilledCfg: 3.5, shift: null, clipSkip: null, sampler: 'Euler', scheduler: 'Simple',
  seed: -1, count: 1, loras: [],
})

const catalog: Catalog = {
  checkpoints: [{ title: 'a.safetensors [1]', name: 'a', filename: '/m/a.safetensors', family: 'sdxl' }],
  modules: [{ name: 'ae.safetensors', filename: '/m/ae.safetensors' }],
  loras: [], samplers: [], schedulers: [], upscalers: [], loadedCheckpoint: null, fetchedAt: 0, familyModules: {},
}

test('moduleValue follows modulesAs', () => {
  const m = catalog.modules[0]!
  expect(moduleValue(m, findings('path'))).toBe('/m/ae.safetensors')
  expect(moduleValue(m, findings('name'))).toBe('ae.safetensors')
})

test('checkParts flags a missing checkpoint and a missing module', () => {
  expect(checkParts(params('gone.safetensors', ['/m/vae.safetensors']), catalog, findings('path'))).toEqual([
    { role: 'model', value: 'gone.safetensors', found: false },
    { role: 'module', value: '/m/vae.safetensors', found: false },
  ])
})

test('checkParts reports found for present parts', () => {
  expect(checkParts(params('a.safetensors [1]', ['/m/ae.safetensors']), catalog, findings('path'))).toEqual([
    { role: 'model', value: 'a.safetensors [1]', found: true },
    { role: 'module', value: '/m/ae.safetensors', found: true },
  ])
  expect(checkParts(params('a.safetensors [1]', ['ae.safetensors']), catalog, findings('name'))[1]?.found).toBe(true)
})

test('checkParts flags a hires upscaler the server does not list, and ignores it when hires is off', () => {
  const withUp = { ...catalog, upscalers: ['Latent'] }
  const hires = (upscaler: string, scale: 1 | 2): GenerationParams => ({
    ...params('a.safetensors [1]', []), hires: { scale, upscaler, secondPassSteps: 8, denoisingStrength: 0.5 },
  })
  expect(checkParts(hires('Gone 4x', 2), withUp, findings('path'))[1]).toEqual({ role: 'upscaler', value: 'Gone 4x', found: false })
  expect(checkParts(hires('Latent', 2), withUp, findings('path'))[1]).toEqual({ role: 'upscaler', value: 'Latent', found: true })
  expect(checkParts(hires('Gone 4x', 1), withUp, findings('path'))).toHaveLength(1)
})
