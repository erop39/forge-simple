import type {
  Catalog, ConnectionStatus, ForgeCapabilities, ForgeHealth, GenerationParams, OplogEntry, OplogQuery, ImageDetails, ImageQuery,
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
  'error.tooManyAttempts', 'error.storageUnavailable',
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
  /** The lock opened or closed, or its password was set: what the gallery may show changed. */
  'lock': LockState
  /** These images were hidden or unhidden. */
  'images:changed': { ids: number[] }
}

export interface Api {
  settings: {
    get(): Promise<AppSettings>
    /** Saved preferences are used only when the active Forge offers the named upscaler. */
    setUpscalers(input: { hires: string; finished: string }): Promise<void>
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
  'settings:get', 'settings:setUpscalers', 'settings:chooseImagesDir',
  'servers:list', 'servers:add', 'servers:update', 'servers:remove', 'servers:activate', 'servers:addLocal',
  'negativePresets:list', 'negativePresets:add', 'negativePresets:update', 'negativePresets:remove',
  'catalog:get', 'catalog:defaults', 'catalog:parts',
  'jobs:enqueue', 'jobs:cancel', 'jobs:retry', 'jobs:listActive', 'jobs:get',
  'images:list', 'images:query', 'images:details', 'images:delete', 'images:setHidden', 'clipboard:writeText',
  'lock:state', 'lock:open', 'lock:close', 'lock:setPassword',
  'connection:get',
  'forge:capabilities', 'forge:health', 'forge:restart', 'forge:unload',
  'oplog:list', 'oplog:export', 'oplog:retention', 'oplog:setRetention',
] as const
export type Channel = (typeof CHANNELS)[number]

export const EVENT_NAMES = [
  'job:update', 'job:progress', 'job:removed', 'image:added', 'image:removed', 'connection', 'resources', 'servers',
  'forge:capabilities', 'forge:health', 'oplog:added', 'lock', 'images:changed',
] as const satisfies readonly (keyof AppEvents)[]
export const isEventName = (e: string): e is keyof AppEvents => (EVENT_NAMES as readonly string[]).includes(e)
export const eventChannel = (e: keyof AppEvents): string => `event:${e}`
