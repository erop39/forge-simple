import type {
  Catalog, ConnectionStatus, GenerationParams, ImageDetails, ImageRecord, Job, JobProgress, PartStatus, ServerInfo,
} from './types'

/**
 * Stable keys carried by the message of a rejected IPC call. They are never English text:
 * the renderer maps each key to a string from its own catalog.
 */
export const IPC_ERROR_KEYS = [
  'error.noServer', 'error.invalidParams', 'error.notFound', 'error.network', 'error.notForge', 'error.unexpected',
  'error.duplicateServer', 'error.jobRunning',
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
export interface AppSettings { serverUrl: string | null; imagesDir: string }
/** A server to save. An empty name is replaced by the address's host. */
export interface ServerInput { name: string; url: string }

export interface AppEvents {
  'job:update': Job
  'job:progress': JobProgress
  /** A job deleted before it ran (its server was removed). */
  'job:removed': { id: number }
  'image:added': ImageRecord
  'image:removed': { id: number }
  'connection': ConnectionStatus
  /** The saved servers after any change to them, a switch included. */
  'servers': ServerInfo[]
}

export interface Api {
  settings: { get(): Promise<AppSettings> }
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
  }
  images: {
    list(opts: { limit: number; beforeId?: number }): Promise<ImageRecord[]>
    details(id: number): Promise<ImageDetails>
    delete(id: number): Promise<void>
  }
  clipboard: { writeText(text: string): Promise<void> }
  connection: { get(): Promise<ConnectionStatus> }
  on<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void): () => void
}

declare global { interface Window { api: Api } }

/** Request channels, `<area>:<method>`. Event channels are `event:<name>`. */
export const CHANNELS = [
  'settings:get',
  'servers:list', 'servers:add', 'servers:update', 'servers:remove', 'servers:activate',
  'catalog:get', 'catalog:defaults', 'catalog:parts',
  'jobs:enqueue', 'jobs:cancel', 'jobs:retry', 'jobs:listActive',
  'images:list', 'images:details', 'images:delete', 'clipboard:writeText',
  'connection:get',
] as const
export type Channel = (typeof CHANNELS)[number]

export const EVENT_NAMES = [
  'job:update', 'job:progress', 'job:removed', 'image:added', 'image:removed', 'connection', 'servers',
] as const satisfies readonly (keyof AppEvents)[]
export const isEventName = (e: string): e is keyof AppEvents => (EVENT_NAMES as readonly string[]).includes(e)
export const eventChannel = (e: keyof AppEvents): string => `event:${e}`
