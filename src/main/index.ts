import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, protocol } from 'electron'
import { eventChannel, type AppEvents } from '@shared/ipc'
import { createActiveForge } from './forge/active-forge'
import { createForgeClient } from './forge/client'
import { createConnectionMonitor } from './forge/connection'
import { FINDINGS } from './forge/findings'
import { forwardEvents, registerIpc } from './ipc/register'
import { createOplog } from './oplog/oplog'
import { createRunner } from './queue/runner'
import { openDb } from './storage/db'
import { resolveImageRequest } from './storage/image-protocol'
import { createImageStore, type MakeThumb } from './storage/image-store'
import { createRepos } from './storage/repos'

const THUMB_WIDTH = 480
const MONITOR_INTERVAL_MS = 2000
const LOG_RETENTION_DAYS = 90
/** before-quit waits this long for the queue to stop; recover() fixes a still-running job on next start. */
const SHUTDOWN_TIMEOUT_MS = 5000
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

// Must run before `ready`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'fnc-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
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
  const oplog = createOplog(db, now)
  const imagesDir = (): string => repos.settings.get('imagesDir') ?? join(userData, 'images')

  oplog.purgeOlderThan(LOG_RETENTION_DAYS)
  oplog.write({
    level: 'info', category: 'app', messageKey: 'log.app.started',
    details: { version: app.getVersion(), platform: process.platform },
  })

  const forge = createActiveForge({
    activeUrl: () => repos.servers.active()?.url ?? null,
    familyOverride: () => null,
    oplog,
    now,
  })
  const images = createImageStore(imagesDir, makeThumb)
  const events = forwardEvents(imagesDir, send)
  const runner = createRunner({
    client: forge.client,
    catalog: () => forge.catalog().get(),
    findings: FINDINGS,
    repos,
    images,
    oplog,
    events: events.runner,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const monitor = createConnectionMonitor({
    ping: () => forge.client().ping(),
    emit: events.connection,
    now,
    oplog,
    address: forge.address,
  })

  // The monitor runs only while the window is shown and a server is configured.
  const syncMonitor = (): void => {
    const visible = win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    if (visible && repos.servers.active()) monitor.start(MONITOR_INTERVAL_MS)
    else monitor.stop()
  }

  registerIpc(ipcMain, {
    repos,
    catalog: forge.catalog,
    runner,
    monitor,
    images,
    oplog,
    imagesDir,
    createClient: (url) => createForgeClient(url),
    copyToClipboard: (value) => clipboard.writeText(value),
    onServerChanged: syncMonitor,
  }, send)

  protocol.handle('fnc-img', async (request) => {
    const file = resolveImageRequest(request.url, imagesDir())
    const type = file ? IMAGE_TYPES[extname(file).toLowerCase()] : undefined
    if (!file || !type) return new Response(null, { status: 403 })
    try {
      return new Response(new Uint8Array(await fs.readFile(file)), { headers: { 'Content-Type': type } })
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return new Response(null, { status: missing ? 404 : 500 })
    }
  })

  runner.recover()
  runner.start()

  let closing = false
  app.on('before-quit', (event) => {
    if (closing) return
    closing = true
    event.preventDefault()
    monitor.stop()
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

  const openWindow = (): void => createWindow(syncMonitor, () => send('connection', monitor.current()))
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
