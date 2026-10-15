import type { Api, AppEvents, ConnectionCheck } from '@shared/ipc'
import type {
  Catalog, GenerationParams, ImageRecord, Job, JobProgress, LockState, NegativePreset, OplogEntry, PartStatus, RestartOutcome,
  ServerInfo,
} from '@shared/types'
import { en } from '../locales/en'
import { createAppStore, LOG_LIMIT, logQuery } from './store'

const baseParams: GenerationParams = {
  family: 'sdxl', checkpoint: 'a.safetensors', modules: [], prompt: '', negativePrompt: 'family negative',
  width: 1024, height: 1024, steps: 20, cfgScale: 5, distilledCfg: 3.5, shift: null, clipSkip: null,
  sampler: 'Euler', scheduler: 'Simple', seed: -1, count: 1, loras: [],
}
const paramsFor = (checkpoint: string, extra: Partial<GenerationParams> = {}): GenerationParams =>
  ({ ...baseParams, checkpoint, ...extra })

const catalog = (over: Partial<Catalog> = {}): Catalog => ({
  checkpoints: [
    { title: 'a.safetensors', name: 'a', filename: 'a.safetensors', family: 'sdxl' },
    { title: 'b.safetensors', name: 'b', filename: 'b.safetensors', family: 'zimage' },
  ],
  modules: [], loras: [], samplers: ['Euler'], schedulers: ['Simple'], upscalers: [],
  loadedCheckpoint: 'b.safetensors', fetchedAt: 1, familyModules: {}, ...over,
})

const job = (id: number, status: Job['status'] = 'queued'): Job => ({
  id, serverId: 1, type: 'txt2img', status, params: baseParams, error: null,
  createdAt: 1, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
})
const image = (id: number): ImageRecord => ({
  id, jobId: 1, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/t${id}.jpg`, width: 1, height: 1,
  seed: 1, infotext: '', createdAt: 1, durationMs: null, hidden: false, sourceImageId: null, tags: [], locked: false,
})
const progress = (jobId: number): JobProgress => ({
  jobId, step: 3, totalSteps: 20, stage: 'sampling', stepsPerSec: 2, elapsedMs: 1000, preview: null,
})
const home: ServerInfo = { id: 1, name: 'Home', url: 'http://127.0.0.1:7861', active: true }
const blurry: NegativePreset = { id: 1, name: 'Blurry', text: 'blurry, lowres', createdAt: 1 }
const logEntry = (id: number, level: OplogEntry['level'] = 'info', category: OplogEntry['category'] = 'app'): OplogEntry => ({
  id, time: id, level, category, messageKey: 'log.app.started', durationMs: null, jobId: null, details: {},
})
const connected = { state: 'connected', latencyMs: 38, attempts: 0, lastOkAt: 1 } as const

function fakeApi(over: { serverUrl?: string | null; catalog?: Catalog } = {}) {
  const handlers = new Map<string, Array<(payload: never) => void>>()
  const cat = over.catalog ?? catalog()
  const api = {
    settings: {
      get: vi.fn(async () => ({ serverUrl: over.serverUrl === undefined ? 'http://127.0.0.1:7861' : over.serverUrl, imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })),
      setUpscalers: vi.fn(async () => {}),
      chooseImagesDir: vi.fn(async () => null as string | null),
    },
    servers: {
      list: vi.fn(async (): Promise<ServerInfo[]> => (over.serverUrl === null ? [] : [home])),
      add: vi.fn(async (): Promise<ConnectionCheck> => ({ ok: true, latencyMs: 12, errorKey: null })),
      update: vi.fn(async (): Promise<ConnectionCheck> => ({ ok: true, latencyMs: null, errorKey: null })),
      remove: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
      addLocal: vi.fn(async () => false),
    },
    negativePresets: {
      list: vi.fn(async (): Promise<NegativePreset[]> => [blurry]),
      add: vi.fn(async (input: { name: string; text: string }): Promise<NegativePreset> => ({ id: 2, createdAt: 2, ...input })),
      update: vi.fn(async (): Promise<NegativePreset> => blurry),
      remove: vi.fn(async () => {}),
    },
    catalog: {
      get: vi.fn(async () => cat),
      defaults: vi.fn(async (title: string) => paramsFor(title)),
      parts: vi.fn(async (): Promise<PartStatus[]> => []),
    },
    jobs: {
      enqueue: vi.fn(async (): Promise<Job[]> => [job(7)]),
      cancel: vi.fn(async () => {}),
      retry: vi.fn(async () => job(9)),
      listActive: vi.fn(async (): Promise<Job[]> => [job(1, 'running'), job(2, 'queued')]),
      get: vi.fn(async (id: number) => job(id, 'failed')),
    },
    images: {
      list: vi.fn(async (_opts: { limit: number; beforeId?: number }): Promise<ImageRecord[]> => [image(5), image(4)]),
      delete: vi.fn(async () => {}),
      setHidden: vi.fn(async (_ids: number[], _hidden: boolean) => {}),
    },
    lock: {
      state: vi.fn(async (): Promise<LockState> => ({ hasPassword: true, open: false })),
      open: vi.fn(async (_password: string) => {}),
      close: vi.fn(async () => {}),
      setPassword: vi.fn(async (_old: string | null, _next: string) => {}),
    },
    connection: { get: vi.fn(async () => connected) },
    oplog: {
      list: vi.fn(async (): Promise<OplogEntry[]> => [logEntry(2, 'error'), logEntry(1)]),
      export: vi.fn(async () => true),
      retention: vi.fn(async () => 90),
      setRetention: vi.fn(async () => {}),
    },
    forge: {
      capabilities: vi.fn(async () => ({ canRestart: true })),
      health: vi.fn(async () => ({ unhealthy: false })),
      restart: vi.fn(async (): Promise<RestartOutcome> => 'restarting'),
      unload: vi.fn(async () => {}),
    },
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
      return () => {}
    }),
  }
  const emit = <K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void => {
    for (const cb of handlers.get(event) ?? []) cb(payload as never)
  }
  return { api: api as unknown as Api & typeof api, emit }
}

async function ready(over?: Parameters<typeof fakeApi>[0]) {
  const fake = fakeApi(over)
  const store = createAppStore(fake.api)
  await store.getState().init()
  return { ...fake, store }
}

test('init loads settings, catalog, active jobs and images, and picks the loaded checkpoint', async () => {
  const { store } = await ready()
  const s = store.getState()
  expect(s.settings?.serverUrl).toBe('http://127.0.0.1:7861')
  expect(s.connection).toEqual(connected)
  expect(Object.keys(s.jobs).sort()).toEqual(['1', '2'])
  expect(s.images.map((i) => i.id)).toEqual([5, 4])
  expect(s.catalog?.checkpoints).toHaveLength(2)
  expect(s.params?.checkpoint).toBe('b.safetensors')
  expect(s.servers).toEqual([home])
})

test('typing before catalog load survives selection of the initial checkpoint', async () => {
  const fake = fakeApi()
  let releaseCatalog: (value: Catalog) => void = () => {}
  fake.api.catalog.get.mockImplementationOnce(() => new Promise<Catalog>((resolve) => { releaseCatalog = resolve }))
  const store = createAppStore(fake.api)
  store.getState().setParams({ prompt: 'a fox' })
  expect(store.getState().draftPrompt).toBe('a fox')
  const loading = store.getState().init()
  await vi.waitFor(() => expect(fake.api.catalog.get).toHaveBeenCalledTimes(1))
  expect(store.getState().params).toBeNull()
  releaseCatalog(catalog())
  await loading
  expect(store.getState().params?.prompt).toBe('a fox')
})

test('init falls back to the first checkpoint when the loaded one is not listed', async () => {
  const { store } = await ready({ catalog: catalog({ loadedCheckpoint: 'gone.safetensors' }) })
  expect(store.getState().params?.checkpoint).toBe('a.safetensors')
})

test('init without a server url skips the catalog', async () => {
  const { api, store } = await ready({ serverUrl: null })
  expect(api.catalog.get).not.toHaveBeenCalled()
  expect(store.getState().catalog).toBeNull()
  expect(store.getState().params).toBeNull()
  expect(store.getState().images).toHaveLength(2)
})

describe('first run', () => {
  const local: ServerInfo = { id: 1, name: en['server.thisPc'], url: 'http://127.0.0.1:7860', active: true }

  test('with no saved server, init has main add the local Forge as This PC and loads its catalog', async () => {
    const fake = fakeApi({ serverUrl: null })
    const check = deferred<boolean>()
    fake.api.servers.addLocal.mockReturnValueOnce(check.promise)
    const store = createAppStore(fake.api)
    const loading = store.getState().init()
    await vi.waitFor(() => expect(fake.api.servers.addLocal).toHaveBeenCalledWith(en['server.thisPc']))
    // No settings yet, so the server dialog does not flash open while the check runs.
    expect(store.getState().settings).toBeNull()
    expect(store.getState().images).toHaveLength(2)
    fake.api.settings.get.mockResolvedValueOnce({ serverUrl: local.url, imagesDir: 'C:\\images', localUrl: local.url })
    fake.api.servers.list.mockResolvedValueOnce([local])
    check.resolve(true)
    await loading
    expect(store.getState().settings?.serverUrl).toBe(local.url)
    expect(store.getState().servers).toEqual([local])
    expect(fake.api.catalog.get).toHaveBeenCalledTimes(1)
    expect(store.getState().params?.checkpoint).toBe('b.safetensors')
  })

  test('with nothing answering locally, settings show no server, so the dialog opens', async () => {
    const { api, store } = await ready({ serverUrl: null })
    expect(api.servers.addLocal).toHaveBeenCalledTimes(1)
    expect(store.getState().settings).toMatchObject({ serverUrl: null })
    expect(api.catalog.get).not.toHaveBeenCalled()
  })

  test('a failing check counts as nothing found', async () => {
    const fake = fakeApi({ serverUrl: null })
    fake.api.servers.addLocal.mockRejectedValueOnce(new Error('error.unexpected'))
    const store = createAppStore(fake.api)
    await store.getState().init()
    expect(store.getState().settings).toMatchObject({ serverUrl: null })
    expect(store.getState().lastError).toBeNull()
  })

  test('with a saved server init never asks for the local Forge', async () => {
    const { api } = await ready()
    expect(api.servers.addLocal).not.toHaveBeenCalled()
  })
})

test('init is safe to call twice: one load, one set of subscriptions', async () => {
  const { api, store } = await ready()
  await store.getState().init()
  expect(api.settings.get).toHaveBeenCalledTimes(1)
  expect(api.on).toHaveBeenCalledTimes(13)
})

test('params stay null when the catalog has no checkpoints', async () => {
  const { store } = await ready({ catalog: catalog({ checkpoints: [], loadedCheckpoint: null }) })
  expect(store.getState().catalog).not.toBeNull()
  expect(store.getState().params).toBeNull()
})

test('a catalog failure is stored as an error key', async () => {
  const fake = fakeApi()
  fake.api.catalog.get.mockRejectedValueOnce(new Error('error.network'))
  const store = createAppStore(fake.api)
  await store.getState().init()
  expect(store.getState().catalogError).toBe('error.network')
  expect(store.getState().catalog).toBeNull()
})

test('job:update replaces the job; a done job is removed from jobs', async () => {
  const { store, emit } = await ready()
  emit('job:update', { ...job(2, 'running') })
  expect(store.getState().jobs[2]?.status).toBe('running')
  emit('job:update', job(2, 'done'))
  expect(store.getState().jobs[2]).toBeUndefined()
  expect(store.getState().jobs[1]).toBeDefined()
})

test('a cancelled job is removed; failed and interrupted jobs stay', async () => {
  const { store, emit } = await ready()
  emit('job:update', job(1, 'cancelled'))
  emit('job:update', job(2, 'failed'))
  emit('job:update', job(3, 'interrupted'))
  const jobs = store.getState().jobs
  expect(jobs[1]).toBeUndefined()
  expect(jobs[2]?.status).toBe('failed')
  expect(jobs[3]?.status).toBe('interrupted')
})

test('job:progress is stored by job id and dropped when the job leaves running', async () => {
  const { store, emit } = await ready()
  emit('job:progress', progress(1))
  expect(store.getState().progress[1]?.step).toBe(3)
  emit('job:update', job(1, 'running'))
  expect(store.getState().progress[1]).toBeDefined()
  emit('job:update', job(1, 'failed'))
  expect(store.getState().progress[1]).toBeUndefined()
})

test('image:added prepends; image:removed deletes', async () => {
  const { store, emit } = await ready()
  emit('image:added', image(6))
  expect(store.getState().images.map((i) => i.id)).toEqual([6, 5, 4])
  emit('image:added', image(6))
  expect(store.getState().images).toHaveLength(3)
  emit('image:removed', { id: 5 })
  expect(store.getState().images.map((i) => i.id)).toEqual([6, 4])
})

test('connection events replace the status', async () => {
  const { store, emit } = await ready()
  emit('connection', { state: 'reconnecting', latencyMs: null, attempts: 3, lastOkAt: 1 })
  expect(store.getState().connection.state).toBe('reconnecting')
  expect(store.getState().connection.attempts).toBe(3)
})

test('selectCheckpoint keeps the prompt and swaps the rest for family defaults', async () => {
  const { api, store } = await ready()
  store.getState().setParams({ prompt: 'a red fox', negativePrompt: 'blurry', steps: 99 })
  api.catalog.defaults.mockResolvedValueOnce(paramsFor('a.safetensors', { family: 'sdxl', steps: 28 }))
  await store.getState().selectCheckpoint('a.safetensors')
  const p = store.getState().params
  expect(p?.checkpoint).toBe('a.safetensors')
  expect(p?.steps).toBe(28)
  expect(p?.prompt).toBe('a red fox')
  expect(p?.negativePrompt).toBe('blurry')
})

test('selectCheckpoint preserves the chosen image ratio across model families', async () => {
  const { api, store } = await ready()
  store.getState().setParams({ width: 896, height: 1152 })
  api.catalog.defaults.mockResolvedValueOnce(paramsFor('a.safetensors', {
    family: 'krea2', width: 1024, height: 1024,
  }))
  await store.getState().selectCheckpoint('a.safetensors')
  expect(store.getState().params).toMatchObject({ width: 896, height: 1152 })
})

test('selectCheckpoint refreshes the parts list', async () => {
  const { api, store } = await ready()
  const parts: PartStatus[] = [{ role: 'model', value: 'a.safetensors', found: true }]
  api.catalog.parts.mockResolvedValueOnce(parts)
  await store.getState().selectCheckpoint('a.safetensors')
  expect(store.getState().parts).toEqual(parts)
})

test('setParams refreshes parts when checkpoint or modules change', async () => {
  const { api, store } = await ready()
  api.catalog.parts.mockClear()
  store.getState().setParams({ steps: 30 })
  expect(api.catalog.parts).not.toHaveBeenCalled()
  store.getState().setParams({ modules: ['vae.safetensors'] })
  expect(api.catalog.parts).toHaveBeenCalledTimes(1)
  store.getState().setParams({ modules: ['vae.safetensors'] })
  expect(api.catalog.parts).toHaveBeenCalledTimes(1)
  store.getState().setParams({ checkpoint: 'a.safetensors' })
  expect(api.catalog.parts).toHaveBeenCalledTimes(2)
})

test('generate does nothing while the prompt is blank', async () => {
  const { api, store } = await ready()
  await store.getState().generate()
  store.getState().setParams({ prompt: '   ' })
  await store.getState().generate()
  expect(api.jobs.enqueue).not.toHaveBeenCalled()
})

test('generate enqueues the params and tracks the new jobs', async () => {
  const { api, store } = await ready()
  store.getState().setParams({ prompt: 'a red fox' })
  await store.getState().generate()
  expect(api.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a red fox' }))
  expect(store.getState().jobs[7]?.status).toBe('queued')
})

test('attaching a saved image keeps the prompt, disables hires and sends an img2img job', async () => {
  const { store, api } = await ready()
  store.getState().setParams({ prompt: 'keep this prompt', hires: {
    scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4,
  } })
  expect(store.getState().attachImageSource(5)).toBe(true)
  expect(store.getState().params).toMatchObject({ prompt: 'keep this prompt',
    img2img: { sourceImageId: 5, denoisingStrength: 0.5, resizeMode: 0 }, hires: { scale: 1 } })
  await store.getState().generate()
  expect(api.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    prompt: 'keep this prompt', img2img: expect.objectContaining({ sourceImageId: 5 }),
  }))
  store.getState().removeImageSource()
  expect(store.getState().params?.img2img).toBeUndefined()
  expect(store.getState().params?.hires?.scale).toBe(2)
})

test('a locked or deleted source cannot be sent; switching checkpoints keeps the attached image', async () => {
  const { store, api } = await ready()
  store.setState({ images: [image(5), { ...image(4), locked: true }] })
  expect(store.getState().attachImageSource(4)).toBe(false)
  expect(store.getState().attachImageSource(5)).toBe(true)
  await store.getState().selectCheckpoint('a.safetensors')
  expect(store.getState().params?.img2img?.sourceImageId).toBe(5)
  store.getState().setParams({ prompt: 'fox' })
  store.setState({ images: [] })
  await store.getState().generate()
  expect(api.jobs.enqueue).not.toHaveBeenCalled()
})

test('upscaleImage queues a saved image with source settings and does not change the prompt bar mode', async () => {
  const { store, api } = await ready()
  store.setState({ catalog: catalog({ upscalers: ['R-ESRGAN 4x+'] }) })
  store.getState().setParams({ prompt: 'current draft' })
  expect(await store.getState().upscaleImage(5, paramsFor('old.safetensors', { prompt: 'source prompt' }), 'R-ESRGAN 4x+', 2)).toBe(true)
  expect(api.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    prompt: 'source prompt', count: 1, upscale: { sourceImageId: 5, upscaler: 'R-ESRGAN 4x+', scale: 2 },
  }))
  expect(store.getState().params?.prompt).toBe('current draft')
  expect(store.getState().params?.upscale).toBeUndefined()
})

test('saving a default upscaler persists both preferences and updates local settings', async () => {
  const { store, api } = await ready()
  store.setState({ catalog: catalog({ upscalers: ['Latent', 'R-ESRGAN 4x+'] }) })
  expect(await store.getState().setDefaultUpscaler('finished', 'R-ESRGAN 4x+')).toBe(true)
  expect(api.settings.setUpscalers).toHaveBeenCalledWith({ hires: 'Latent', finished: 'R-ESRGAN 4x+' })
  expect(store.getState().settings?.upscalers).toEqual({ hires: 'Latent', finished: 'R-ESRGAN 4x+' })
})

test('choosing a folder updates the local image-storage setting only after a selection', async () => {
  const { store, api } = await ready()
  const original = store.getState().settings?.imagesDir
  expect(await store.getState().chooseImagesDir()).toBeNull()
  expect(store.getState().settings?.imagesDir).toBe(original)
  api.settings.chooseImagesDir.mockResolvedValueOnce('C:\\Pictures\\Forge')
  expect(await store.getState().chooseImagesDir()).toBe('C:\\Pictures\\Forge')
  expect(store.getState().settings?.imagesDir).toBe('C:\\Pictures\\Forge')
})

test('generate keeps a rejection key in lastError until dismissed', async () => {
  const { api, store } = await ready()
  store.getState().setParams({ prompt: 'a red fox' })
  api.jobs.enqueue.mockRejectedValueOnce(new Error('error.noServer'))
  await store.getState().generate()
  expect(store.getState().lastError).toBe('error.noServer')
  store.getState().dismissError()
  expect(store.getState().lastError).toBeNull()
})

test('generate does nothing when there are no params', async () => {
  const { api, store } = await ready({ serverUrl: null })
  await store.getState().generate()
  expect(api.jobs.enqueue).not.toHaveBeenCalled()
})

test('cancelJob, retryJob and deleteImage call through; a retry clone is tracked', async () => {
  const { api, store } = await ready()
  await store.getState().cancelJob(1)
  await store.getState().retryJob(2)
  await store.getState().deleteImage(5)
  expect(api.jobs.cancel).toHaveBeenCalledWith(1)
  expect(api.jobs.retry).toHaveBeenCalledWith(2)
  expect(api.images.delete).toHaveBeenCalledWith(5)
  expect(store.getState().jobs[9]).toBeDefined()
})

test('a rejected cancel is reported through lastError', async () => {
  const { api, store } = await ready()
  api.jobs.cancel.mockRejectedValueOnce(new Error('error.invalidParams'))
  await store.getState().cancelJob(1)
  expect(store.getState().lastError).toBe('error.invalidParams')
})

test('addServer on success refreshes settings, servers and the catalog and selects a checkpoint', async () => {
  const { api, store } = await ready({ serverUrl: null })
  api.settings.get.mockResolvedValueOnce({ serverUrl: 'http://127.0.0.1:7861', imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })
  api.servers.list.mockResolvedValueOnce([home])
  const check = await store.getState().addServer({ name: 'Home', url: '127.0.0.1:7861' })
  expect(check.ok).toBe(true)
  expect(api.servers.add).toHaveBeenCalledWith({ name: 'Home', url: '127.0.0.1:7861' })
  expect(store.getState().settings?.serverUrl).toBe('http://127.0.0.1:7861')
  expect(store.getState().servers).toEqual([home])
  expect(store.getState().catalog).not.toBeNull()
  expect(store.getState().params?.checkpoint).toBe('b.safetensors')
})

test('addServer on failure returns the check and changes nothing else', async () => {
  const { api, store } = await ready({ serverUrl: null })
  api.servers.add.mockResolvedValueOnce({ ok: false, latencyMs: null, errorKey: 'error.network' })
  api.settings.get.mockClear()
  const check = await store.getState().addServer({ name: '', url: 'nowhere' })
  expect(check).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
  expect(api.settings.get).not.toHaveBeenCalled()
  expect(store.getState().catalog).toBeNull()
})

test('adding an inactive server does not reload the catalog', async () => {
  const { api, store } = await ready()
  api.catalog.get.mockClear()
  await store.getState().addServer({ name: 'Other', url: 'http://other.test' })
  expect(api.catalog.get).not.toHaveBeenCalled()
})

test('activateServer switches: settings, servers and the catalog of the new server are loaded', async () => {
  const { api, store } = await ready()
  const other: ServerInfo = { id: 2, name: 'Other', url: 'http://other.test', active: true }
  api.settings.get.mockResolvedValueOnce({ serverUrl: other.url, imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })
  api.servers.list.mockResolvedValueOnce([{ ...home, active: false }, other])
  api.catalog.get.mockClear()
  await store.getState().activateServer(2)
  expect(api.servers.activate).toHaveBeenCalledWith(2)
  expect(store.getState().settings?.serverUrl).toBe(other.url)
  expect(store.getState().servers.find((s) => s.active)?.id).toBe(2)
  expect(api.catalog.get).toHaveBeenCalledTimes(1)
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

test('a server switch drops the old params at once, keeps the prompt, and a late old response cannot win', async () => {
  const { api, store } = await ready()
  store.getState().setParams({ prompt: 'a lighthouse' })
  const oldDefaults = deferred<GenerationParams>()
  api.catalog.defaults.mockReturnValueOnce(oldDefaults.promise)
  const oldPick = store.getState().selectCheckpoint('a.safetensors')
  const other: ServerInfo = { id: 2, name: 'Other', url: 'http://other.test', active: true }
  api.settings.get.mockResolvedValueOnce({ serverUrl: other.url, imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })
  api.servers.list.mockResolvedValueOnce([{ ...home, active: false }, other])
  const next = deferred<Catalog>()
  api.catalog.get.mockReturnValueOnce(next.promise)
  // The switch returns without waiting for the new catalog.
  await store.getState().activateServer(2)
  expect(store.getState().params).toBeNull()
  expect(store.getState().draftPrompt).toBe('a lighthouse')
  await store.getState().generate()
  expect(api.jobs.enqueue).not.toHaveBeenCalled()
  oldDefaults.resolve(paramsFor('a.safetensors'))
  await oldPick
  expect(store.getState().params).toBeNull()
  next.resolve(catalog({ checkpoints: [{ title: 'c.safetensors', name: 'c', filename: 'c.safetensors', family: 'sdxl' }], loadedCheckpoint: null }))
  await vi.waitFor(() => expect(store.getState().params?.checkpoint).toBe('c.safetensors'))
  expect(store.getState().params?.prompt).toBe('a lighthouse')
})

describe('negative prompt across a server switch', () => {
  const other: ServerInfo = { id: 2, name: 'Other', url: 'http://other.test', active: true }
  const third: ServerInfo = { id: 3, name: 'Third', url: 'http://third.test', active: true }
  const only = (title: string, family: GenerationParams['family']): Catalog =>
    catalog({ checkpoints: [{ title, name: title, filename: title, family }], loadedCheckpoint: null })

  /** Switches to `server`, whose catalog holds one checkpoint of `family` with these defaults. */
  async function switchTo(fake: Awaited<ReturnType<typeof ready>>, server: ServerInfo, title: string, family: GenerationParams['family'], negative: string) {
    const { api, store } = fake
    api.settings.get.mockResolvedValueOnce({ serverUrl: server.url, imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })
    api.servers.list.mockResolvedValueOnce([{ ...home, active: false }, server])
    api.catalog.get.mockResolvedValueOnce(only(title, family))
    api.catalog.defaults.mockResolvedValueOnce(paramsFor(title, { family, negativePrompt: negative }))
    await store.getState().activateServer(server.id)
    await vi.waitFor(() => expect(store.getState().params?.checkpoint).toBe(title))
  }

  test('a switch keeps the negative the user typed instead of the new family default', async () => {
    const fake = await ready()
    fake.store.getState().setParams({ negativePrompt: 'blurry, watermark' })
    await switchTo(fake, other, 'c.safetensors', 'sdxl', 'family negative')
    expect(fake.store.getState().params?.negativePrompt).toBe('blurry, watermark')
    expect(fake.store.getState().draftNegative).toBe('blurry, watermark')
  })

  test('the kept negative also survives a checkpoint change on the new server', async () => {
    const fake = await ready()
    fake.store.getState().setParams({ negativePrompt: 'lowres' })
    await switchTo(fake, other, 'c.safetensors', 'sdxl', 'family negative')
    fake.api.catalog.defaults.mockResolvedValueOnce(paramsFor('d.safetensors', { family: 'zimage', negativePrompt: 'other default' }))
    await fake.store.getState().selectCheckpoint('d.safetensors')
    expect(fake.store.getState().params?.negativePrompt).toBe('lowres')
  })

  test('a family without a negative does not lose it for a later family that has one', async () => {
    const fake = await ready()
    fake.store.getState().setParams({ negativePrompt: 'jpeg artifacts' })
    await switchTo(fake, other, 'k.safetensors', 'krea2', '')
    expect(fake.store.getState().draftNegative).toBe('jpeg artifacts')
    await switchTo(fake, third, 'e.safetensors', 'sdxl', 'family negative')
    expect(fake.store.getState().params?.negativePrompt).toBe('jpeg artifacts')
  })

  test('without any negative yet, a family without one leaves the next family its default', async () => {
    const base = fakeApi({ catalog: only('k.safetensors', 'krea2') })
    base.api.catalog.defaults.mockResolvedValueOnce(paramsFor('k.safetensors', { family: 'krea2', negativePrompt: '' }))
    const store = createAppStore(base.api)
    await store.getState().init()
    const fake = { ...base, store }
    expect(store.getState().params?.family).toBe('krea2')
    await switchTo(fake, other, 'e.safetensors', 'sdxl', 'family negative')
    expect(fake.store.getState().params?.negativePrompt).toBe('family negative')
  })
})

test('a superseded checkpoint choice that fails does not report an error', async () => {
  const { api, store } = await ready()
  let rejectFirst!: (e: Error) => void
  api.catalog.defaults.mockReturnValueOnce(new Promise<GenerationParams>((_, r) => { rejectFirst = r }))
  const a = store.getState().selectCheckpoint('a.safetensors')
  await store.getState().selectCheckpoint('b.safetensors')
  rejectFirst(new Error('error.network'))
  await a
  expect(store.getState().lastError).toBeNull()
  expect(store.getState().params?.checkpoint).toBe('b.safetensors')
})

test('the last checkpoint choice wins when an older defaults response resolves later', async () => {
  const { api, store } = await ready()
  const first = deferred<GenerationParams>()
  const second = deferred<GenerationParams>()
  api.catalog.defaults.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const a = store.getState().selectCheckpoint('a.safetensors')
  const b = store.getState().selectCheckpoint('b.safetensors')
  second.resolve(paramsFor('b.safetensors'))
  await b
  first.resolve(paramsFor('a.safetensors'))
  await a
  expect(store.getState().params?.checkpoint).toBe('b.safetensors')
})

test('activateServer passes a refusal on to the caller', async () => {
  const { api, store } = await ready()
  api.servers.activate.mockRejectedValueOnce(new Error('error.jobRunning'))
  await expect(store.getState().activateServer(2)).rejects.toThrow('error.jobRunning')
})

test('removing the active server clears the catalog and the parameters', async () => {
  const { api, store } = await ready()
  api.settings.get.mockResolvedValueOnce({ serverUrl: null, imagesDir: 'C:\\images', localUrl: 'http://127.0.0.1:7860' })
  api.servers.list.mockResolvedValueOnce([])
  await store.getState().removeServer(1)
  expect(api.servers.remove).toHaveBeenCalledWith(1)
  const s = store.getState()
  expect(s.settings?.serverUrl).toBeNull()
  expect(s.servers).toEqual([])
  expect(s.catalog).toBeNull()
  expect(s.params).toBeNull()
})

test('updateServer saves through the api and refreshes the list', async () => {
  const { api, store } = await ready()
  api.servers.list.mockResolvedValueOnce([{ ...home, name: 'Renamed' }])
  const check = await store.getState().updateServer(1, { name: 'Renamed', url: home.url })
  expect(check.ok).toBe(true)
  expect(api.servers.update).toHaveBeenCalledWith(1, { name: 'Renamed', url: home.url })
  expect(store.getState().servers[0]?.name).toBe('Renamed')
})

test('a servers event replaces the list; job:removed drops the job and its progress', async () => {
  const { store, emit } = await ready()
  emit('servers', [])
  expect(store.getState().servers).toEqual([])
  emit('job:progress', progress(2))
  emit('job:removed', { id: 2 })
  expect(store.getState().jobs[2]).toBeUndefined()
  expect(store.getState().progress[2]).toBeUndefined()
})

test('togglePanel flips panelOpen', async () => {
  const { store } = await ready()
  store.getState().togglePanel()
  expect(store.getState().panelOpen).toBe(true)
})

test('addServer reports a failure when the refresh fails after an ok check', async () => {
  const { api, store } = await ready({ serverUrl: null })
  api.settings.get.mockRejectedValueOnce(new Error('error.unexpected'))
  const check = await store.getState().addServer({ name: '', url: '127.0.0.1:7861' })
  expect(check).toEqual({ ok: false, latencyMs: null, errorKey: 'error.unexpected' })
  expect(store.getState().settings?.serverUrl).toBeNull()
})

test('a job removed by a terminal event is not re-added by an enqueue that resolves later', async () => {
  const { api, store, emit } = await ready()
  store.getState().setParams({ prompt: 'a red fox' })
  api.jobs.enqueue.mockImplementationOnce(async () => {
    emit('job:update', job(7, 'done'))
    return [job(7)]
  })
  await store.getState().generate()
  expect(store.getState().jobs[7]).toBeUndefined()
})

test('a retry clone that already finished is not re-added', async () => {
  const { api, store, emit } = await ready()
  api.jobs.retry.mockImplementationOnce(async () => {
    emit('job:update', job(9, 'cancelled'))
    return job(9)
  })
  await store.getState().retryJob(2)
  expect(store.getState().jobs[9]).toBeUndefined()
})

test('init does not resurrect a job that finished while the list was loading', async () => {
  const fake = fakeApi()
  fake.api.jobs.listActive.mockImplementationOnce(async () => {
    fake.emit('job:update', job(1, 'done'))
    return [job(1, 'running'), job(2, 'queued')]
  })
  const store = createAppStore(fake.api)
  await store.getState().init()
  expect(Object.keys(store.getState().jobs)).toEqual(['2'])
})

test('retryCatalog reloads with refresh, clears the error and selects a checkpoint', async () => {
  const fake = fakeApi()
  fake.api.catalog.get.mockRejectedValueOnce(new Error('error.network'))
  const store = createAppStore(fake.api)
  await store.getState().init()
  expect(store.getState().catalogError).toBe('error.network')
  await store.getState().retryCatalog()
  expect(fake.api.catalog.get).toHaveBeenLastCalledWith(true)
  expect(store.getState().catalogError).toBeNull()
  expect(store.getState().params?.checkpoint).toBe('b.safetensors')
})

test('dismissJob removes a failed job and a stale copy is never merged back', async () => {
  const { store, emit } = await ready()
  emit('job:update', job(3, 'failed'))
  expect(store.getState().jobs[3]).toBeDefined()
  store.getState().dismissJob(3)
  expect(store.getState().jobs[3]).toBeUndefined()
  store.getState().dismissJob(99)
  expect(Object.keys(store.getState().jobs)).toEqual(['1', '2'])
})

test('dismissJob keeps a dismissed job out when init finishes later', async () => {
  const fake = fakeApi()
  const store = createAppStore(fake.api)
  store.getState().dismissJob(1)
  await store.getState().init()
  expect(Object.keys(store.getState().jobs)).toEqual(['2'])
})

const page = (from: number, count: number): ImageRecord[] => Array.from({ length: count }, (_, i) => image(from - i))

test('loadMoreImages asks for the page before the smallest loaded id and appends without duplicates', async () => {
  const fake = fakeApi()
  fake.api.images.list.mockResolvedValueOnce(page(300, 100)).mockResolvedValueOnce([image(201), ...page(200, 98)])
  const store = createAppStore(fake.api)
  await store.getState().init()
  expect(store.getState().imagesExhausted).toBe(false)
  await store.getState().loadMoreImages()
  expect(fake.api.images.list).toHaveBeenLastCalledWith({ limit: 100, beforeId: 201 })
  expect(store.getState().images).toHaveLength(198)
  expect(new Set(store.getState().images.map((i) => i.id)).size).toBe(198)
  expect(store.getState().imagesExhausted).toBe(true)
})

test('loadMoreImages stops once a short page came back', async () => {
  const { api, store } = await ready()
  expect(store.getState().imagesExhausted).toBe(true)
  await store.getState().loadMoreImages()
  expect(api.images.list).toHaveBeenCalledTimes(1)
})

test('concurrent loadMoreImages calls share one request', async () => {
  const fake = fakeApi()
  fake.api.images.list.mockResolvedValueOnce(page(300, 100))
  const store = createAppStore(fake.api)
  await store.getState().init()
  fake.api.images.list.mockClear()
  fake.api.images.list.mockResolvedValue(page(200, 100))
  await Promise.all([store.getState().loadMoreImages(), store.getState().loadMoreImages()])
  expect(fake.api.images.list).toHaveBeenCalledTimes(1)
  expect(store.getState().images).toHaveLength(200)
})

describe('negative presets', () => {
  const hands: NegativePreset = { id: 2, name: 'Hands', text: 'bad hands', createdAt: 2 }

  test('init loads the presets', async () => {
    const { store } = await ready()
    expect(store.getState().negativePresets).toEqual([blurry])
  })

  test('add, rename and remove call main and reload the list', async () => {
    const { api, store } = await ready()
    api.negativePresets.list.mockResolvedValueOnce([blurry, hands])
    await store.getState().addNegativePreset('Hands', 'bad hands')
    expect(api.negativePresets.add).toHaveBeenCalledWith({ name: 'Hands', text: 'bad hands' })
    expect(store.getState().negativePresets).toEqual([blurry, hands])

    api.negativePresets.list.mockResolvedValueOnce([blurry, { ...hands, name: 'Fingers' }])
    await store.getState().renameNegativePreset(2, 'Fingers')
    expect(api.negativePresets.update).toHaveBeenCalledWith(2, { name: 'Fingers' })
    expect(store.getState().negativePresets.map((p) => p.name)).toEqual(['Blurry', 'Fingers'])

    api.negativePresets.list.mockResolvedValueOnce([blurry])
    await store.getState().removeNegativePreset(2)
    expect(api.negativePresets.remove).toHaveBeenCalledWith(2)
    expect(store.getState().negativePresets).toEqual([blurry])
  })

  test('a refused change rejects with the error and leaves the list alone', async () => {
    const { api, store } = await ready()
    api.negativePresets.add.mockRejectedValueOnce(new Error('error.presetNameTaken'))
    await expect(store.getState().addNegativePreset('blurry', 'x')).rejects.toThrow('error.presetNameTaken')
    expect(api.negativePresets.list).toHaveBeenCalledTimes(1)
    expect(store.getState().negativePresets).toEqual([blurry])
  })

  test('a late list response never overwrites a newer one', async () => {
    const { api, store } = await ready()
    let releaseOld: (v: NegativePreset[]) => void = () => {}
    api.negativePresets.list
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
      .mockResolvedValueOnce([blurry, hands])
    const first = store.getState().removeNegativePreset(2)
    await vi.waitFor(() => expect(api.negativePresets.list).toHaveBeenCalledTimes(2))
    await store.getState().addNegativePreset('Hands', 'bad hands')
    releaseOld([])
    await first
    expect(store.getState().negativePresets).toEqual([blurry, hands])
  })
})

describe('forge control', () => {
  test('init loads capabilities and health; events replace them', async () => {
    const { store, emit } = await ready()
    expect(store.getState().capabilities).toEqual({ canRestart: true })
    expect(store.getState().forgeUnhealthy).toBe(false)
    emit('forge:health', { unhealthy: true })
    expect(store.getState().forgeUnhealthy).toBe(true)
    emit('forge:capabilities', { canRestart: false })
    expect(store.getState().capabilities).toEqual({ canRestart: false })
  })

  test('an event that arrives while init loads wins over the older load result', async () => {
    const fake = fakeApi()
    let release!: () => void
    fake.api.forge.health.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ unhealthy: false }) }))
    const store = createAppStore(fake.api)
    const init = store.getState().init()
    await vi.waitFor(() => expect(fake.api.forge.health).toHaveBeenCalled())
    fake.emit('forge:health', { unhealthy: true })
    release()
    await init
    expect(store.getState().forgeUnhealthy).toBe(true)
  })

  test('restartForge clears the unhealthy flag on restarting and returns the outcome', async () => {
    const { store, emit, api } = await ready()
    emit('forge:health', { unhealthy: true })
    expect(await store.getState().restartForge()).toBe('restarting')
    expect(store.getState().forgeUnhealthy).toBe(false)
    emit('forge:health', { unhealthy: true })
    api.forge.restart.mockResolvedValueOnce('notAllowed')
    expect(await store.getState().restartForge()).toBe('notAllowed')
    expect(store.getState().forgeUnhealthy).toBe(true)
  })

  test('restartForge and unloadModel reject with the key; the confirmation flag opens and closes', async () => {
    const { store, api } = await ready()
    api.forge.restart.mockRejectedValueOnce(new Error('error.network'))
    await expect(store.getState().restartForge()).rejects.toThrow('error.network')
    api.forge.unload.mockRejectedValueOnce(new Error('error.jobRunning'))
    await expect(store.getState().unloadModel()).rejects.toThrow('error.jobRunning')
    store.getState().askRestart()
    expect(store.getState().restartAsked).toBe(true)
    store.getState().closeRestart()
    expect(store.getState().restartAsked).toBe(false)
  })

  test('dismissUnhealthy hides the notice until the next report', async () => {
    const { store, emit } = await ready()
    emit('forge:health', { unhealthy: true })
    store.getState().dismissUnhealthy()
    expect(store.getState().forgeUnhealthy).toBe(false)
    emit('forge:health', { unhealthy: true })
    expect(store.getState().forgeUnhealthy).toBe(true)
  })
})

describe('activity log', () => {
  test('logQuery maps the filters to a main query; the period counts back from now', () => {
    expect(logQuery({ level: 'all', category: 'all', period: 'all' }, 10_000_000)).toEqual({ limit: LOG_LIMIT })
    expect(logQuery({ level: 'error', category: 'server', period: '1h' }, 10_000_000))
      .toEqual({ level: 'error', category: 'server', from: 10_000_000 - 3_600_000, limit: LOG_LIMIT })
  })

  test('opening loads the entries for the filters (last 24 hours by default) and closes the parameters panel', async () => {
    const { store, api } = await ready()
    store.getState().togglePanel()
    store.getState().toggleLog()
    expect(store.getState().panelOpen).toBe(false)
    await vi.waitFor(() => expect(store.getState().logEntries.map((e) => e.id)).toEqual([2, 1]))
    const query = (api.oplog.list.mock.calls as unknown as [{ from: number; limit: number }][])[0]![0]
    expect(Date.now() - query.from).toBeGreaterThanOrEqual(86_400_000)
    expect(query.limit).toBe(LOG_LIMIT)
    store.getState().togglePanel()
    expect(store.getState().logOpen).toBe(false)
  })

  test('a filter change reloads; an older answer that arrives late is dropped', async () => {
    const { store, api } = await ready()
    let release!: (v: OplogEntry[]) => void
    api.oplog.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    store.getState().toggleLog()
    api.oplog.list.mockResolvedValueOnce([logEntry(5, 'error')])
    store.getState().setLogFilters({ level: 'error' })
    await vi.waitFor(() => expect(store.getState().logEntries.map((e) => e.id)).toEqual([5]))
    release([logEntry(1)])
    await Promise.resolve()
    expect(store.getState().logEntries.map((e) => e.id)).toEqual([5])
    expect(api.oplog.list).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error' }))
  })

  test('live entries are added on top while open and matching; ignored when closed or filtered out', async () => {
    const { store, emit } = await ready()
    emit('oplog:added', logEntry(10))
    expect(store.getState().logEntries).toEqual([])
    store.getState().toggleLog()
    await vi.waitFor(() => expect(store.getState().logEntries).toHaveLength(2))
    emit('oplog:added', logEntry(11, 'warn'))
    emit('oplog:added', logEntry(11, 'warn'))
    expect(store.getState().logEntries.map((e) => e.id)).toEqual([11, 2, 1])
    store.getState().setLogFilters({ category: 'server' })
    emit('oplog:added', logEntry(12, 'info', 'app'))
    expect(store.getState().logEntries.some((e) => e.id === 12)).toBe(false)
  })

  test('export, retention and job lookup go to main', async () => {
    const { store, api } = await ready()
    store.getState().setLogFilters({ level: 'warn' })
    expect(await store.getState().exportLog()).toBe(true)
    expect(api.oplog.export).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
    expect(api.oplog.export).not.toHaveBeenLastCalledWith(expect.objectContaining({ limit: expect.anything() }))
    await store.getState().exportLog([4, 2])
    expect(api.oplog.export).toHaveBeenLastCalledWith(expect.objectContaining({ ids: [4, 2] }))
    expect(await store.getState().logRetention()).toBe(90)
    await store.getState().setLogRetention(30)
    expect(api.oplog.setRetention).toHaveBeenCalledWith(30)
    expect((await store.getState().getJob(4)).status).toBe('failed')
  })

  test('requestView holds an image id until cleared', async () => {
    const { store } = await ready()
    store.getState().requestView(5)
    expect(store.getState().viewRequest).toBe(5)
    store.getState().clearViewRequest()
    expect(store.getState().viewRequest).toBeNull()
  })
})

describe('hidden images and the lock', () => {
  const hiddenOpen = (id: number): ImageRecord => ({ ...image(id), hidden: true, tags: ['secret'], infotext: 'p', seed: 9 })
  const hiddenLocked = (id: number): ImageRecord => ({
    ...image(id), jobId: 0, hidden: true, url: '', thumbUrl: '', infotext: '', seed: 0, tags: [], locked: true,
  })

  test('init loads the lock state', async () => {
    const { store } = await ready()
    expect(store.getState().lock).toEqual({ hasPassword: true, open: false })
  })

  test('a lock event that closes it covers hidden images at once and reloads the gallery', async () => {
    const fake = fakeApi()
    fake.api.images.list.mockResolvedValueOnce([image(5), hiddenOpen(4)])
    const store = createAppStore(fake.api)
    await store.getState().init()
    const reload = deferred<ImageRecord[]>()
    fake.api.images.list.mockReturnValueOnce(reload.promise)
    fake.emit('lock', { hasPassword: true, open: false })
    // Before the reload answers, the hidden image already carries nothing to show.
    expect(store.getState().images.find((i) => i.id === 4)).toEqual(hiddenLocked(4))
    expect(store.getState().lock.open).toBe(false)
    expect(fake.api.images.list).toHaveBeenLastCalledWith({ limit: 100 })
    reload.resolve([image(5), hiddenLocked(4)])
    await vi.waitFor(() => expect(store.getState().images.map((i) => i.id)).toEqual([5, 4]))
  })

  test('opening the lock reloads the gallery with the hidden images', async () => {
    const fake = fakeApi()
    fake.api.images.list.mockResolvedValueOnce([image(5), hiddenLocked(4)])
    const store = createAppStore(fake.api)
    await store.getState().init()
    fake.api.images.list.mockResolvedValueOnce([image(5), hiddenOpen(4)])
    await store.getState().unlock('secret-pass')
    expect(fake.api.lock.open).toHaveBeenCalledWith('secret-pass')
    fake.emit('lock', { hasPassword: true, open: true })
    await vi.waitFor(() => expect(store.getState().images[1]).toEqual(hiddenOpen(4)))
    expect(store.getState().lock).toEqual({ hasPassword: true, open: true })
  })

  test('unlock rejects with the error key on a wrong password', async () => {
    const { api, store } = await ready()
    api.lock.open.mockRejectedValueOnce(new Error('error.wrongPassword'))
    await expect(store.getState().unlock('nope')).rejects.toThrow('error.wrongPassword')
  })

  test('the reload keeps every page that was loaded before', async () => {
    const fake = fakeApi()
    const page = (from: number) => Array.from({ length: 100 }, (_, i) => image(from - i))
    fake.api.images.list.mockResolvedValueOnce(page(300))
    const store = createAppStore(fake.api)
    await store.getState().init()
    fake.api.images.list.mockResolvedValueOnce(page(200))
    await store.getState().loadMoreImages()
    expect(store.getState().images).toHaveLength(200)
    fake.api.images.list.mockClear()
    fake.api.images.list.mockResolvedValueOnce(page(300)).mockResolvedValueOnce(page(200))
    fake.emit('images:changed', { ids: [250] })
    await vi.waitFor(() => expect(fake.api.images.list).toHaveBeenCalledTimes(2))
    expect(fake.api.images.list.mock.calls.map((c) => c[0])).toEqual([{ limit: 100 }, { limit: 100, beforeId: 201 }])
    await vi.waitFor(() => expect(store.getState().images).toHaveLength(200))
  })

  test('an older page that answers after the lock closed is dropped', async () => {
    const fake = fakeApi()
    fake.api.images.list.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => image(200 - i)))
    const store = createAppStore(fake.api)
    await store.getState().init()
    const older = deferred<ImageRecord[]>()
    fake.api.images.list.mockReturnValueOnce(older.promise)
    const more = store.getState().loadMoreImages()
    fake.api.images.list.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => image(200 - i)))
    fake.emit('lock', { hasPassword: true, open: false })
    older.resolve([hiddenOpen(100)])
    await more
    await vi.waitFor(() => expect(fake.api.images.list).toHaveBeenCalledTimes(3))
    expect(store.getState().images.some((i) => i.id === 100)).toBe(false)
  })

  test('the first hide without a password asks for one, then hides', async () => {
    const fake = fakeApi()
    fake.api.lock.state.mockResolvedValueOnce({ hasPassword: false, open: false })
    const store = createAppStore(fake.api)
    await store.getState().init()
    await store.getState().setHidden([5], true)
    expect(fake.api.images.setHidden).not.toHaveBeenCalled()
    expect(store.getState().lockDialog).toBe('set')
    await store.getState().setLockPassword(null, 'secret-pass')
    expect(fake.api.lock.setPassword).toHaveBeenCalledWith(null, 'secret-pass')
    expect(fake.api.images.setHidden).toHaveBeenCalledWith([5], true)
    expect(store.getState().lockDialog).toBeNull()
  })

  test('closing the password dialog drops the waiting hide', async () => {
    const fake = fakeApi()
    fake.api.lock.state.mockResolvedValueOnce({ hasPassword: false, open: false })
    const store = createAppStore(fake.api)
    await store.getState().init()
    await store.getState().setHidden([5], true)
    store.getState().closeLockDialog()
    fake.emit('lock', { hasPassword: true, open: false })
    await store.getState().setLockPassword(null, 'secret-pass')
    expect(fake.api.images.setHidden).not.toHaveBeenCalled()
  })

  test('with a password set, hiding goes straight to main; a refusal shows as lastError', async () => {
    const { api, store } = await ready()
    await store.getState().setHidden([5, 4], true)
    expect(api.images.setHidden).toHaveBeenCalledWith([5, 4], true)
    api.images.setHidden.mockRejectedValueOnce(new Error('error.notFound'))
    await store.getState().setHidden([5], false)
    expect(store.getState().lastError).toBe('error.notFound')
  })

  test('lockNow closes the lock in main', async () => {
    const { api, store } = await ready()
    await store.getState().lockNow()
    expect(api.lock.close).toHaveBeenCalled()
  })
})

describe('fix round 1: the gallery never shows a stale unlocked copy', () => {
  test('a first page that answers after a lock event started a reload is dropped', async () => {
    const fake = fakeApi()
    const first = deferred<ImageRecord[]>()
    fake.api.images.list.mockReturnValueOnce(first.promise)
    fake.api.images.list.mockResolvedValueOnce([image(5), { ...image(4), hidden: true, url: '', thumbUrl: '', seed: 0, jobId: 0, locked: true }])
    const store = createAppStore(fake.api)
    const init = store.getState().init()
    await vi.waitFor(() => expect(fake.api.images.list).toHaveBeenCalledTimes(1))
    fake.emit('lock', { hasPassword: true, open: false })
    await vi.waitFor(() => expect(store.getState().images.map((i) => i.locked)).toEqual([false, true]))
    first.resolve([image(5), { ...image(4), hidden: true, infotext: 'p', seed: 9 }])
    await init
    expect(store.getState().images.find((i) => i.id === 4)!.locked).toBe(true)
  })

  test('closing the lock covers an image hidden since the last reload, before the reload answers', async () => {
    const fake = fakeApi()
    const store = createAppStore(fake.api)
    await store.getState().init()
    const stale = deferred<ImageRecord[]>()
    fake.api.images.list.mockReturnValueOnce(stale.promise)
    fake.emit('images:changed', { ids: [5] })
    const reload = deferred<ImageRecord[]>()
    fake.api.images.list.mockReturnValueOnce(reload.promise)
    fake.emit('lock', { hasPassword: true, open: false })
    const five = store.getState().images.find((i) => i.id === 5)!
    expect(five).toMatchObject({ locked: true, url: '', thumbUrl: '', jobId: 0 })
    expect(store.getState().images.find((i) => i.id === 4)!.locked).toBe(false)
    reload.resolve([{ ...image(5), hidden: true, url: '', thumbUrl: '', seed: 0, jobId: 0, locked: true }, image(4)])
    stale.resolve([image(5), image(4)])
    await vi.waitFor(() => expect(fake.api.images.list).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(store.getState().images.find((i) => i.id === 5)!.locked).toBe(true))
  })
})

test('selecting a model replaces a hires upscaler the catalog does not list and keeps the other second-pass values', async () => {
  const { api, store } = await ready()
  const listed = 'Latent'
  store.setState((s) => ({ catalog: { ...s.catalog!, upscalers: [listed] } }))
  store.getState().setParams({ hires: { scale: 2, upscaler: 'Gone 4x', secondPassSteps: 9, denoisingStrength: 0.3 } })
  api.catalog.defaults.mockResolvedValueOnce(paramsFor('a.safetensors', {
    hires: { scale: 1, upscaler: listed, secondPassSteps: 12, denoisingStrength: 0.5 },
  }))
  await store.getState().selectCheckpoint('a.safetensors')
  expect(store.getState().params?.hires).toEqual({ scale: 2, upscaler: listed, secondPassSteps: 9, denoisingStrength: 0.3 })
})
