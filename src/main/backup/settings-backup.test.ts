import type { GenerationParams, PresetParams } from '@shared/types'
import { openDb } from '../storage/db'
import { createRepos, isGenerationParams } from '../storage/repos'
import { applyBackup, BackupError, buildBackup, parseBackup, previewBackup, type BackupFile } from './settings-backup'

const job = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  family: 'sdxl', checkpoint: 'exampleMix_v10.safetensors [abc]', modules: [], prompt: 'p', negativePrompt: 'n',
  width: 1024, height: 1024, steps: 20, cfgScale: 7, distilledCfg: 3.5, shift: null, clipSkip: null,
  sampler: 'Euler', scheduler: 'Simple', seed: -1, count: 1, loras: [], ...over,
})
const presetParams = (over: Partial<GenerationParams> = {}): PresetParams => {
  const { prompt: _p, negativePrompt: _n, seed: _s, count: _c, ...kept } = job(over)
  return kept
}
const validate = (p: unknown): PresetParams | null => {
  if (typeof p !== 'object' || p === null) return null
  const full = { ...p, prompt: 'x', negativePrompt: '', seed: -1, count: 1 }
  if (!isGenerationParams(full)) return null
  const { prompt: _p, negativePrompt: _n, seed: _s, count: _c, img2img: _i, upscale: _u, ...kept } = full
  return kept
}
const fresh = () => {
  const repos = createRepos(openDb(':memory:'), () => 1000)
  return repos
}
const URL_A = 'http://100.64.0.1:7860'

/** A library with something of every kind the file carries, plus data it must never carry. */
function filled() {
  const repos = fresh()
  const a = repos.servers.add('Home PC', URL_A)
  repos.presets.add('Portrait', presetParams({ steps: 30 }))
  repos.hiresPresets.add('Soft 2x', { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 })
  const neg = repos.negativePresets.add('Clean', 'lowres, blurry')
  repos.modelMeta.setFamily(a.id, 'checkpoint', 'exampleMix_v10.safetensors', 'anima')
  repos.modelMeta.setTriggers(a.id, 'lora', 'detail_tweaker.safetensors', ['sharp', 'skin'])
  repos.modelMeta.setNote(a.id, 'lora', 'only_a_note.safetensors', 'private note')
  repos.settings.set('negative.family.sdxl', String(neg.id))
  repos.settings.set('modules.family.sdxl', JSON.stringify(['exampleVae.safetensors']))
  repos.settings.set('oplog.retentionDays', '30')
  repos.settings.set('upscaler.hires', 'Latent')
  repos.settings.set('upscaler.finished', 'R-ESRGAN 4x+')
  repos.settings.set('lock.hash', 'scrypt:secret')
  repos.settings.set('imagesDir', 'C:/pictures')
  repos.settings.set('civitai.enabled', '1')
  return repos
}

test('an export holds the user\'s data and none of the excluded kinds', () => {
  const file = buildBackup(filled(), new Date('2026-10-16T10:00:00Z'))
  expect(file).toMatchObject({
    format: 'forge-neo-client-settings', version: 1, exportedAt: '2026-10-16T10:00:00.000Z',
    servers: [{ name: 'Home PC', url: URL_A }],
    presets: [{ name: 'Portrait' }], hiresPresets: [{ name: 'Soft 2x' }], negativePresets: [{ name: 'Clean', text: 'lowres, blurry' }],
    models: [
      { serverUrl: URL_A, kind: 'checkpoint', file: 'exampleMix_v10.safetensors', family: 'anima' },
      { serverUrl: URL_A, kind: 'lora', file: 'detail_tweaker.safetensors', triggers: ['sharp', 'skin'] },
    ],
    settings: { retentionDays: 30, upscalers: { hires: 'Latent', finished: 'R-ESRGAN 4x+' }, familyNegatives: { sdxl: 'Clean' }, familyModules: { sdxl: ['exampleVae.safetensors'] } },
  })
  const text = JSON.stringify(file)
  for (const never of ['scrypt', 'secret', 'C:/pictures', 'civitai', 'private note', 'jobs', 'oplog']) expect(text).not.toContain(never)
})

test('export then import into an empty database gives the same data', () => {
  const source = filled()
  const exported = JSON.stringify(buildBackup(source, new Date(0)))
  const target = fresh()
  const file = parseBackup(exported, validate)
  const summary = applyBackup(target, file)
  expect(summary).toMatchObject({ servers: 1, presets: 1, hiresPresets: 1, negativePresets: 1, models: 2, settings: 4, renamed: 0, skipped: 0 })
  const again = buildBackup(target, new Date(0))
  expect(again).toEqual(buildBackup(source, new Date(0)))
})

test('names already taken get "(imported)", servers with a known address are skipped, and nothing is overwritten', () => {
  const file = parseBackup(JSON.stringify(buildBackup(filled(), new Date(0))), validate)
  const target = fresh()
  const home = target.servers.add('Home PC', URL_A)
  target.servers.add('Home PC again', 'http://100.64.0.9:7860')
  target.presets.add('portrait', presetParams({ steps: 5 }))
  target.negativePresets.add('Clean', 'my own negative')
  target.modelMeta.setFamily(home.id, 'checkpoint', 'exampleMix_v10.safetensors', 'qwen')
  target.settings.set('oplog.retentionDays', '7')

  const planned = previewBackup(target, file)
  const summary = applyBackup(target, file)
  expect(summary).toEqual(planned)
  expect(summary).toMatchObject({ servers: 0, presets: 1, hiresPresets: 1, negativePresets: 1, models: 1 })
  expect(summary.renamed).toBe(2)
  expect(target.presets.list().map((p) => p.name).sort()).toEqual(['Portrait (imported)', 'portrait'])
  expect(target.presets.list().find((p) => p.name === 'portrait')!.params.steps).toBe(5)
  expect(target.negativePresets.list().find((p) => p.name === 'Clean')!.text).toBe('my own negative')
  expect(target.negativePresets.list().map((p) => p.name).sort()).toEqual(['Clean', 'Clean (imported)'])
  expect(target.modelMeta.get(home.id, 'checkpoint', 'exampleMix_v10.safetensors')!.family).toBe('qwen')
  expect(target.modelMeta.get(home.id, 'lora', 'detail_tweaker.safetensors')!.triggers).toEqual(['sharp', 'skin'])
  expect(target.settings.get('oplog.retentionDays')).toBe('7')
  // The family's negative points at the imported preset that carries the file's text.
  const importedId = target.negativePresets.list().find((p) => p.name === 'Clean (imported)')!.id
  expect(target.settings.get('negative.family.sdxl')).toBe(String(importedId))
  // A second import adds the same things again under new names, still without touching anything.
  expect(applyBackup(target, file).renamed).toBeGreaterThan(0)
})

test('only the chosen parts are exported, and only the chosen parts of a file are imported', () => {
  const source = filled()
  source.wishlist.add({ modelId: 7, versionId: 70, kind: 'lora', name: 'Detail', versionName: 'v3', baseModel: 'SDXL 1.0', creator: 'maker', site: 'com', thumb: 'data:image/jpeg;base64,AAAA', files: ['detail.safetensors'] })
  const partial = buildBackup(source, new Date(0), ['presets', 'wishlist'])
  expect(partial.presets).toHaveLength(1)
  expect(partial.wishlist).toEqual([{ modelId: 7, versionId: 70, kind: 'lora', name: 'Detail', versionName: 'v3', baseModel: 'SDXL 1.0', creator: 'maker', site: 'com', files: ['detail.safetensors'] }])
  expect(JSON.stringify(partial)).not.toContain('AAAA')
  expect([partial.servers, partial.hiresPresets, partial.negativePresets, partial.models]).toEqual([[], [], [], []])
  expect(partial.settings).toEqual({ familyNegatives: {}, familyModules: {} })

  const full = parseBackup(JSON.stringify(buildBackup(source, new Date(0))), validate)
  const target = fresh()
  expect(previewBackup(target, full, ['servers', 'wishlist'])).toMatchObject({ servers: 1, wishlist: 1, presets: 0, negativePresets: 0, models: 0, settings: 0 })
  expect(applyBackup(target, full, ['servers', 'wishlist'])).toMatchObject({ servers: 1, wishlist: 1, presets: 0 })
  expect(target.servers.list()).toHaveLength(1)
  expect(target.presets.list()).toEqual([])
  expect(target.wishlist.list().map((w) => [w.name, w.thumb])).toEqual([['Detail', null]])
  expect(target.settings.get('oplog.retentionDays')).toBeNull()
  // The same wished model is not added twice.
  expect(applyBackup(target, full, ['wishlist'])).toMatchObject({ wishlist: 0, skipped: 1 })
  expect(target.wishlist.list()).toHaveLength(1)
})

test('a malformed Download later entry refuses the whole file', () => {
  const good = buildBackup(filled(), new Date(0))
  const code = (text: string): string => { try { parseBackup(text, validate); return 'ok' } catch (e) { return e instanceof BackupError ? e.code : 'other' } }
  expect(code(JSON.stringify({ ...good, wishlist: [{ modelId: 'x' }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, wishlist: [{ modelId: 1, versionId: 2, kind: 'lora', name: 'n', versionName: 'v', baseModel: 'b', creator: 'c', site: 'org', files: [] }] }))).toBe('malformed')
})

test('a preview counts without writing anything', () => {
  const file = parseBackup(JSON.stringify(buildBackup(filled(), new Date(0))), validate)
  const target = fresh()
  expect(previewBackup(target, file)).toMatchObject({ servers: 1, presets: 1, hiresPresets: 1, negativePresets: 1, models: 2, settings: 4 })
  expect(target.servers.list()).toEqual([])
  expect(target.presets.list()).toEqual([])
  expect(target.settings.get('oplog.retentionDays')).toBeNull()
})

test('a file that is damaged, foreign or of an unknown version is refused whole', () => {
  const good = buildBackup(filled(), new Date(0))
  const code = (text: string): string => { try { parseBackup(text, validate); return 'ok' } catch (e) { return e instanceof BackupError ? e.code : 'other' } }
  expect(code('{not json')).toBe('malformed')
  expect(code('[]')).toBe('notBackup')
  expect(code(JSON.stringify({ format: 'something-else', version: 1 }))).toBe('notBackup')
  expect(code(JSON.stringify({ ...good, version: 2 }))).toBe('unknownVersion')
  expect(code(JSON.stringify({ ...good, servers: [{ name: 'x', url: 'ftp://nope' }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, presets: [{ name: 'p', params: { steps: 'many' } }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, hiresPresets: [{ name: 'p', settings: { scale: 9 } }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, models: [{ serverUrl: URL_A, kind: 'lora', file: 'a', family: 'sdxl' }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, models: [{ serverUrl: URL_A, kind: 'checkpoint', file: 'a', family: 'nonsense' }] }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, settings: { retentionDays: 0 } }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, settings: { familyModules: { sdxl: 'vae' } } }))).toBe('malformed')
  expect(code(JSON.stringify({ ...good, negativePresets: [{ name: '', text: 'x' }] }))).toBe('malformed')
  expect(code(JSON.stringify(good))).toBe('ok')
})

test('a fault during the import rolls the whole import back', () => {
  const file: BackupFile = parseBackup(JSON.stringify(buildBackup(filled(), new Date(0))), validate)
  const target = fresh()
  const real = target.negativePresets.add.bind(target.negativePresets)
  target.negativePresets.add = () => { throw new Error('disk full') }
  expect(() => applyBackup(target, file)).toThrow('disk full')
  target.negativePresets.add = real
  expect(target.servers.list()).toEqual([])
  expect(target.presets.list()).toEqual([])
  expect(target.hiresPresets.list()).toEqual([])
})
