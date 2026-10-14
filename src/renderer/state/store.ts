import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Api, AppSettings, ConnectionCheck, IpcErrorKey } from '@shared/ipc'
import type {
  Catalog, ConnectionStatus, GenerationParams, ImageRecord, Job, JobProgress, PartStatus,
} from '@shared/types'
import { errorKeyOf } from '../i18n/error-text'

const IMAGE_PAGE = 100

export interface AppState {
  connection: ConnectionStatus
  settings: AppSettings | null
  catalog: Catalog | null
  /** Why the catalog could not be loaded, as an error key; null when it loaded or was not requested. */
  catalogError: IpcErrorKey | null
  /** The latest failed user action, as an error key, until dismissed. */
  lastError: IpcErrorKey | null
  params: GenerationParams | null
  parts: PartStatus[]
  jobs: Record<number, Job>
  progress: Record<number, JobProgress>
  images: ImageRecord[]
  /** True once a page came back short: there are no older images to load. */
  imagesExhausted: boolean
  panelOpen: boolean
  /** Safe to call twice: data is loaded once and event subscriptions are registered once. */
  init(): Promise<void>
  setParams(patch: Partial<GenerationParams>): void
  /** Takes the family defaults for a checkpoint, keeping the prompt and the negative prompt. */
  selectCheckpoint(title: string): Promise<void>
  /** Reloads the catalog from the server (refresh) after a failed or stale load. */
  retryCatalog(): Promise<void>
  generate(): Promise<void>
  cancelJob(id: number): Promise<void>
  retryJob(id: number): Promise<void>
  deleteImage(id: number): Promise<void>
  /** Removes a failed or interrupted job from the list; there is nothing to tell the main process. */
  dismissJob(id: number): void
  /** Appends the next page of older images; concurrent calls share one request. */
  loadMoreImages(): Promise<void>
  setServerUrl(url: string): Promise<ConnectionCheck>
  dismissError(): void
  togglePanel(): void
}

const OFFLINE: ConnectionStatus = { state: 'offline', latencyMs: null, attempts: 0, lastOkAt: null }

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

export function createAppStore(api: Api): StoreApi<AppState> {
  let initPromise: Promise<void> | null = null
  let partsSeq = 0
  let morePromise: Promise<void> | null = null
  /** Jobs a terminal update or a dismissal removed this session; a stale copy of them is never merged back. */
  const finished = new Set<number>()
  const fresh = (jobs: readonly Job[]): Array<[number, Job]> =>
    jobs.filter((j) => !finished.has(j.id)).map((j) => [j.id, j])

  return createStore<AppState>()((set, get) => {
    const fail = (e: unknown): void => set({ lastError: errorKeyOf(e) })

    /** Runs a call whose failure is reported through lastError; resolves undefined on failure. */
    async function attempt<T>(call: () => Promise<T>): Promise<T | undefined> {
      try {
        return await call()
      } catch (e) {
        fail(e)
        return undefined
      }
    }

    async function refreshParts(params: GenerationParams): Promise<void> {
      const seq = ++partsSeq
      try {
        const parts = await api.catalog.parts(params)
        if (seq === partsSeq) set({ parts })
      } catch (e) {
        if (seq === partsSeq) fail(e)
      }
    }

    async function useCheckpoint(title: string): Promise<void> {
      const defaults = await api.catalog.defaults(title)
      const current = get().params
      const params: GenerationParams = {
        ...defaults,
        prompt: current?.prompt ?? defaults.prompt,
        negativePrompt: current?.negativePrompt ?? defaults.negativePrompt,
      }
      set({ params })
      await refreshParts(params)
    }

    /** Loads the catalog and selects the loaded checkpoint, else the first one. */
    async function loadCatalog(refresh = false): Promise<void> {
      let catalog: Catalog
      try {
        catalog = await (refresh ? api.catalog.get(true) : api.catalog.get())
      } catch (e) {
        set({ catalog: null, catalogError: errorKeyOf(e) })
        return
      }
      set({ catalog, catalogError: null })
      const { checkpoints, loadedCheckpoint } = catalog
      const pick = checkpoints.find((c) => c.title === loadedCheckpoint) ?? checkpoints[0]
      if (!pick) {
        partsSeq++
        set({ params: null, parts: [] })
        return
      }
      try {
        await useCheckpoint(pick.title)
      } catch (e) {
        fail(e)
      }
    }

    function subscribe(): void {
      api.on('job:update', (job) =>
        set((s) => {
          const jobs = { ...s.jobs }
          const progress = { ...s.progress }
          if (job.status === 'done' || job.status === 'cancelled') {
            delete jobs[job.id]
            finished.add(job.id)
          } else jobs[job.id] = job
          if (job.status !== 'running') delete progress[job.id]
          return { jobs, progress }
        }),
      )
      api.on('job:progress', (p) => set((s) => ({ progress: { ...s.progress, [p.jobId]: p } })))
      api.on('image:added', (image) =>
        set((s) => (s.images.some((i) => i.id === image.id) ? s : { images: [image, ...s.images] })),
      )
      api.on('image:removed', ({ id }) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })))
      api.on('connection', (connection) => set({ connection }))
    }

    async function load(): Promise<void> {
      subscribe()
      const [settings, connection, active, images] = await Promise.all([
        attempt(() => api.settings.get()),
        attempt(() => api.connection.get()),
        attempt(() => api.jobs.listActive()),
        attempt(() => api.images.list({ limit: IMAGE_PAGE })),
      ])
      set((s) => ({
        settings: settings ?? s.settings,
        connection: connection ?? s.connection,
        jobs: active ? { ...Object.fromEntries(fresh(active)), ...s.jobs } : s.jobs,
        images: images
          ? [...s.images.filter((i) => !images.some((l) => l.id === i.id)), ...images]
          : s.images,
        imagesExhausted: images ? images.length < IMAGE_PAGE : s.imagesExhausted,
      }))
      if (settings?.serverUrl) await loadCatalog()
    }

    return {
      connection: OFFLINE,
      settings: null,
      catalog: null,
      catalogError: null,
      lastError: null,
      params: null,
      parts: [],
      jobs: {},
      progress: {},
      images: [],
      imagesExhausted: false,
      panelOpen: false,

      init() {
        initPromise ??= load()
        return initPromise
      },

      setParams(patch) {
        const before = get().params
        if (!before) return
        const params = { ...before, ...patch }
        set({ params })
        if (params.checkpoint !== before.checkpoint || !sameList(params.modules, before.modules)) {
          void refreshParts(params)
        }
      },

      async selectCheckpoint(title) {
        try {
          await useCheckpoint(title)
        } catch (e) {
          fail(e)
        }
      },

      async retryCatalog() {
        await loadCatalog(true)
      },

      async generate() {
        const { params } = get()
        if (!params || params.prompt.trim() === '') return
        const created = await attempt(() => api.jobs.enqueue(params))
        if (!created) return
        // Queued jobs raise no job:update; a job an event already delivered is newer than this copy.
        set((s) => ({
          lastError: null,
          jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs },
        }))
      },

      async cancelJob(id) {
        await attempt(() => api.jobs.cancel(id))
      },

      async retryJob(id) {
        const clone = await attempt(() => api.jobs.retry(id))
        if (clone) set((s) => ({ jobs: { ...Object.fromEntries(fresh([clone])), ...s.jobs } }))
      },

      async deleteImage(id) {
        await attempt(() => api.images.delete(id))
      },

      dismissJob(id) {
        finished.add(id)
        set((s) => {
          const jobs = { ...s.jobs }
          delete jobs[id]
          return { jobs }
        })
      },

      loadMoreImages() {
        morePromise ??= (async () => {
          try {
            const { images, imagesExhausted } = get()
            if (imagesExhausted || images.length === 0) return
            const beforeId = Math.min(...images.map((i) => i.id))
            const page = await attempt(() => api.images.list({ limit: IMAGE_PAGE, beforeId }))
            if (!page) return
            set((s) => ({
              images: [...s.images, ...page.filter((p) => !s.images.some((i) => i.id === p.id))],
              imagesExhausted: page.length < IMAGE_PAGE,
            }))
          } finally {
            morePromise = null
          }
        })()
        return morePromise
      },

      async setServerUrl(url) {
        const check = await api.settings.setServerUrl(url)
        if (!check.ok) return check
        try {
          set({ settings: await api.settings.get() })
        } catch (e) {
          // The address was accepted but the app cannot see it: report a failure rather than a stuck success.
          return { ok: false, latencyMs: null, errorKey: errorKeyOf(e) }
        }
        await loadCatalog()
        return check
      },

      dismissError() {
        set({ lastError: null })
      },

      togglePanel() {
        set((s) => ({ panelOpen: !s.panelOpen }))
      },
    }
  })
}
