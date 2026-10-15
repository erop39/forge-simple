import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { eventChannel, extractErrorKey, isEventName, type Api, type AppEvents, type Channel } from '../shared/ipc'

// Electron wraps a rejection as "Error invoking remote method ...: IpcError: error.x";
// the renderer gets a plain Error whose message is the stable key.
const invoke = async <T>(channel: Channel, ...args: unknown[]): Promise<T> => {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw new Error(extractErrorKey(err instanceof Error ? err.message : String(err)))
  }
}

const api: Api = {
  settings: {
    get: () => invoke('settings:get'),
    setUpscalers: (input) => invoke('settings:setUpscalers', input),
    chooseImagesDir: () => invoke('settings:chooseImagesDir'),
  },
  servers: {
    list: () => invoke('servers:list'),
    add: (input) => invoke('servers:add', input),
    update: (id, input) => invoke('servers:update', id, input),
    remove: (id) => invoke('servers:remove', id),
    activate: (id) => invoke('servers:activate', id),
    addLocal: (name) => invoke('servers:addLocal', name),
  },
  negativePresets: {
    list: () => invoke('negativePresets:list'),
    add: (input) => invoke('negativePresets:add', input),
    update: (id, patch) => invoke('negativePresets:update', id, patch),
    remove: (id) => invoke('negativePresets:remove', id),
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
    get: (id) => invoke('jobs:get', id),
  },
  images: {
    list: (opts) => invoke('images:list', opts),
    query: (q) => invoke('images:query', q),
    details: (id) => invoke('images:details', id),
    delete: (id) => invoke('images:delete', id),
    setHidden: (ids, hidden) => invoke('images:setHidden', ids, hidden),
  },
  lock: {
    state: () => invoke('lock:state'),
    open: (password) => invoke('lock:open', password),
    close: () => invoke('lock:close'),
    setPassword: (oldPassword, next) => invoke('lock:setPassword', oldPassword, next),
  },
  clipboard: { writeText: (value) => invoke('clipboard:writeText', value) },
  connection: { get: () => invoke('connection:get') },
  oplog: {
    list: (query) => invoke('oplog:list', query),
    export: (query) => invoke('oplog:export', query),
    retention: () => invoke('oplog:retention'),
    setRetention: (days) => invoke('oplog:setRetention', days),
  },
  forge: {
    capabilities: () => invoke('forge:capabilities'),
    health: () => invoke('forge:health'),
    restart: () => invoke('forge:restart'),
    unload: () => invoke('forge:unload'),
  },
  on<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void): () => void {
    if (!isEventName(event)) return () => undefined
    const channel = eventChannel(event)
    // The renderer receives the payload only, never the IpcRendererEvent.
    const listener = (_e: IpcRendererEvent, payload: AppEvents[K]): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
}

contextBridge.exposeInMainWorld('api', api)
