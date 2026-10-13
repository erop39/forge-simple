import type {
  Catalog, ConnectionStatus, GenerationParams, ImageRecord, Job, JobProgress, PartStatus,
} from './types'

/**
 * Stable keys carried by the message of a rejected IPC call. They are never English text:
 * the renderer maps each key to a string from its own catalog.
 */
export type IpcErrorKey =
  | 'error.noServer'
  | 'error.invalidParams'
  | 'error.notFound'
  | 'error.network'
  | 'error.notForge'
  | 'error.unexpected'

export interface ConnectionCheck { ok: boolean; latencyMs: number | null; errorKey: string | null }
export interface AppSettings { serverUrl: string | null; imagesDir: string }

export interface AppEvents {
  'job:update': Job
  'job:progress': JobProgress
  'image:added': ImageRecord
  'image:removed': { id: number }
  'connection': ConnectionStatus
}

export interface Api {
  settings: { get(): Promise<AppSettings>; setServerUrl(url: string): Promise<ConnectionCheck> }
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
  images: { list(opts: { limit: number; beforeId?: number }): Promise<ImageRecord[]>; delete(id: number): Promise<void> }
  connection: { get(): Promise<ConnectionStatus> }
  on<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void): () => void
}

declare global { interface Window { api: Api } }

/** Request channels, `<area>:<method>`. Event channels are `event:<name>`. */
export const CHANNELS = [
  'settings:get', 'settings:setServerUrl',
  'catalog:get', 'catalog:defaults', 'catalog:parts',
  'jobs:enqueue', 'jobs:cancel', 'jobs:retry', 'jobs:listActive',
  'images:list', 'images:delete',
  'connection:get',
] as const
export type Channel = (typeof CHANNELS)[number]
export const eventChannel = (e: keyof AppEvents): string => `event:${e}`
