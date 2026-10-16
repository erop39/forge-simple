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
    setFamilyNegative: (family, presetId) => invoke('settings:setFamilyNegative', family, presetId),
    setFamilyModules: (family, modules) => invoke('settings:setFamilyModules', family, modules),
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
  civitai: {
    setEnabled: (enabled) => invoke('civitai:setEnabled', enabled),
    update: (opts) => invoke('civitai:update', opts),
    cancel: () => invoke('civitai:cancel'),
    state: () => invoke('civitai:state'),
    open: (kind, id, which) => invoke('civitai:open', kind, id, which),
    browse: (query) => invoke('civitai:browse', query),
    openModel: (modelId, versionId) => invoke('civitai:openModel', modelId, versionId),
    updateOne: (kind, id) => invoke('civitai:updateOne', kind, id),
  },
  tags: {
    suggest: (prefix) => invoke('tags:suggest', prefix),
    add: (ids, names) => invoke('tags:add', ids, names),
    remove: (ids, names) => invoke('tags:remove', ids, names),
  },
  presets: {
    list: () => invoke('presets:list'),
    save: (name, params) => invoke('presets:save', name, params),
    rename: (id, name) => invoke('presets:rename', id, name),
    remove: (id) => invoke('presets:remove', id),
    applied: (id) => invoke('presets:applied', id),
  },
  hiresPresets: {
    list: () => invoke('hiresPresets:list'),
    add: (input) => invoke('hiresPresets:add', input),
    rename: (id, name) => invoke('hiresPresets:rename', id, name),
    remove: (id) => invoke('hiresPresets:remove', id),
  },
  models: {
    setFavorite: (kind, id, favorite) => invoke('models:setFavorite', kind, id, favorite),
    setNote: (kind, id, note) => invoke('models:setNote', kind, id, note),
    setFamily: (file, family) => invoke('models:setFamily', file, family),
    setTriggers: (kind, id, triggers) => invoke('models:setTriggers', kind, id, triggers),
    generations: (kind, id) => invoke('models:generations', kind, id),
    setPreviewFromImage: (kind, id, imageId) => invoke('models:setPreviewFromImage', kind, id, imageId),
    clearPreview: (kind, id) => invoke('models:clearPreview', kind, id),
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
    clearUnfinished: () => invoke('jobs:clearUnfinished'),
    get: (id) => invoke('jobs:get', id),
  },
  images: {
    list: (opts) => invoke('images:list', opts),
    query: (q) => invoke('images:query', q),
    details: (id) => invoke('images:details', id),
    delete: (id) => invoke('images:delete', id),
    deleteMany: (ids) => invoke('images:deleteMany', ids),
    reveal: (id) => invoke('images:reveal', id),
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
  backup: {
    export: () => invoke('backup:export'),
    preview: () => invoke('backup:preview'),
    apply: () => invoke('backup:apply'),
    discard: () => invoke('backup:discard'),
  },
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
