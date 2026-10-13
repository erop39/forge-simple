import type { Api, AppEvents, ConnectionCheck } from '@shared/ipc'
import type {
  Catalog, GenerationParams, ImageRecord, Job, JobProgress, PartStatus,
} from '@shared/types'
import { createAppStore } from './store'

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
  loadedCheckpoint: 'b.safetensors', fetchedAt: 1, ...over,
})

const job = (id: number, status: Job['status'] = 'queued'): Job => ({
  id, serverId: 1, type: 'txt2img', status, params: baseParams, error: null,
  createdAt: 1, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
})
const image = (id: number): ImageRecord => ({
  id, jobId: 1, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/t${id}.jpg`, width: 1, height: 1,
  seed: 1, infotext: '', createdAt: 1, durationMs: null, hidden: false, sourceImageId: null,
})
const progress = (jobId: number): JobProgress => ({
  jobId, step: 3, totalSteps: 20, stage: 'sampling', stepsPerSec: 2, elapsedMs: 1000, preview: null,
})
const connected = { state: 'connected', latencyMs: 38, attempts: 0, lastOkAt: 1 } as const

function fakeApi(over: { serverUrl?: string | null; catalog?: Catalog } = {}) {
  const handlers = new Map<string, Array<(payload: never) => void>>()
  const cat = over.catalog ?? catalog()
  const api = {
    settings: {
      get: vi.fn(async () => ({ serverUrl: over.serverUrl === undefined ? 'http://127.0.0.1:7861' : over.serverUrl, imagesDir: 'C:\\images' })),
      setServerUrl: vi.fn(async (): Promise<ConnectionCheck> => ({ ok: true, latencyMs: 12, errorKey: null })),
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
    },
    images: { list: vi.fn(async (): Promise<ImageRecord[]> => [image(5), image(4)]), delete: vi.fn(async () => {}) },
    connection: { get: vi.fn(async () => connected) },
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

test('init is safe to call twice: one load, one set of subscriptions', async () => {
  const { api, store } = await ready()
  await store.getState().init()
  expect(api.settings.get).toHaveBeenCalledTimes(1)
  expect(api.on).toHaveBeenCalledTimes(5)
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

test('setServerUrl on success refreshes settings and the catalog and selects a checkpoint', async () => {
  const { api, store } = await ready({ serverUrl: null })
  api.settings.get.mockResolvedValueOnce({ serverUrl: 'http://127.0.0.1:7861', imagesDir: 'C:\\images' })
  const check = await store.getState().setServerUrl('127.0.0.1:7861')
  expect(check.ok).toBe(true)
  expect(store.getState().settings?.serverUrl).toBe('http://127.0.0.1:7861')
  expect(store.getState().catalog).not.toBeNull()
  expect(store.getState().params?.checkpoint).toBe('b.safetensors')
})

test('setServerUrl on failure returns the check and changes nothing else', async () => {
  const { api, store } = await ready({ serverUrl: null })
  api.settings.setServerUrl.mockResolvedValueOnce({ ok: false, latencyMs: null, errorKey: 'error.network' })
  api.settings.get.mockClear()
  const check = await store.getState().setServerUrl('nowhere')
  expect(check).toEqual({ ok: false, latencyMs: null, errorKey: 'error.network' })
  expect(api.settings.get).not.toHaveBeenCalled()
  expect(store.getState().catalog).toBeNull()
})

test('togglePanel flips panelOpen', async () => {
  const { store } = await ready()
  store.getState().togglePanel()
  expect(store.getState().panelOpen).toBe(true)
})
