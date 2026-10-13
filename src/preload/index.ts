import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, AppEvents } from '../shared/ipc'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  settings: {
    get: () => invoke('settings:get'),
    setServerUrl: (url) => invoke('settings:setServerUrl', url),
  },
  catalog: {
    get: (refresh) => invoke('catalog:get', refresh),
    defaults: (checkpointTitle) => invoke('catalog:defaults', checkpointTitle),
    parts: (params) => invoke('catalog:parts', params),
  },
  jobs: {
    enqueue: (params) => invoke('jobs:enqueue', params),
    cancel: (id) => invoke('jobs:cancel', id),
    retry: (id) => invoke('jobs:retry', id),
    listActive: () => invoke('jobs:listActive'),
  },
  images: {
    list: (opts) => invoke('images:list', opts),
    delete: (id) => invoke('images:delete', id),
  },
  connection: { get: () => invoke('connection:get') },
  on<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void): () => void {
    const channel = `event:${event}`
    // The renderer receives the payload only, never the IpcRendererEvent.
    const listener = (_e: IpcRendererEvent, payload: AppEvents[K]): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
}

contextBridge.exposeInMainWorld('api', api)
