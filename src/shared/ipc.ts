import type {
  ArchiveCreated, ArchiveRestored, ArchiveState, BackupSection, Catalog, ImportSummary, WishlistItem, CivitaiBrowsePage, CivitaiBrowseQuery, CivitaiProgress, ConnectionStatus, Family, ForgeCapabilities, HiresPreset, HiresSettings, ModelKind, Preset, PresetParams, ForgeHealth, GenerationParams, OplogEntry, OplogQuery, ImageDetails, ImageQuery,
  ImageRecord, Job, JobProgress, LockState, NegativePreset, PartStatus,
  RestartOutcome, ResourceSnapshot, ServerInfo,
} from './types'

/**
 * Stable keys carried by the message of a rejected IPC call. They are never English text:
 * the renderer maps each key to a string from its own catalog.
 */
export const IPC_ERROR_KEYS = [
  'error.noServer', 'error.invalidParams', 'error.notFound', 'error.network', 'error.notForge', 'error.unexpected',
  'error.duplicateServer', 'error.jobRunning', 'error.presetNameTaken', 'error.wrongPassword', 'error.noPassword',
  'error.tooManyAttempts', 'error.storageUnavailable', 'error.civitaiBusy', 'error.backupNotBackup', 'error.backupVersion', 'error.backupMalformed', 'error.backupTooBig', 'error.lockedImages', 'error.archiveNothing', 'error.archiveNoSpace', 'error.archiveUnavailable', 'error.archiveUnreadable', 'error.archiveVersion', 'error.archiveBusy', 'error.wishlistUnknown',
] as const
export type IpcErrorKey = (typeof IPC_ERROR_KEYS)[number]

/**
 * Electron re-wraps a handler rejection as "Error invoking remote method 'x': IpcError: error.foo".
 * Returns the last `error.<name>` token when it is a known key, otherwise 'error.unexpected'.
 */
export function extractErrorKey(message: string): IpcErrorKey {
  const tokens = message.match(/error\.[A-Za-z]+/g)
  const last = tokens?.[tokens.length - 1]
  return (IPC_ERROR_KEYS as readonly string[]).includes(last ?? '') ? (last as IpcErrorKey) : 'error.unexpected'
}

export interface ConnectionCheck { ok: boolean; latencyMs: number | null; errorKey: string | null }
export interface AppSettings {
  serverUrl: string | null
  imagesDir: string
  /** Where Forge Neo listens on this PC by default; the add-server form starts with it. */
  localUrl: string
  upscalers?: { hires: string | null; finished: string | null }
  /** The user agreed to look the library up on Civitai (by file hash). */
  civitaiEnabled?: boolean
  /** The negative preset applied when a checkpoint of that family is loaded; absent = none. */
  familyNegatives?: Partial<Record<Family, number>>
  /** The VAE and text-encoder files the user chose for a family; they replace the ones Forge lists for it. */
  familyModules?: Partial<Record<Family, string[]>>
}
/** A server to save. An empty name is replaced by the address's host. */
export interface ServerInput { name: string; url: string }
/** A negative preset to save; the name is trimmed by main. */
export interface NegativePresetInput { name: string; text: string }

export interface AppEvents {
  'job:update': Job
  'job:progress': JobProgress
  /** A job deleted before it ran (its server was removed). */
  'job:removed': { id: number }
  'image:added': ImageRecord
  'image:removed': { id: number }
  'connection': ConnectionStatus
  'resources': ResourceSnapshot
  /** The saved servers after any change to them, a switch included. */
  'servers': ServerInfo[]
  /** What the active Forge allows changed (read on connect and after a server switch). */
  'forge:capabilities': ForgeCapabilities
  /** Generations keep failing with HTTP 500 (unhealthy), or that ended. */
  'forge:health': ForgeHealth
  /** A new operation-log entry. */
  'oplog:added': OplogEntry
  'civitai:progress': CivitaiProgress
  /** The lock opened or closed, or its password was set: what the gallery may show changed. */
  'lock': LockState
  /** These images were hidden or unhidden. */
  'images:changed': { ids: number[] }
  'wishlist:changed': { removed: number }
  /** The model catalog changed after it was handed out (the LoRA list arrived late): ask for it again. */
  'catalog:updated': Record<string, never>
}

export interface Api {
  settings: {
    get(): Promise<AppSettings>
    /** Saved preferences are used only when the active Forge offers the named upscaler. */
    setUpscalers(input: { hires: string; finished: string }): Promise<void>
    /** The preset a family starts with (null = none); error.notFound for an unknown preset. */
    setFamilyNegative(family: Family, presetId: number | null): Promise<void>
    /** The modules a family starts with (null = Forge's own choice); every file must be on the server (error.notFound). */
    setFamilyModules(family: Family, modules: string[] | null): Promise<void>
    /** Opens the native folder picker; null means cancelled. Only future images use the selected folder. */
    chooseImagesDir(): Promise<string | null>
  }
  servers: {
    list(): Promise<ServerInfo[]>
    /** Tests the connection and saves only when it works; with no active server the new one becomes active. */
    add(input: ServerInput): Promise<ConnectionCheck>
    /** Tests the connection again only when the address changes. */
    update(id: number, input: ServerInput): Promise<ConnectionCheck>
    /** Deletes the server's queued jobs; images stay. Refused with error.jobRunning while one of its jobs runs. */
    remove(id: number): Promise<void>
    /** Refused with error.jobRunning while a job runs. */
    activate(id: number): Promise<void>
    /**
     * First run: when no server is saved and Forge answers at `localUrl`, saves it under `name` and makes it
     * active. Resolves whether it did; never rejects for an unreachable address.
     */
    addLocal(name: string): Promise<boolean>
  }
  /** Named negative prompts. A name already taken (ignoring case) is refused with error.presetNameTaken. */
  negativePresets: {
    /** Ordered by name, ignoring case. */
    list(): Promise<NegativePreset[]>
    add(input: NegativePresetInput): Promise<NegativePreset>
    update(id: number, patch: Partial<NegativePresetInput>): Promise<NegativePreset>
    remove(id: number): Promise<void>
  }
  /**
   * Marks on checkpoint and LoRA files. `id` is the checkpoint's file name or the LoRA's path from the catalog;
   * an id the catalog does not list is error.notFound. Reload the catalog (`catalog.get()`, no refetch) to see them.
   */
  models: {
    setFavorite(kind: ModelKind, id: string, favorite: boolean): Promise<void>
    setNote(kind: ModelKind, id: string, note: string): Promise<void>
    /** null returns to the family detected from the name. */
    setFamily(checkpointFile: string, family: Family | null): Promise<void>
    /** null returns to the words found in the file's metadata. */
    setTriggers(kind: ModelKind, id: string, triggers: string[] | null): Promise<void>
    /** The newest visible images made with this checkpoint or LoRA (up to 24). */
    generations(kind: ModelKind, id: string): Promise<ImageRecord[]>
    /** Uses a saved image (its thumbnail) as the model's own preview; error.notFound for a hidden or unknown image. */
    setPreviewFromImage(kind: ModelKind, id: string, imageId: number): Promise<void>
    /** Drops the model's own preview. */
    clearPreview(kind: ModelKind, id: string): Promise<void>
  }
  /**
   * Optional lookup of the library on civitai.com: only file SHA-256 hashes are sent, one request a second.
   * `update` needs `setEnabled(true)` first (error.invalidParams otherwise) and returns when the run has started.
   */
  civitai: {
    setEnabled(enabled: boolean): Promise<void>
    update(opts?: { force?: boolean }): Promise<void>
    cancel(): Promise<void>
    state(): Promise<CivitaiProgress>
    /** Opens the file's Civitai page in the system browser; error.notFound when it was not found there. */
    open(kind: ModelKind, id: string, which?: 'current' | 'newer'): Promise<void>
    /** Looks one file up now (needs the same consent): found, unknown to Civitai, no hash to ask with, or Civitai busy. */
    updateOne(kind: ModelKind, id: string): Promise<'found' | 'missing' | 'noHash' | 'busy'>
    /** One page of Civitai's newest/popular models for the filters (needs the same consent); error.civitaiBusy when it is busy, error.network otherwise. */
    browse(query: CivitaiBrowseQuery): Promise<CivitaiBrowsePage>
    /** Opens a model version found by `browse` in the system browser. */
    openModel(modelId: number, versionId: number, site?: 'com' | 'red'): Promise<void>
  }
  /** Tags on saved images. Hidden images are left out while the lock is closed; changes push 'images:changed'. */
  tags: {
    /** Tags that start with `prefix`, the most used first (at most 8). */
    suggest(prefix: string): Promise<string[]>
    add(imageIds: number[], names: string[]): Promise<void>
    remove(imageIds: number[], names: string[]): Promise<void>
  }
  /**
   * Named sets of generation settings (everything but the prompt, negative, seed and count). A name already taken
   * (ignoring case) is error.presetNameTaken. `applied` only writes the log entry.
   */
  presets: {
    list(): Promise<Preset[]>
    save(name: string, params: PresetParams): Promise<Preset>
    rename(id: number, name: string): Promise<Preset>
    remove(id: number): Promise<void>
    applied(id: number): Promise<void>
  }
  /** Named hires second passes; a name already taken (ignoring case) is error.presetNameTaken. */
  hiresPresets: {
    list(): Promise<HiresPreset[]>
    add(input: { name: string; settings: HiresSettings }): Promise<HiresPreset>
    rename(id: number, name: string): Promise<HiresPreset>
    remove(id: number): Promise<void>
  }
  catalog: {
    get(refresh?: boolean): Promise<Catalog>
    defaults(checkpointTitle: string): Promise<GenerationParams>
    parts(params: GenerationParams): Promise<PartStatus[]>
  }
  jobs: {
    enqueue(params: GenerationParams): Promise<Job[]>
    cancel(id: number): Promise<void>
    retry(id: number): Promise<Job>
    listActive(): Promise<Job[]>
    /** Removes every failed and interrupted job (all servers) and pushes job:removed for each; resolves with the count. */
    clearUnfinished(): Promise<number>
    /** Any stored job (e.g. to show why a logged job failed); error.notFound when it is gone. */
    get(id: number): Promise<Job>
  }
  /**
   * While the lock is closed a hidden image comes back as a `locked` record (no addresses, infotext, seed or
   * tags), text and tag queries leave hidden images out, and `details` refuses one with error.notFound.
   */
  images: {
    /** The newest images: a `query` without text or tags. */
    list(opts: { limit: number; beforeId?: number }): Promise<ImageRecord[]>
    /** One page, newest first; `limit` is clamped to 1..200. */
    query(q: ImageQuery): Promise<ImageRecord[]>
    details(id: number): Promise<ImageDetails>
    delete(id: number): Promise<void>
    /** Removes several images; the ones that were gone or hidden behind the closed lock come back in `failed`. */
    deleteMany(ids: number[]): Promise<{ deleted: number[]; failed: number[] }>
    /** Shows the saved file in the system file manager; a hidden image while locked is error.notFound. */
    reveal(id: number): Promise<void>
    /**
     * Hiding is refused with error.noPassword until a password is set; unhiding with error.notFound while the
     * lock is closed. Pushes 'images:changed'.
     */
    setHidden(ids: number[], hidden: boolean): Promise<void>
  }
  /** The session lock over hidden images; closed at every start. Each change pushes 'lock'. */
  lock: {
    state(): Promise<LockState>
    /**
     * A wrong password is refused with error.wrongPassword; the 5th in a row starts a 30 s pause during which
     * every attempt (here and in setPassword) is refused with error.tooManyAttempts.
     */
    open(password: string): Promise<void>
    close(): Promise<void>
    /**
     * At least 4 characters (else error.invalidParams). Once a password is set, changing it needs the old one
     * (error.wrongPassword otherwise).
     */
    setPassword(oldPassword: string | null, next: string): Promise<void>
  }
  clipboard: { writeText(text: string): Promise<void> }
  connection: { get(): Promise<ConnectionStatus> }
  /**
   * Backup of the user's settings in one versioned JSON file: servers, presets, hires and negative presets, family choices,
   * own trigger words and a few settings (never images, jobs, tags, the log, the lock or Civitai consent). Import is additive.
   * `preview` asks for a file and returns what importing it would add (null when the dialog was cancelled; error.backup* when
   * the file is refused); `apply` then imports exactly that file; `discard` forgets it.
   */
  backup: {
    /** Saves only the chosen parts (at least one: error.invalidParams); false when the dialog was cancelled. */
    export(sections: BackupSection[]): Promise<boolean>
    preview(): Promise<ImportSummary | null>
    /** Imports the chosen parts of the previewed file (at least one). */
    apply(sections: BackupSection[]): Promise<ImportSummary>
    discard(): Promise<void>
  }
  /**
   * Models marked to download later. `add` takes a model version from a listing the browser just showed (error.wishlistUnknown
   * otherwise); the list also loses a model by itself when its file appears in the library (pushes 'wishlist:changed').
   */
  wishlist: {
    list(): Promise<WishlistItem[]>
    add(modelId: number, versionId: number): Promise<void>
    /** Takes one off the list (Mark as downloaded, or changed your mind). */
    remove(id: number): Promise<void>
  }
  /**
   * Archives: images moved out of the gallery into a folder (files, thumbnails, records) after a verified copy. Hidden images
   * are never archived. `create` needs at least one archivable image (error.archiveNothing) and room on the disk
   * (error.archiveNoSpace); `restore` puts an archive's images back into the gallery (error.archiveUnavailable when its
   * folder is gone, error.archiveUnreadable / error.archiveVersion for a damaged or newer archive).
   */
  archive: {
    state(): Promise<ArchiveState>
    /** Opens a folder picker for the archive folder; null when cancelled. */
    chooseDir(): Promise<string | null>
    create(ids: number[], label: string): Promise<ArchiveCreated>
    restore(id: number): Promise<ArchiveRestored>
  }
  /**
   * Deleting every generation: the images with their files, and every finished job. Servers, presets and settings stay.
   * `count` says how many there are; `deleteAll` refuses while a job waits or runs (error.jobRunning) and while hidden
   * images exist behind a closed lock (error.lockedImages).
   */
  generations: {
    count(): Promise<{ total: number; hidden: number }>
    deleteAll(): Promise<{ deleted: number; failed: number }>
  }
  /** The operation log. */
  oplog: {
    list(query: OplogQuery): Promise<OplogEntry[]>
    /** Writes the matching entries as JSON Lines to a file the user picks; false when the dialog was cancelled. */
    export(query: OplogQuery): Promise<boolean>
    /** Days entries are kept; older ones are deleted at start. */
    retention(): Promise<number>
    /** Whole days, 1..3650; anything else is refused with error.invalidParams. */
    setRetention(days: number): Promise<void>
  }
  /** Control of the active Forge. Both actions reject with error.noServer without one. */
  forge: {
    capabilities(): Promise<ForgeCapabilities>
    health(): Promise<ForgeHealth>
    /**
     * Asks Forge to restart. On `restarting` the running job is interrupted and the queue pauses until
     * Forge answers again. Rejects with error.network or error.notForge when the request fails otherwise.
     */
    restart(): Promise<RestartOutcome>
    /** Frees the loaded checkpoint. Refused with error.jobRunning while a job runs. */
    unload(): Promise<void>
  }
  on<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void): () => void
}

declare global { interface Window { api: Api } }

/** Request channels, `<area>:<method>`. Event channels are `event:<name>`. */
export const CHANNELS = [
  'settings:get', 'settings:setUpscalers', 'settings:setFamilyNegative', 'settings:setFamilyModules', 'settings:chooseImagesDir',
  'servers:list', 'servers:add', 'servers:update', 'servers:remove', 'servers:activate', 'servers:addLocal',
  'negativePresets:list', 'negativePresets:add', 'negativePresets:update', 'negativePresets:remove',
  'civitai:setEnabled', 'civitai:update', 'civitai:cancel', 'civitai:state', 'civitai:open', 'civitai:updateOne', 'wishlist:list', 'wishlist:add', 'wishlist:remove', 'archive:state', 'archive:chooseDir', 'archive:create', 'archive:restore', 'generations:count', 'generations:deleteAll', 'backup:export', 'backup:preview', 'backup:apply', 'backup:discard', 'civitai:browse', 'civitai:openModel', 'tags:suggest', 'tags:add', 'tags:remove', 'presets:list', 'presets:save', 'presets:rename', 'presets:remove', 'presets:applied', 'hiresPresets:list', 'hiresPresets:add', 'hiresPresets:rename', 'hiresPresets:remove', 'models:setFavorite', 'models:setNote', 'models:setFamily', 'models:setTriggers', 'models:generations', 'models:setPreviewFromImage', 'models:clearPreview', 'catalog:get', 'catalog:defaults', 'catalog:parts',
  'jobs:enqueue', 'jobs:cancel', 'jobs:retry', 'jobs:listActive', 'jobs:clearUnfinished', 'jobs:get',
  'images:list', 'images:query', 'images:details', 'images:delete', 'images:deleteMany', 'images:reveal', 'images:setHidden', 'clipboard:writeText',
  'lock:state', 'lock:open', 'lock:close', 'lock:setPassword',
  'connection:get',
  'forge:capabilities', 'forge:health', 'forge:restart', 'forge:unload',
  'oplog:list', 'oplog:export', 'oplog:retention', 'oplog:setRetention',
] as const
export type Channel = (typeof CHANNELS)[number]

export const EVENT_NAMES = [
  'job:update', 'job:progress', 'job:removed', 'image:added', 'image:removed', 'connection', 'resources', 'servers',
  'forge:capabilities', 'forge:health', 'oplog:added', 'lock', 'images:changed', 'wishlist:changed', 'catalog:updated', 'civitai:progress',
] as const satisfies readonly (keyof AppEvents)[]
export const isEventName = (e: string): e is keyof AppEvents => (EVENT_NAMES as readonly string[]).includes(e)
export const eventChannel = (e: keyof AppEvents): string => `event:${e}`
