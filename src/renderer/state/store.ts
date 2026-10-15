import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Api, AppSettings, ConnectionCheck, IpcErrorKey, ServerInput } from '@shared/ipc'
import type {
  Catalog, ConnectionStatus, Family, ForgeCapabilities, GenerationParams, ImageRecord, Job, JobProgress, LockState, ModelKind, NegativePreset, UpscaleSettings, HiresSettings,
  OplogCategory, OplogEntry, OplogLevel, OplogQuery, PartStatus, ResourceSnapshot, RestartOutcome, ServerInfo,
} from '@shared/types'
import { PROFILES } from '@shared/profiles'
import { errorKeyOf } from '../i18n/error-text'
import { t } from '../i18n/t'

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

/** Which lock dialog is open: setting the first password, unlocking, or changing the password. */
export type LockDialogMode = 'set' | 'open' | 'change'

/** A hidden image as main sends it while locked: nothing that shows or describes the picture. */
export const lockedCopy = (image: ImageRecord): ImageRecord =>
  ({ ...image, jobId: 0, sourceImageId: null, enhanced: false, url: '', thumbUrl: '', infotext: '', seed: 0, tags: [], locked: true })

export interface AppState {
  connection: ConnectionStatus
  resources: ResourceSnapshot
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
  /**
   * The negative prompt to carry into the next model's parameters (a server switch clears them); null until
   * a model with a negative was chosen. A family without a negative leaves it unchanged.
   */
  draftNegative: string | null
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
  /** The saved image whose Send to hires dialog is open. */
  hiresFor: number | null
  /** Which model gallery is open (checkpoints or LoRA), if any. */
  modelGallery: ModelKind | null
  logOpen: boolean
  /** Newest first, matching logFilters; new entries arrive live while the panel is open. */
  logEntries: OplogEntry[]
  logFilters: LogFilters
  /** An image another part of the window asked the gallery to show in the viewer. */
  viewRequest: number | null
  /** The session lock over hidden images, as main last reported it. */
  lock: LockState
  lockDialog: LockDialogMode | null
  /** Safe to call twice: data is loaded once and event subscriptions are registered once. */
  init(): Promise<void>
  setParams(patch: Partial<GenerationParams>): void
  /** Attach a visible saved image; false when it is unavailable, locked, or no model is selected. */
  attachImageSource(id: number): boolean
  /** Return to txt2img and restore the previous hires setting. */
  removeImageSource(): void
  /** Takes the family defaults for a checkpoint, keeping the prompt, negative prompt and image size. */
  selectCheckpoint(title: string): Promise<void>
  /** Reloads the catalog from the server (refresh) after a failed or stale load. */
  retryCatalog(): Promise<void>
  generate(): Promise<void>
  /** Queue a finished image for upscale, preserving the current prompt-bar draft. */
  upscaleImage(id: number, sourceParams: GenerationParams, upscaler: string, scale: UpscaleSettings['scale']): Promise<boolean>
  setDefaultUpscaler(kind: 'hires' | 'finished', name: string): Promise<boolean>
  /** The preset a family starts with when a checkpoint of it is loaded (null = none). */
  setFamilyNegative(family: Family, presetId: number | null): Promise<void>
  chooseImagesDir(): Promise<string | null>
  cancelJob(id: number): Promise<void>
  retryJob(id: number): Promise<void>
  deleteImage(id: number): Promise<void>
  /** Removes a failed or interrupted job from the list; there is nothing to tell the main process. */
  dismissJob(id: number): void
  /** Removes every failed and interrupted job for good (not only from this session). */
  clearUnfinished(): Promise<void>
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
  openHires(id: number): void
  openModelGallery(kind: ModelKind): void
  closeModelGallery(): void
  setModelFavorite(kind: ModelKind, id: string, favorite: boolean): Promise<void>
  setModelNote(kind: ModelKind, id: string, note: string): Promise<void>
  setCheckpointFamily(file: string, family: Family | null): Promise<void>
  setLoraTriggers(path: string, triggers: string[] | null): Promise<void>
  /** Adds a LoRA (by its Forge name) to the stack, enabled at weight 1; false at the 16 limit or when present. */
  addLora(name: string): boolean
  closeHires(): void
  /** Re-runs the image's own job (same model, prompt and seed) with a hires second pass. */
  queueHires(id: number, hires: HiresSettings): Promise<'queued' | 'notTxt2img' | 'failed'>
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
  /**
   * Exports the entries matching the filters, or exactly `ids` (the panel's search results) when given.
   * Resolves false when the save dialog was cancelled; rejects with the error key.
   */
  exportLog(ids?: number[]): Promise<boolean>
  logRetention(): Promise<number>
  setLogRetention(days: number): Promise<void>
  /** Any stored job; rejects with the error key (error.notFound when it is gone). */
  getJob(id: number): Promise<Job>
  requestView(imageId: number): void
  clearViewRequest(): void
  /** Opens a lock dialog; a hide waiting for a first password is dropped. */
  openLockDialog(mode: LockDialogMode): void
  closeLockDialog(): void
  /** Rejects with the error key (error.wrongPassword); closes the dialog on success. */
  unlock(password: string): Promise<void>
  lockNow(): Promise<void>
  /**
   * Sets or changes the password; rejects with the error key. Closes the dialog and carries out a hide that
   * was waiting for the first password.
   */
  setLockPassword(oldPassword: string | null, next: string): Promise<void>
  /** Hides or unhides images; the first hide without a password opens the set-password dialog instead. */
  setHidden(ids: number[], hidden: boolean): Promise<void>
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
  // Bumped by each 'lock' event and password change: a lock state read earlier is older.
  let lockSeq = 0
  // Bumped by each gallery reload: a page requested before it may show what the lock now covers.
  let imagesSeq = 0
  /** Images hidden or unhidden since the last reload finished: their `hidden` flag here may be stale. */
  const changedSinceReload = new Set<number>()
  /** Images to hide once the first password is set. */
  let pendingHide: number[] | null = null
  let morePromise: Promise<void> | null = null
  let hiresBeforeImg2Img: GenerationParams['hires'] | null = null
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

    /** A family without a negative prompt leaves the kept one alone, so it comes back on a family that has one. */
    const keptNegative = (params: GenerationParams, kept: string | null): string | null =>
      PROFILES[params.family].negative ? params.negativePrompt : kept

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
      const { params: current, draftPrompt, draftNegative, negativePresets, settings } = get()
      // Coming to a family (or starting up) loads its default negative, unless the user already typed one before
      // the first model arrived; inside a family the text stays whatever the user left.
      const presetId = settings?.familyNegatives?.[defaults.family]
      const familyDefault = PROFILES[defaults.family].negative && presetId !== undefined
        && (current ? current.family !== defaults.family : draftNegative === null)
        ? negativePresets.find((preset) => preset.id === presetId)?.text : undefined
      const params: GenerationParams = {
        ...defaults,
        prompt: current?.prompt ?? draftPrompt,
        negativePrompt: familyDefault ?? draftNegative ?? defaults.negativePrompt,
        width: current?.width ?? defaults.width,
        height: current?.height ?? defaults.height,
        // An upscaler the new server does not list gives way to its default; the other second-pass values stay.
        hires: current?.hires
          ? { ...current.hires, upscaler: get().catalog?.upscalers.includes(current.hires.upscaler)
            ? current.hires.upscaler : defaults.hires?.upscaler ?? current.hires.upscaler }
          : defaults.hires,
        img2img: current?.img2img,
      }
      set({ params, draftPrompt: params.prompt, draftNegative: keptNegative(params, draftNegative) })
      await refreshParts(params)
    }

    /** Saves a mark on a model file and reads the catalog again (main applies marks without refetching Forge). */
    async function markModel(call: () => Promise<void>): Promise<void> {
      const seq = catalogSeq
      if (await attempt(async () => { await call(); return true }) === undefined) return
      const fresh = await attempt(() => api.catalog.get())
      if (fresh && seq === catalogSeq) set({ catalog: fresh })
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
      // new one while the new catalog loads; pending selections of the old server are dropped. The prompt and
      // the negative prompt stay (draftPrompt and draftNegative already follow every change of the parameters).
      partsSeq++
      selectSeq++
      catalogSeq++
      hiresBeforeImg2Img = null
      set({ catalog: null, catalogError: null, params: null, parts: [] })
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
      api.on('resources', (resources) => set({ resources }))
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
      api.on('lock', (lock) => {
        lockSeq++
        // Covered at once, before the reload answers (and even if it fails); an image whose flag changed since the
        // last reload may be hidden now, so it is covered too until the reload says otherwise.
        set((s) => ({
          lock,
          images: lock.open ? s.images : s.images.map((i) => (i.hidden || changedSinceReload.has(i.id) ? lockedCopy(i) : i)),
        }))
        void reloadImages()
      })
      api.on('images:changed', ({ ids }) => {
        for (const id of ids) changedSinceReload.add(id)
        void reloadImages()
      })
      api.on('oplog:added', (entry) =>
        set((s) => (!s.logOpen || !matchesLog(entry, s.logFilters) || s.logEntries.some((e) => e.id === entry.id)
          ? s
          : { logEntries: [entry, ...s.logEntries].slice(0, LOG_LIMIT) })),
      )
    }

    /**
     * Reads the gallery again from the newest image down to the oldest one loaded before, so the pages already
     * scrolled through stay. Only the newest reload may set the images.
     */
    async function reloadImages(): Promise<void> {
      const seq = ++imagesSeq
      const settled = [...changedSinceReload]
      const before = get().images
      const loadedIds = new Set(before.map((i) => i.id))
      const oldest = before.length > 0 ? Math.min(...loadedIds) : null
      const pages: ImageRecord[] = []
      let exhausted = false
      for (;;) {
        const last = pages[pages.length - 1]
        const page = await attempt(() => api.images.list(last ? { limit: IMAGE_PAGE, beforeId: last.id } : { limit: IMAGE_PAGE }))
        if (!page || seq !== imagesSeq) return
        pages.push(...page)
        if (page.length < IMAGE_PAGE) {
          exhausted = true
          break
        }
        if (oldest === null || page[page.length - 1]!.id <= oldest) break
      }
      const top = pages[0]?.id ?? 0
      for (const id of settled) changedSinceReload.delete(id)
      // Images added while the reload ran are newer than its first page.
      set((s) => ({
        images: [...s.images.filter((i) => i.id > top && !loadedIds.has(i.id)), ...pages],
        imagesExhausted: exhausted,
      }))
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
      const lockAt = lockSeq
      const imagesAt = imagesSeq
      const [settings, servers, connection, active, images, lock] = await Promise.all([
        attempt(() => api.settings.get()),
        attempt(() => api.servers.list()),
        attempt(() => api.connection.get()),
        attempt(() => api.jobs.listActive()),
        attempt(() => api.images.list({ limit: IMAGE_PAGE })),
        attempt(() => api.lock.state()),
      ])
      if (lock && lockAt === lockSeq) set({ lock })
      // A reload that started meanwhile (a lock or hide event) is newer than this first page.
      const firstPage = images && imagesAt === imagesSeq ? images : undefined
      set((s) => ({
        servers: servers ?? s.servers,
        connection: connection ?? s.connection,
        jobs: active ? { ...Object.fromEntries(fresh(active)), ...s.jobs } : s.jobs,
        images: firstPage
          ? [...s.images.filter((i) => !firstPage.some((l) => l.id === i.id)), ...firstPage]
          : s.images,
        imagesExhausted: firstPage ? firstPage.length < IMAGE_PAGE : s.imagesExhausted,
      }))
      // First run: Forge on this PC is saved without asking. Settings stay unset until the check is over,
      // so the server dialog does not open for a moment and close again.
      const local = settings && !settings.serverUrl && servers?.length === 0 ? await findLocalServer() : null
      if (local) set({ servers: local.servers })
      const current = local?.settings ?? settings
      if (current) set({ settings: current })
      // The presets come first: a family's default negative is applied while the first model is selected.
      await loadPresets()
      await Promise.all([loadForgeState(), current?.serverUrl ? loadCatalog() : undefined])
    }

    /** Asks main to save Forge on this PC when it answers; null when it did not (or the check failed). */
    async function findLocalServer(): Promise<{ settings: AppSettings; servers: ServerInfo[] } | null> {
      try {
        if (!(await api.servers.addLocal(t('server.thisPc')))) return null
        const [settings, servers] = await Promise.all([api.settings.get(), api.servers.list()])
        return { settings, servers }
      } catch {
        return null // nothing found: the server dialog opens as usual
      }
    }

    return {
      connection: OFFLINE,
      resources: { samples: [], failed: false, extension: 'unknown' },
      settings: null,
      servers: [],
      negativePresets: [],
      catalog: null,
      catalogError: null,
      lastError: null,
      params: null,
      draftPrompt: '',
      draftNegative: null,
      parts: [],
      jobs: {},
      progress: {},
      images: [],
      imagesExhausted: false,
      panelOpen: false,
      capabilities: { canRestart: false },
      forgeUnhealthy: false,
      restartAsked: false,
      hiresFor: null,
      modelGallery: null,
      logOpen: false,
      logEntries: [],
      logFilters: { level: 'all', category: 'all', period: '24h' },
      viewRequest: null,
      lock: { hasPassword: false, open: false },
      lockDialog: null,

      init() {
        initPromise ??= load()
        return initPromise
      },

      setParams(patch) {
        const before = get().params
        if (!before) {
          if (patch.prompt !== undefined) set({ draftPrompt: patch.prompt })
          if (patch.negativePrompt !== undefined) set({ draftNegative: patch.negativePrompt })
          return
        }
        const params = { ...before, ...patch }
        if (params.img2img && params.hires && params.hires.scale > 1) {
          params.hires = { ...params.hires, scale: 1 }
        }
        if (params.hires && params.hires.scale > 1
          && (params.width * params.hires.scale > 4096 || params.height * params.hires.scale > 4096)) {
          params.hires = { ...params.hires, scale: 1 }
        }
        set((s) => ({ params, draftPrompt: params.prompt, draftNegative: keptNegative(params, s.draftNegative) }))
        if (params.checkpoint !== before.checkpoint || !sameList(params.modules, before.modules)) {
          void refreshParts(params)
        }
      },

      attachImageSource(id) {
        const { images, params } = get()
        const source = images.find((image) => image.id === id)
        if (!params || !source || source.locked) return false
        if (!params.img2img) hiresBeforeImg2Img = params.hires ?? null
        set({ params: {
          ...params,
          img2img: { sourceImageId: id, denoisingStrength: params.img2img?.denoisingStrength ?? 0.5,
            resizeMode: params.img2img?.resizeMode ?? 0 },
          ...(params.hires ? { hires: { ...params.hires, scale: 1 } } : {}),
        } })
        return true
      },

      removeImageSource() {
        const params = get().params
        if (!params?.img2img) return
        set({ params: { ...params, img2img: undefined,
          ...(hiresBeforeImg2Img ? { hires: hiresBeforeImg2Img } : {}),
        } })
        hiresBeforeImg2Img = null
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
        const { params, images } = get()
        if (!params || params.prompt.trim() === '') return
        if (params.img2img && !images.some((image) => image.id === params.img2img!.sourceImageId && !image.locked)) return
        const created = await attempt(() => api.jobs.enqueue(params))
        if (!created) return
        // Queued jobs raise no job:update; a job an event already delivered is newer than this copy.
        set((s) => ({
          lastError: null,
          jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs },
        }))
      },

      async upscaleImage(id, sourceParams, upscaler, scale) {
        const { images, catalog } = get()
        const source = images.find((image) => image.id === id && !image.locked)
        if (!source || !catalog?.upscalers.includes(upscaler)
          || source.width * scale > 4096 || source.height * scale > 4096) return false
        const params: GenerationParams = {
          ...sourceParams,
          count: 1,
          img2img: undefined,
          hires: sourceParams.hires ? { ...sourceParams.hires, scale: 1 } : undefined,
          upscale: { sourceImageId: id, upscaler, scale },
        }
        const created = await attempt(() => api.jobs.enqueue(params))
        if (!created) return false
        set((s) => ({ lastError: null, jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs } }))
        return true
      },

      async setDefaultUpscaler(kind, name) {
        const { catalog, settings } = get()
        const available = catalog?.upscalers ?? []
        if (!settings || !available.includes(name)) return false
        const preferred = settings.upscalers
        const fallback = (value: string | null | undefined, standard: string): string =>
          value && available.includes(value) ? value : available.includes(standard) ? standard : available[0]!
        const next = {
          hires: kind === 'hires' ? name : fallback(preferred?.hires, 'Latent'),
          finished: kind === 'finished' ? name : fallback(preferred?.finished, 'R-ESRGAN 4x+'),
        }
        if (!(await attempt(async () => { await api.settings.setUpscalers(next); return true }))) return false
        set((s) => ({ settings: s.settings ? { ...s.settings, upscalers: next } : null }))
        return true
      },

      async setFamilyNegative(family, presetId) {
        if (await attempt(async () => { await api.settings.setFamilyNegative(family, presetId); return true }) === undefined) return
        set((s) => {
          const next = { ...s.settings?.familyNegatives }
          if (presetId === null) delete next[family]
          else next[family] = presetId
          return { settings: s.settings ? { ...s.settings, familyNegatives: next } : null }
        })
      },

      async chooseImagesDir() {
        const selected = await api.settings.chooseImagesDir()
        if (selected !== null) set((s) => ({ settings: s.settings ? { ...s.settings, imagesDir: selected } : null }))
        return selected
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

      async clearUnfinished() {
        if (await attempt(() => api.jobs.clearUnfinished()) === undefined) return
        for (const job of Object.values(get().jobs)) {
          if (job.status === 'failed' || job.status === 'interrupted') forgetJob(job.id)
        }
      },

      loadMoreImages() {
        morePromise ??= (async () => {
          try {
            const { images, imagesExhausted } = get()
            if (imagesExhausted || images.length === 0) return
            const seq = imagesSeq
            const beforeId = Math.min(...images.map((i) => i.id))
            const page = await attempt(() => api.images.list({ limit: IMAGE_PAGE, beforeId }))
            if (!page || seq !== imagesSeq) return
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

      exportLog(ids) {
        const { limit: _shown, ...query } = logQuery(get().logFilters, Date.now())
        return api.oplog.export(ids ? { ...query, ids } : query)
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

      openLockDialog(mode) {
        pendingHide = null
        set({ lockDialog: mode })
      },

      closeLockDialog() {
        pendingHide = null
        set({ lockDialog: null })
      },

      async unlock(password) {
        await api.lock.open(password)
        set({ lockDialog: null })
      },

      async lockNow() {
        await attempt(() => api.lock.close())
      },

      async setLockPassword(oldPassword, next) {
        await api.lock.setPassword(oldPassword, next)
        lockSeq++
        set((s) => ({ lockDialog: null, lock: { ...s.lock, hasPassword: true } }))
        const ids = pendingHide
        pendingHide = null
        if (ids) await attempt(() => api.images.setHidden(ids, true))
      },

      async setHidden(ids, hidden) {
        const askPassword = (): void => {
          pendingHide = ids
          set({ lockDialog: 'set' })
        }
        if (hidden && !get().lock.hasPassword) return askPassword()
        try {
          await api.images.setHidden(ids, hidden)
        } catch (e) {
          if (errorKeyOf(e) === 'error.noPassword') askPassword()
          else fail(e)
        }
      },

      openHires(id) {
        set({ hiresFor: id })
      },

      openModelGallery(kind) {
        set({ modelGallery: kind })
      },

      closeModelGallery() {
        set({ modelGallery: null })
      },

      async setModelFavorite(kind, id, favorite) {
        await markModel(() => api.models.setFavorite(kind, id, favorite))
      },

      async setModelNote(kind, id, note) {
        await markModel(() => api.models.setNote(kind, id, note))
      },

      async setCheckpointFamily(file, family) {
        await markModel(() => api.models.setFamily(file, family))
        // The family decides the defaults and the checkpoint list grouping: an open selection follows it.
        const { params, catalog } = get()
        const current = catalog?.checkpoints.find((c) => c.title === params?.checkpoint)
        if (current && current.filename === file && current.family !== params?.family) await useCheckpoint(current.title)
      },

      async setLoraTriggers(path, triggers) {
        await markModel(() => api.models.setTriggers(path, triggers))
      },

      addLora(name) {
        const params = get().params
        if (!params || params.loras.length >= 16 || params.loras.some((l) => l.name === name)) return false
        get().setParams({ loras: [...params.loras, { name, weight: 1, enabled: true }] })
        return true
      },

      closeHires() {
        set({ hiresFor: null })
      },

      async queueHires(id, hires) {
        const { images, catalog } = get()
        const image = images.find((item) => item.id === id && !item.locked)
        if (!image || image.seed < 0) return 'failed'
        const details = await attempt(() => api.images.details(id))
        if (!details) return 'failed'
        if (details.jobType !== 'txt2img') return 'notTxt2img'
        const { width, height } = details.params
        if (!catalog?.upscalers.includes(hires.upscaler) || hires.scale <= 1
          || width * hires.scale > 4096 || height * hires.scale > 4096) return 'failed'
        // The saved job carries every setting but the seed (a batch holds several); the image knows its own.
        const params: GenerationParams = {
          ...details.params, count: 1, seed: image.seed, img2img: undefined, upscale: undefined, hires,
        }
        const created = await attempt(() => api.jobs.enqueue(params))
        if (!created) return 'failed'
        set((s) => ({ lastError: null, hiresFor: null, jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs } }))
        return 'queued'
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
