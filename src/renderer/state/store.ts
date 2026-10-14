import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Api, AppSettings, ConnectionCheck, IpcErrorKey, ServerInput } from '@shared/ipc'
import type {
  Catalog, ConnectionStatus, ForgeCapabilities, GenerationParams, ImageRecord, Job, JobProgress, NegativePreset,
  OplogCategory, OplogEntry, OplogLevel, OplogQuery, PartStatus, RestartOutcome, ServerInfo,
} from '@shared/types'
import { errorKeyOf } from '../i18n/error-text'

const IMAGE_PAGE = 100
/** Log entries the panel holds; older ones need a narrower filter. */
export const LOG_LIMIT = 1000

export type LogPeriod = '1h' | '24h' | '7d' | 'all'
export interface LogFilters { level: OplogLevel | 'all'; category: OplogCategory | 'all'; period: LogPeriod }
const PERIOD_MS: Record<Exclude<LogPeriod, 'all'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 }

/** The main-side query for the panel's filters; the period counts back from `now`. */
export function logQuery(f: LogFilters, now: number): OplogQuery {
  return {
    ...(f.level !== 'all' ? { level: f.level } : {}),
    ...(f.category !== 'all' ? { category: f.category } : {}),
    ...(f.period !== 'all' ? { from: now - PERIOD_MS[f.period] } : {}),
    limit: LOG_LIMIT,
  }
}

export interface AppState {
  connection: ConnectionStatus
  settings: AppSettings | null
  /** Saved servers, ordered by name; at most one is active. */
  servers: ServerInfo[]
  /** Saved negative prompts, ordered by name. */
  negativePresets: NegativePreset[]
  catalog: Catalog | null
  /** Why the catalog could not be loaded, as an error key; null when it loaded or was not requested. */
  catalogError: IpcErrorKey | null
  /** The latest failed user action, as an error key, until dismissed. */
  lastError: IpcErrorKey | null
  params: GenerationParams | null
  /** Text entered before the model catalog has supplied generation parameters. */
  draftPrompt: string
  parts: PartStatus[]
  jobs: Record<number, Job>
  progress: Record<number, JobProgress>
  images: ImageRecord[]
  /** True once a page came back short: there are no older images to load. */
  imagesExhausted: boolean
  panelOpen: boolean
  /** What the active Forge allows; restart needs --api-server-stop. */
  capabilities: ForgeCapabilities
  /** Generations keep failing with HTTP 500; false again after a success, a restart, a switch or a dismissal. */
  forgeUnhealthy: boolean
  /** The restart confirmation opened from a job tile or the unhealthy notice. */
  restartAsked: boolean
  logOpen: boolean
  /** Newest first, matching logFilters; new entries arrive live while the panel is open. */
  logEntries: OplogEntry[]
  logFilters: LogFilters
  /** An image another part of the window asked the gallery to show in the viewer. */
  viewRequest: number | null
  /** Safe to call twice: data is loaded once and event subscriptions are registered once. */
  init(): Promise<void>
  setParams(patch: Partial<GenerationParams>): void
  /** Takes the family defaults for a checkpoint, keeping the prompt, negative prompt and image size. */
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
  /** Tests and saves a server; resolves the check (a failed refresh afterwards counts as a failure). */
  addServer(input: ServerInput): Promise<ConnectionCheck>
  updateServer(id: number, input: ServerInput): Promise<ConnectionCheck>
  /** Rejects with the error key when main refuses (e.g. error.jobRunning). */
  removeServer(id: number): Promise<void>
  /** Rejects with the error key when main refuses (e.g. error.jobRunning). */
  activateServer(id: number): Promise<void>
  /** The negative-preset changes reject with the error key when main refuses (e.g. error.presetNameTaken). */
  addNegativePreset(name: string, text: string): Promise<void>
  renameNegativePreset(id: number, name: string): Promise<void>
  removeNegativePreset(id: number): Promise<void>
  dismissError(): void
  togglePanel(): void
  askRestart(): void
  closeRestart(): void
  /** Rejects with the error key when the request fails (e.g. error.network). */
  restartForge(): Promise<RestartOutcome>
  /** Rejects with the error key when main refuses (e.g. error.jobRunning). */
  unloadModel(): Promise<void>
  /** Hides the unhealthy notice until Forge is reported unhealthy again. */
  dismissUnhealthy(): void
  /** Opens or closes the log panel (closing the parameters panel); opening loads the entries. */
  toggleLog(): void
  setLogFilters(patch: Partial<LogFilters>): void
  /** Resolves false when the save dialog was cancelled; rejects with the error key. */
  exportLog(): Promise<boolean>
  logRetention(): Promise<number>
  setLogRetention(days: number): Promise<void>
  /** Any stored job; rejects with the error key (error.notFound when it is gone). */
  getJob(id: number): Promise<Job>
  requestView(imageId: number): void
  clearViewRequest(): void
}

const OFFLINE: ConnectionStatus = { state: 'offline', latencyMs: null, attempts: 0, lastOkAt: null }

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

export function createAppStore(api: Api): StoreApi<AppState> {
  let initPromise: Promise<void> | null = null
  let partsSeq = 0
  // Bumped by every checkpoint selection and catalog load; a response from an older one is dropped.
  let selectSeq = 0
  let catalogSeq = 0
  let presetsSeq = 0
  // Bumped by each forge:capabilities / forge:health event: a load that started earlier is older.
  let capabilitiesSeq = 0
  let healthSeq = 0
  let logSeq = 0
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
      const seq = ++selectSeq
      let defaults: GenerationParams
      try {
        defaults = await api.catalog.defaults(title)
      } catch (e) {
        if (seq === selectSeq) throw e
        return // a newer choice replaced this one; its failure no longer matters
      }
      if (seq !== selectSeq) return
      const current = get().params
      const params: GenerationParams = {
        ...defaults,
        prompt: current?.prompt ?? get().draftPrompt,
        negativePrompt: current?.negativePrompt ?? defaults.negativePrompt,
        width: current?.width ?? defaults.width,
        height: current?.height ?? defaults.height,
      }
      set({ params, draftPrompt: params.prompt })
      await refreshParts(params)
    }

    /** Loads the catalog and selects the loaded checkpoint, else the first one. */
    async function loadCatalog(refresh = false): Promise<void> {
      const seq = ++catalogSeq
      let catalog: Catalog
      try {
        catalog = await (refresh ? api.catalog.get(true) : api.catalog.get())
      } catch (e) {
        if (seq === catalogSeq) set({ catalog: null, catalogError: errorKeyOf(e) })
        return
      }
      if (seq !== catalogSeq) return
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

    /**
     * Re-reads settings and the server list after a server change. When the active address changed,
     * the catalog of the new server is loaded, or everything tied to a server is cleared when none is left.
     */
    async function syncServers(): Promise<void> {
      const before = get().settings?.serverUrl ?? null
      const [settings, servers] = await Promise.all([api.settings.get(), api.servers.list()])
      set({ settings, servers })
      if (settings.serverUrl === before) return
      // Everything tied to the old server goes at once, so Generate cannot submit its checkpoint to the
      // new one while the new catalog loads; pending selections of the old server are dropped. The prompt stays.
      partsSeq++
      selectSeq++
      catalogSeq++
      set((s) => ({
        catalog: null, catalogError: null, params: null, parts: [], draftPrompt: s.params?.prompt ?? s.draftPrompt,
      }))
      // The new catalog loads in the background (its LoRA list can take a minute); the prompt bar shows
      // that models are loading, and the server dialog is free again at once.
      if (settings.serverUrl) void loadCatalog()
    }

    /** Runs a server call that resolves a check; an ok check is followed by a refresh. */
    async function checked(call: () => Promise<ConnectionCheck>): Promise<ConnectionCheck> {
      const check = await call()
      if (!check.ok) return check
      try {
        await syncServers()
      } catch (e) {
        // Saved, but the app cannot see it: report a failure rather than a stuck success.
        return { ok: false, latencyMs: null, errorKey: errorKeyOf(e) }
      }
      return check
    }

    /** Reloads the negative presets; only the newest request may set the list. */
    async function loadPresets(): Promise<void> {
      const seq = ++presetsSeq
      const list = await attempt(() => api.negativePresets.list())
      if (list && seq === presetsSeq) set({ negativePresets: list })
    }

    /** Runs a preset change (rejecting on refusal) and then reloads the list. */
    async function changePresets(call: () => Promise<unknown>): Promise<void> {
      await call()
      await loadPresets()
    }

    function forgetJob(id: number): void {
      finished.add(id)
      set((s) => {
        const jobs = { ...s.jobs }
        const progress = { ...s.progress }
        delete jobs[id]
        delete progress[id]
        return { jobs, progress }
      })
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
      api.on('job:removed', ({ id }) => forgetJob(id))
      api.on('servers', (servers) => set({ servers }))
      api.on('forge:capabilities', (capabilities) => {
        capabilitiesSeq++
        set({ capabilities })
      })
      api.on('forge:health', ({ unhealthy }) => {
        healthSeq++
        set({ forgeUnhealthy: unhealthy })
      })
      api.on('oplog:added', (entry) =>
        set((s) => (!s.logOpen || !matchesLog(entry, s.logFilters) || s.logEntries.some((e) => e.id === entry.id)
          ? s
          : { logEntries: [entry, ...s.logEntries].slice(0, LOG_LIMIT) })),
      )
    }

    /** Reloads the log for the current filters; only the newest request may set the entries. */
    async function loadLog(): Promise<void> {
      const seq = ++logSeq
      const entries = await attempt(() => api.oplog.list(logQuery(get().logFilters, Date.now())))
      if (!entries || seq !== logSeq) return
      // Entries pushed live while this request ran are newer than its answer.
      set((s) => ({ logEntries: [...s.logEntries.filter((e) => !entries.some((x) => x.id === e.id) && e.id > (entries[0]?.id ?? 0)), ...entries] }))
    }

    function matchesLog(e: OplogEntry, f: LogFilters): boolean {
      return (f.level === 'all' || e.level === f.level) && (f.category === 'all' || e.category === f.category)
    }

    /** Loads what the active Forge allows and its health; an event that arrived meanwhile is newer. */
    async function loadForgeState(): Promise<void> {
      const [caps, health] = [capabilitiesSeq, healthSeq]
      const [capabilities, state] = await Promise.all([
        attempt(() => api.forge.capabilities()),
        attempt(() => api.forge.health()),
      ])
      if (capabilities && caps === capabilitiesSeq) set({ capabilities })
      if (state && health === healthSeq) set({ forgeUnhealthy: state.unhealthy })
    }

    async function load(): Promise<void> {
      subscribe()
      const [settings, servers, connection, active, images] = await Promise.all([
        attempt(() => api.settings.get()),
        attempt(() => api.servers.list()),
        attempt(() => api.connection.get()),
        attempt(() => api.jobs.listActive()),
        attempt(() => api.images.list({ limit: IMAGE_PAGE })),
      ])
      set((s) => ({
        settings: settings ?? s.settings,
        servers: servers ?? s.servers,
        connection: connection ?? s.connection,
        jobs: active ? { ...Object.fromEntries(fresh(active)), ...s.jobs } : s.jobs,
        images: images
          ? [...s.images.filter((i) => !images.some((l) => l.id === i.id)), ...images]
          : s.images,
        imagesExhausted: images ? images.length < IMAGE_PAGE : s.imagesExhausted,
      }))
      await Promise.all([loadPresets(), loadForgeState(), settings?.serverUrl ? loadCatalog() : undefined])
    }

    return {
      connection: OFFLINE,
      settings: null,
      servers: [],
      negativePresets: [],
      catalog: null,
      catalogError: null,
      lastError: null,
      params: null,
      draftPrompt: '',
      parts: [],
      jobs: {},
      progress: {},
      images: [],
      imagesExhausted: false,
      panelOpen: false,
      capabilities: { canRestart: false },
      forgeUnhealthy: false,
      restartAsked: false,
      logOpen: false,
      logEntries: [],
      logFilters: { level: 'all', category: 'all', period: '24h' },
      viewRequest: null,

      init() {
        initPromise ??= load()
        return initPromise
      },

      setParams(patch) {
        const before = get().params
        if (!before) {
          if (patch.prompt !== undefined) set({ draftPrompt: patch.prompt })
          return
        }
        const params = { ...before, ...patch }
        set({ params, draftPrompt: params.prompt })
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
        forgetJob(id)
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

      addServer(input) {
        return checked(() => api.servers.add(input))
      },

      updateServer(id, input) {
        return checked(() => api.servers.update(id, input))
      },

      async removeServer(id) {
        await api.servers.remove(id)
        await syncServers()
      },

      async activateServer(id) {
        await api.servers.activate(id)
        await syncServers()
      },

      addNegativePreset(name, text) {
        return changePresets(() => api.negativePresets.add({ name, text }))
      },

      renameNegativePreset(id, name) {
        return changePresets(() => api.negativePresets.update(id, { name }))
      },

      removeNegativePreset(id) {
        return changePresets(() => api.negativePresets.remove(id))
      },

      dismissError() {
        set({ lastError: null })
      },

      togglePanel() {
        set((s) => ({ panelOpen: !s.panelOpen, logOpen: false }))
      },

      toggleLog() {
        const open = !get().logOpen
        set({ logOpen: open, panelOpen: false })
        if (open) {
          set({ logEntries: [] })
          void loadLog()
        } else logSeq++
      },

      setLogFilters(patch) {
        set((s) => ({ logFilters: { ...s.logFilters, ...patch }, logEntries: [] }))
        void loadLog()
      },

      exportLog() {
        return api.oplog.export(logQuery(get().logFilters, Date.now()))
      },

      logRetention() {
        return api.oplog.retention()
      },

      setLogRetention(days) {
        return api.oplog.setRetention(days)
      },

      getJob(id) {
        return api.jobs.get(id)
      },

      requestView(imageId) {
        set({ viewRequest: imageId })
      },

      clearViewRequest() {
        set({ viewRequest: null })
      },

      askRestart() {
        set({ restartAsked: true })
      },

      closeRestart() {
        set({ restartAsked: false })
      },

      async restartForge() {
        const outcome = await api.forge.restart()
        if (outcome === 'restarting') {
          healthSeq++
          set({ forgeUnhealthy: false })
        }
        return outcome
      },

      async unloadModel() {
        await api.forge.unload()
      },

      dismissUnhealthy() {
        set({ forgeUnhealthy: false })
      },
    }
  })
}
