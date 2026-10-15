import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, protocol, shell } from 'electron'
import { eventChannel, type AppEvents } from '@shared/ipc'
import { createPreviewService, type PreviewService } from './forge/previews'
import { createActiveForge } from './forge/active-forge'
import { createCapabilities } from './forge/capabilities'
import { createForgeClient } from './forge/client'
import { createConnectionMonitor } from './forge/connection'
import { createResourceMonitor } from './forge/resources'
import { FINDINGS } from './forge/findings'
import { forwardEvents, registerIpc } from './ipc/register'
import { createLock } from './lock/lock'
import { createOplog, RETENTION_KEY, retentionDays } from './oplog/oplog'
import { createRunner } from './queue/runner'
import { openDb } from './storage/db'
import { createImageHandler } from './storage/image-protocol'
import { createImageStore, type MakeThumb } from './storage/image-store'
import { createRepos } from './storage/repos'

const THUMB_WIDTH = 480
const MONITOR_INTERVAL_MS = 2000
/** before-quit waits this long for the queue to stop; recover() fixes a still-running job on next start. */
const SHUTDOWN_TIMEOUT_MS = 5000

// Must run before `ready`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'fnc-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'fnc-model', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const makeThumb: MakeThumb = (png) => {
  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) throw new Error('Image data could not be decoded')
  const { width, height } = image.getSize()
  const small = width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image
  return { thumb: small.toJPEG(80), width, height }
}

let win: BrowserWindow | null = null

function send<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(eventChannel(event), payload)
}

function createWindow(onVisibilityChange: () => void, onLoaded: () => void): void {
  const appOrigin = process.env['ELECTRON_RENDERER_URL'] ? new URL(process.env['ELECTRON_RENDERER_URL']).origin : 'file://'
  const created = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0B0B0A',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0B0B0A', symbolColor: '#A8A59C', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win = created

  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event, url) => {
    let origin: string
    try {
      origin = url.startsWith('file://') ? 'file://' : new URL(url).origin
    } catch {
      origin = '' // unparsable: treat as off-origin
    }
    if (origin !== appOrigin) event.preventDefault()
  })
  created.once('ready-to-show', () => created.show())
  created.webContents.on('did-finish-load', onLoaded) // a reloaded page must not start from a stale status
  created.on('show', onVisibilityChange)
  created.on('hide', onVisibilityChange)
  created.on('minimize', onVisibilityChange)
  created.on('restore', onVisibilityChange)
  created.on('closed', () => {
    if (win === created) win = null
    onVisibilityChange() // no window left: stops the monitor
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void created.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void created.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData')
  const db = openDb(join(userData, 'forge-neo-client.db'))
  const now = (): number => Date.now()
  const repos = createRepos(db, now)
  const oplog = createOplog(db, now, (entry) => send('oplog:added', entry))
  const defaultImagesDir = join(userData, 'images')
  const imagesDir = (): string => repos.settings.get('imagesDir') ?? defaultImagesDir
  const imageRoots = (): string[] => {
    let saved: unknown
    try { saved = JSON.parse(repos.settings.get('images.roots') ?? '[]') }
    catch { saved = [] }
    const roots = [defaultImagesDir, ...(Array.isArray(saved) ? saved : []), imagesDir()]
    return [...new Map(roots.filter((root): root is string => typeof root === 'string' && isAbsolute(root))
      .map((root) => [resolve(root).toLowerCase(), resolve(root)])).values()]
  }
  // Closed at every start: whether it is open lives only in memory.
  const lock = createLock(repos.settings, oplog)

  oplog.purgeOlderThan(retentionDays(repos.settings.get(RETENTION_KEY)))
  oplog.write({
    level: 'info', category: 'app', messageKey: 'log.app.started',
    details: { version: app.getVersion(), platform: process.platform },
  })

  // Previews are fetched through the active Forge; the catalog hands out their URLs.
  let previews: PreviewService | null = null
  const forge = createActiveForge({
    activeUrl: () => repos.servers.active()?.url ?? null,
    familyOverride: () => null,
    modelMeta: (kind) => {
      const serverId = repos.servers.active()?.id
      return serverId === undefined ? new Map() : repos.modelMeta.list(serverId, kind)
    },
    previewUrl: (kind, filename) => previews?.urlFor(kind, filename) ?? '',
    oplog,
    now,
  })
  previews = createPreviewService({
    client: () => forge.client(),
    serverId: () => repos.servers.active()?.id ?? null,
    cacheDir: () => join(userData, 'model-previews'),
    meta: repos.modelMeta,
  })
  const images = createImageStore(imagesDir, makeThumb, imageRoots)
  const events = forwardEvents(send, lock)
  const resources = createResourceMonitor({
    read: () => forge.client().memory(),
    readStats: () => forge.client().stats(),
    now,
    emit: (snapshot) => send('resources', snapshot),
    runningJob: () => {
      const serverId = repos.servers.active()?.id
      return repos.jobs.listActive().find((job) => job.status === 'running' && job.serverId === serverId)?.id ?? null
    },
  })
  const runner = createRunner({
    client: forge.client,
    catalog: () => forge.catalog().get(),
    findings: FINDINGS,
    repos,
    images,
    lock,
    oplog,
    events: { ...events.runner, jobUpdate: (job) => { events.runner.jobUpdate(job); resources.jobChanged() } },
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    peakVram: resources.takePeak,
  })
  const capabilities = createCapabilities({ client: forge.client, emit: events.capabilities })
  const monitor = createConnectionMonitor({
    ping: () => forge.client().ping(),
    emit: (status) => {
      events.connection(status)
      capabilities.onConnection(status)
      resources.onConnection(status.state === 'connected' || status.state === 'slow')
    },
    now,
    oplog,
    address: forge.address,
  })

  // The monitor runs only while the window is shown and a server is configured.
  const syncMonitor = (): void => {
    const visible = win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    const server = repos.servers.active()
    if (visible && server) {
      monitor.start(MONITOR_INTERVAL_MS)
      resources.start(String(server.id))
    } else {
      monitor.stop()
      resources.stop()
    }
  }

  registerIpc(ipcMain, {
    repos,
    catalog: forge.catalog,
    runner,
    monitor,
    images,
    oplog,
    imagesDir,
    imageRoots,
    createClient: (url, opts) => createForgeClient(url, opts),
    // Dev builds only: points the first-run check of the local Forge at a mock (manual checks).
    localUrl: !app.isPackaged ? process.env['FNC_LOCAL_SERVER'] || undefined : undefined,
    copyToClipboard: (value) => clipboard.writeText(value),
    revealFile: (path) => shell.showItemInFolder(path),
    onServerChanged: syncMonitor,
    capabilities,
    lock,
    chooseExportPath: async (defaultName) => {
      const options = { defaultPath: join(app.getPath('documents'), defaultName) }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    chooseImagesDir: async (current) => {
      const options = { defaultPath: current, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
    },
  }, send)

  // The files of hidden images answer 404 while the lock is closed.
  const serveImage = createImageHandler({
    baseDir: imagesDir,
    isBlocked: () => false,
    lookupImage: repos.images.get,
    roots: imageRoots,
    lockOpen: lock.isOpen,
  })
  protocol.handle('fnc-img', (request) => serveImage(request.url))
  protocol.handle('fnc-model', (request) => previews!.serve(request.url))

  runner.recover()
  runner.start()

  let closing = false
  app.on('before-quit', (event) => {
    if (closing) return
    closing = true
    event.preventDefault()
    monitor.stop()
    resources.stop()
    void (async () => {
      try {
        await Promise.race([
          runner.stop(),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
        ])
        oplog.write({ level: 'info', category: 'app', messageKey: 'log.app.closed' })
        db.close()
      } catch (err) {
        console.error('shutdown failed', err)
      } finally {
        app.quit()
      }
    })()
  })

  const openWindow = (): void => createWindow(syncMonitor, () => {
    send('connection', monitor.current())
    send('resources', resources.current())
  })
  openWindow()
  if (process.env['FNC_SMOKE'] === '1' && !app.isPackaged && win) {
    const { runSmoke } = await import('./fnc-smoke')
    runSmoke(win)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  void app.whenReady().then(boot).catch((err: unknown) => {
    console.error('startup failed', err)
    app.exit(1)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
