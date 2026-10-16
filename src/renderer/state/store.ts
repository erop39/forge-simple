import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Api, AppSettings, ConnectionCheck, IpcErrorKey, ServerInput } from '@shared/ipc'
import type {
  ArchiveCreated, ArchiveRestored, ArchiveState, BackupSection, WishlistItem, Catalog, ImportSummary, CivitaiBrowsePage, CivitaiBrowseQuery, ConnectionStatus, Family, ForgeCapabilities, GenerationParams, ImageRecord, Job, JobProgress, HiresPreset, Preset, LockState, ModelKind, NegativePreset, CivitaiProgress, UpscaleSettings, HiresSettings,
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

export interface ImageSearch { text: string; tags: string[] }
export const isSearching = (q: ImageSearch): boolean => q.text.trim() !== '' || q.tags.length > 0

export interface AppState {
  connection: ConnectionStatus
  resources: ResourceSnapshot
  settings: AppSettings | null
  /** Saved servers, ordered by name; at most one is active. */
  servers: ServerInfo[]
  /** Saved negative prompts, ordered by name. */
  negativePresets: NegativePreset[]
  hiresPresets: HiresPreset[]
  /** Saved sets of generation settings (everything but prompt, negative, seed and count). */
  presets: Preset[]
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
  /** The gallery's search: empty text and no tags is the plain gallery. */
  query: ImageSearch
  panelOpen: boolean
  /** What the active Forge allows; restart needs --api-server-stop. */
  capabilities: ForgeCapabilities
  /** Generations keep failing with HTTP 500; false again after a success, a restart, a switch or a dismissal. */
  forgeUnhealthy: boolean
  /** The restart confirmation opened from a job tile or the unhealthy notice. */
  restartAsked: boolean
  /** The saved image whose Send to hires dialog is open. */
  hiresFor: number | null
  /** Gallery view: false shows everything, true only the latest generation request (its jobs and their images). */
  focusMode: boolean
  /** Ids of the jobs the latest generation request created (this session only). */
  batchJobIds: number[]
  setFocusMode(on: boolean): void
  /** Which model gallery is open (checkpoints or LoRA), if any. */
  modelGallery: ModelKind | null
  /** The optional Civitai lookup of the library. */
  civitai: CivitaiProgress
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
  /** Puts a saved job's settings (model, prompt, negative, size, steps, LoRA, seed, hires…) into the prompt bar; false when its model is not on this server. */
  reuseSettings(saved: GenerationParams): boolean
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
  /** The VAE/text-encoder files a family starts with (null = Forge's own); needs the files on the server. */
  setFamilyModules(family: Family, modules: string[] | null): Promise<void>
  chooseImagesDir(): Promise<string | null>
  /** The archive folder and the archives made so far. */
  archiveState(): Promise<ArchiveState>
  /** Picks the archive folder (null when cancelled); rejects with error.storageUnavailable for a folder that cannot be written. */
  chooseArchiveDir(): Promise<string | null>
  /** Moves the images into a new archive after a verified copy; hidden ones stay; rejects with error.archive*. */
  createArchive(ids: number[], label: string): Promise<ArchiveCreated>
  /** Puts an archive's images back into the gallery; rejects with error.archive*. */
  restoreArchive(id: number): Promise<ArchiveRestored>
  /** How many images there are (and how many are hidden), for the delete-everything confirmation. */
  countGenerations(): Promise<{ total: number; hidden: number }>
  /** Deletes every image and finished job; rejects with error.jobRunning or error.lockedImages. */
  deleteAllGenerations(): Promise<{ deleted: number; failed: number }>
  /** Saves the settings to a file the user picks; false when cancelled. */
  exportSettings(sections: BackupSection[]): Promise<boolean>
  /** Asks for a settings file and says what importing it would add (null when cancelled); rejects with error.backup*. */
  previewSettingsImport(): Promise<ImportSummary | null>
  /** Imports the file shown by the preview, then reloads everything it may have changed. */
  applySettingsImport(sections: BackupSection[]): Promise<ImportSummary>
  discardSettingsImport(): Promise<void>
  cancelJob(id: number): Promise<void>
  retryJob(id: number): Promise<void>
  deleteImage(id: number): Promise<void>
  /** Several at once; resolves with the ids that were removed and those that could not be. */
  deleteImages(ids: number[]): Promise<{ deleted: number[]; failed: number[] }>
  /** Image ids selected in the gallery (in the order they were picked). */
  selection: number[]
  /** `add` toggles one; `range` selects from the last picked one to `id` in `order`; `single` selects only it. */
  toggleSelect(id: number, mode: 'single' | 'add' | 'range', order: number[]): void
  clearSelection(): void
  /** Removes a failed or interrupted job from the list; there is nothing to tell the main process. */
  dismissJob(id: number): void
  /** Removes every failed and interrupted job for good (not only from this session). */
  clearUnfinished(): Promise<void>
  /** Appends the next page of older images; concurrent calls share one request. */
  loadMoreImages(): Promise<void>
  /** Narrows the gallery to images whose prompt, model, LoRA or tags match; tags must all match. Applied 250 ms after the last change. */
  setQuery(patch: Partial<ImageSearch>): void
  clearQuery(): void
  suggestTags(prefix: string): Promise<string[]>
  addImageTags(ids: number[], names: string[]): Promise<void>
  removeImageTags(ids: number[], names: string[]): Promise<void>
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
  civitaiBrowser: ModelKind | null
  /** Models marked to download later (a model leaves it by itself when its file shows up in the library). */
  wishlist: WishlistItem[]
  /** Marks a model version of the listing the browser just showed; rejects with error.wishlistUnknown. */
  addToWishlist(modelId: number, versionId: number): Promise<void>
  removeFromWishlist(id: number): Promise<void>
  openCivitaiBrowser(kind: ModelKind): void
  closeCivitaiBrowser(): void
  /** Leaves the Civitai browser for the model library it was opened from. */
  backFromCivitaiBrowser(): void
  /** Rejects with the IPC error key (error.civitaiBusy, error.network). */
  browseCivitai(query: CivitaiBrowseQuery): Promise<CivitaiBrowsePage>
  openCivitaiModel(modelId: number, versionId: number, site?: 'com' | 'red'): Promise<void>
  /** Records the user's consent (or its withdrawal); a lookup needs it. */
  setCivitaiEnabled(enabled: boolean): Promise<void>
  updateFromCivitai(force?: boolean): Promise<void>
  cancelCivitai(): Promise<void>
  openOnCivitai(kind: ModelKind, id: string, which?: 'current' | 'newer'): Promise<void>
  /** Rejects with error.presetNameTaken when the name exists. */
  saveHiresPreset(name: string, settings: HiresSettings): Promise<void>
  /** Save the current settings under a name; rejects with error.presetNameTaken. */
  savePreset(name: string): Promise<void>
  renamePreset(id: number, name: string): Promise<void>
  deletePreset(id: number): Promise<void>
  /** Replaces the settings with the preset's and keeps prompt, negative, seed and image count. */
  applyPreset(preset: Preset): void
  deleteHiresPreset(id: number): Promise<void>
  closeModelGallery(): void
  setModelFavorite(kind: ModelKind, id: string, favorite: boolean): Promise<void>
  setModelNote(kind: ModelKind, id: string, note: string): Promise<void>
  setCheckpointFamily(file: string, family: Family | null): Promise<void>
  setModelTriggers(kind: ModelKind, id: string, triggers: string[] | null): Promise<void>
  /** One file looked up on Civitai now; the result tells what happened (the catalog is re-read when found or unknown). */
  updateModelFromCivitai(kind: ModelKind, id: string): Promise<'found' | 'missing' | 'noHash' | 'busy' | 'failed'>
  /** Appends a word to the prompt unless it is already there. */
  insertPromptWord(word: string): void
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
  /** The newest visible images made with this checkpoint or LoRA; empty when none or on failure. */
  modelGenerations(kind: ModelKind, id: string): Promise<ImageRecord[]>
  /** Uses a saved image as the model's own preview; false on failure. */
  setModelPreviewFromImage(kind: ModelKind, id: string, imageId: number): Promise<boolean>
  clearModelPreview(kind: ModelKind, id: string): Promise<void>
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

const FOCUS_KEY = 'fnc.focusMode'
const readFocusMode = (): boolean => {
  try { return localStorage.getItem(FOCUS_KEY) === '1' } catch { return false }
}

export function createAppStore(api: Api): StoreApi<AppState> {
  let initPromise: Promise<void> | null = null
  let partsSeq = 0
  // Bumped by every checkpoint selection and catalog load; a response from an older one is dropped.
  let selectSeq = 0
  let catalogSeq = 0
  let marksSeq = 0
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
  let queryTimer: ReturnType<typeof setTimeout> | null = null
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
      const mine = ++marksSeq // two quick marks: only the later answer may set the catalog
      if (await attempt(async () => { await call(); return true }) === undefined) return
      const fresh = await attempt(() => api.catalog.get())
      if (fresh && seq === catalogSeq && mine === marksSeq) set({ catalog: fresh })
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
    async function loadWishlist(): Promise<void> {
      try {
        set({ wishlist: await api.wishlist.list() })
      } catch { /* the list stays as it was; a failed read is no reason for a banner */ }
    }

    async function loadPresets(): Promise<void> {
      const seq = ++presetsSeq
      const list = await attempt(() => api.negativePresets.list())
      if (list && seq === presetsSeq) set({ negativePresets: list })
    }

    /** Runs a preset change (rejecting on refusal) and then reloads the list. */
    async function changePresets(call: () => Promise<unknown>): Promise<void> {
      await call()
      await loadPresets()
      void attempt(() => api.hiresPresets.list()).then((list) => { if (list) set({ hiresPresets: list }) })
      void attempt(() => api.presets.list()).then((list) => { if (list) set({ presets: list }) })
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
        // While a search is on the new image is not known to match; it shows when the search is cleared.
        set((s) => (isSearching(s.query) || s.images.some((i) => i.id === image.id) ? s : { images: [image, ...s.images] })),
      )
      api.on('image:removed', ({ id }) => set((s) => ({ images: s.images.filter((i) => i.id !== id), selection: s.selection.filter((x) => x !== id) })))
      api.on('connection', (connection) => set({ connection }))
      api.on('resources', (resources) => set({ resources }))
      api.on('job:removed', ({ id }) => forgetJob(id))
      api.on('civitai:progress', (civitai) => {
        const was = get().civitai.running
        set({ civitai })
        // A finished run changed trigger words, base families and previews: read the catalog again (no refetch).
        if (was && !civitai.running) void markModel(async () => undefined)
      })
      api.on('servers', (servers) => set({ servers }))
      api.on('wishlist:changed', () => { void loadWishlist() })
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

    /** One page of the gallery, newest first: the plain list, or the search results while a search is on. */
    function pageOf(beforeId?: number): Promise<ImageRecord[]> {
      const q = get().query
      const paging = { limit: IMAGE_PAGE, ...(beforeId !== undefined ? { beforeId } : {}) }
      if (!isSearching(q)) return api.images.list(paging)
      return api.images.query({ ...paging, ...(q.text.trim() !== '' ? { text: q.text.trim() } : {}), ...(q.tags.length > 0 ? { tags: q.tags } : {}) })
    }

    /** Replaces the gallery with the first page of the current search (or of the plain gallery). */
    async function applyQuery(): Promise<void> {
      const seq = ++imagesSeq
      const page = await attempt(() => pageOf())
      if (!page || seq !== imagesSeq) return
      set({ images: page, imagesExhausted: page.length < IMAGE_PAGE })
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
        const page = await attempt(() => pageOf(last?.id))
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
      void loadWishlist()
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
      hiresPresets: [],
      presets: [],
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
      query: { text: '', tags: [] },
      panelOpen: false,
      capabilities: { canRestart: false },
      forgeUnhealthy: false,
      restartAsked: false,
      hiresFor: null,
      focusMode: readFocusMode(),
      batchJobIds: [],
      modelGallery: null,
      civitaiBrowser: null,
      wishlist: [],
      civitai: { running: false, done: 0, total: 0, found: 0, paused: false },
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

      reuseSettings(saved) {
        const { catalog } = get()
        if (!catalog?.checkpoints.some((c) => c.title === saved.checkpoint)) return false
        const params: GenerationParams = {
          ...saved, count: 1, img2img: undefined, upscale: undefined,
          hires: saved.hires ? { ...saved.hires } : get().params?.hires,
        }
        selectSeq++
        set({ params, draftPrompt: params.prompt, draftNegative: keptNegative(params, get().draftNegative) })
        void refreshParts(params)
        return true
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
          batchJobIds: created.map((j) => j.id),
          jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs },
        }))
      },

      setFocusMode(on) {
        try { localStorage.setItem(FOCUS_KEY, on ? '1' : '0') } catch { /* the choice just does not outlive the session */ }
        set({ focusMode: on })
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
        set((s) => ({ lastError: null, batchJobIds: created.map((j) => j.id), jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs } }))
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

      async setFamilyModules(family, modules) {
        if (await attempt(async () => { await api.settings.setFamilyModules(family, modules); return true }) === undefined) return
        set((s) => {
          const next = { ...s.settings?.familyModules }
          if (modules === null) delete next[family]
          else next[family] = modules
          return { settings: s.settings ? { ...s.settings, familyModules: next } : null }
        })
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

      archiveState() {
        return api.archive.state()
      },

      chooseArchiveDir() {
        return api.archive.chooseDir()
      },

      createArchive(ids, label) {
        return api.archive.create(ids, label)
      },

      restoreArchive(id) {
        return api.archive.restore(id)
      },

      countGenerations() {
        return api.generations.count()
      },

      deleteAllGenerations() {
        return api.generations.deleteAll()
      },

      exportSettings(sections) {
        return api.backup.export(sections)
      },

      previewSettingsImport() {
        return api.backup.preview()
      },

      async applySettingsImport(sections) {
        const summary = await api.backup.apply(sections)
        const [settings, servers] = await Promise.all([api.settings.get(), api.servers.list()])
        set({ settings, servers })
        await changePresets(async () => undefined)
        if (summary.models > 0 || summary.settings > 0) void loadCatalog()
        return summary
      },

      async discardSettingsImport() {
        await attempt(() => api.backup.discard())
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

      async deleteImages(ids) {
        const result = await attempt(() => api.images.deleteMany(ids))
        return result ?? { deleted: [], failed: ids }
      },

      selection: [],

      toggleSelect(id, mode, order) {
        const current = get().selection
        if (mode === 'single') { set({ selection: [id] }); return }
        if (mode === 'add') {
          set({ selection: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] })
          return
        }
        const anchor = current[current.length - 1]
        const from = anchor === undefined ? -1 : order.indexOf(anchor)
        const to = order.indexOf(id)
        if (from < 0 || to < 0) { set({ selection: current.includes(id) ? current : [...current, id] }); return }
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const range = order.slice(lo, hi + 1)
        set({ selection: [...current.filter((x) => !range.includes(x)), ...(from < to ? range : [...range].reverse())] })
      },

      clearSelection() {
        if (get().selection.length > 0) set({ selection: [] })
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

      setQuery(patch) {
        const next = { ...get().query, ...patch }
        set({ query: next })
        if (queryTimer) clearTimeout(queryTimer)
        queryTimer = setTimeout(() => { queryTimer = null; void applyQuery() }, 250)
      },

      clearQuery() {
        if (queryTimer) clearTimeout(queryTimer)
        queryTimer = null
        if (!isSearching(get().query)) return
        set({ query: { text: '', tags: [] } })
        void applyQuery()
      },

      async suggestTags(prefix) {
        return (await attempt(() => api.tags.suggest(prefix))) ?? []
      },

      async addImageTags(ids, names) {
        await attempt(() => api.tags.add(ids, names))
      },

      async removeImageTags(ids, names) {
        await attempt(() => api.tags.remove(ids, names))
      },

      loadMoreImages() {
        morePromise ??= (async () => {
          try {
            const { images, imagesExhausted } = get()
            if (imagesExhausted || images.length === 0) return
            const seq = imagesSeq
            const beforeId = Math.min(...images.map((i) => i.id))
            const page = await attempt(() => pageOf(beforeId))
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

      async modelGenerations(kind, id) {
        return (await attempt(() => api.models.generations(kind, id))) ?? []
      },

      async setModelPreviewFromImage(kind, id, imageId) {
        const ok = await attempt(async () => { await api.models.setPreviewFromImage(kind, id, imageId); return true })
        if (!ok) return false
        await markModel(async () => undefined)
        return true
      },

      async clearModelPreview(kind, id) {
        await markModel(() => api.models.clearPreview(kind, id))
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

      async setCivitaiEnabled(enabled) {
        if (await attempt(async () => { await api.civitai.setEnabled(enabled); return true }) === undefined) return
        set((s) => ({ settings: s.settings ? { ...s.settings, civitaiEnabled: enabled } : null }))
      },

      async updateFromCivitai(force = false) {
        await attempt(() => api.civitai.update({ force }))
      },

      async cancelCivitai() {
        await attempt(() => api.civitai.cancel())
      },

      async openOnCivitai(kind, id, which) {
        await attempt(() => api.civitai.open(kind, id, which))
      },

      async savePreset(name) {
        const params = get().params
        if (!params) return
        const { prompt: _p, negativePrompt: _n, seed: _s, count: _c, img2img: _i, upscale: _u, ...kept } = params
        await api.presets.save(name, kept)
        const list = await attempt(() => api.presets.list())
        if (list) set({ presets: list })
      },

      async renamePreset(id, name) {
        await api.presets.rename(id, name)
        const list = await attempt(() => api.presets.list())
        if (list) set({ presets: list })
      },

      async deletePreset(id) {
        await attempt(() => api.presets.remove(id))
        const list = await attempt(() => api.presets.list())
        if (list) set({ presets: list })
      },

      applyPreset(preset) {
        const current = get().params
        const params: GenerationParams = {
          ...preset.params,
          prompt: current?.prompt ?? get().draftPrompt,
          negativePrompt: current?.negativePrompt ?? get().draftNegative ?? '',
          seed: current?.seed ?? -1,
          count: current?.count ?? 1,
        }
        selectSeq++
        set({ params, draftPrompt: params.prompt, draftNegative: keptNegative(params, get().draftNegative) })
        void refreshParts(params)
        void attempt(() => api.presets.applied(preset.id))
      },

      async saveHiresPreset(name, settings) {
        await api.hiresPresets.add({ name, settings })
        const list = await attempt(() => api.hiresPresets.list())
        if (list) set({ hiresPresets: list })
      },

      async deleteHiresPreset(id) {
        await attempt(() => api.hiresPresets.remove(id))
        const list = await attempt(() => api.hiresPresets.list())
        if (list) set({ hiresPresets: list })
      },

      openCivitaiBrowser(kind) {
        set({ civitaiBrowser: kind, modelGallery: null })
      },

      closeCivitaiBrowser() {
        set({ civitaiBrowser: null })
      },

      async addToWishlist(modelId, versionId) {
        await api.wishlist.add(modelId, versionId)
        await loadWishlist()
      },

      async removeFromWishlist(id) {
        await attempt(() => api.wishlist.remove(id))
        await loadWishlist()
      },

      backFromCivitaiBrowser() {
        set((s) => ({ modelGallery: s.civitaiBrowser, civitaiBrowser: null }))
      },

      browseCivitai(query) {
        return api.civitai.browse(query)
      },

      async openCivitaiModel(modelId, versionId, site) {
        await attempt(() => api.civitai.openModel(modelId, versionId, site))
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

      async setModelTriggers(kind, id, triggers) {
        await markModel(() => api.models.setTriggers(kind, id, triggers))
      },

      async updateModelFromCivitai(kind, id) {
        const result = await attempt(() => api.civitai.updateOne(kind, id))
        if (result === undefined) return 'failed'
        if (result === 'found' || result === 'missing') await markModel(async () => undefined)
        return result
      },

      insertPromptWord(word) {
        const params = get().params
        if (!params) return
        const prompt = params.prompt.trimEnd()
        const present = prompt.split(',').some((part) => part.trim().toLowerCase() === word.toLowerCase())
        if (!present) get().setParams({ prompt: prompt === '' ? word : `${prompt}, ${word}` })
      },

      addLora(name) {
        const params = get().params
        if (!params || params.loras.length >= 16 || params.loras.some((l) => l.name === name)) return false
        get().setParams({ loras: [...params.loras, { name, weight: 1, enabled: true }] })
        // The trigger words go into the prompt with the LoRA: the user's and Civitai's lists whole, but from a file's
        // training tags only the most frequent one (the rest are ordinary tags such as "1girl").
        const info = get().catalog?.loras.find((l) => l.name === name)
        const words = info?.triggers ?? []
        for (const word of info?.triggersFrom === 'file' ? words.slice(0, 1) : words) get().insertPromptWord(word)
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
        set((s) => ({ lastError: null, hiresFor: null, batchJobIds: created.map((j) => j.id), jobs: { ...Object.fromEntries(fresh(created)), ...s.jobs } }))
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
