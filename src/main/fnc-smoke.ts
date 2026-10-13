// Live wiring smoke run. Loaded only when FNC_SMOKE=1 (see CLAUDE.md). Drives window.api from the
// renderer against a Forge-compatible server at FNC_SMOKE_SERVER (default 127.0.0.1:7861), prints one
// JSON line prefixed with "FNC_SMOKE " and quits through the normal before-quit path.
import { app, net, type BrowserWindow } from 'electron'

const SCRIPT = (server: string): string => `(async () => {
  const out = {}
  const step = async (name, fn) => { try { out[name] = await fn() } catch (e) { out[name] = { threw: e && e.message } } }
  await step('setServerUrl', () => window.api.settings.setServerUrl(${JSON.stringify(server)}))
  let catalog
  await step('catalog', async () => { catalog = await window.api.catalog.get(); return { checkpoints: catalog.checkpoints.length } })
  let params
  await step('defaults', async () => { params = await window.api.catalog.defaults(catalog.checkpoints[0].title); return { family: params.family, checkpoint: params.checkpoint } })
  const added = new Promise((resolve, reject) => {
    const off = window.api.on('image:added', (img) => { off(); resolve(img) })
    setTimeout(() => reject(new Error('timeout waiting for image:added')), 60000)
  })
  await step('enqueue', async () => { const jobs = await window.api.jobs.enqueue({ ...params, prompt: 'smoke test' }); return { jobs: jobs.length } })
  await step('imageAdded', async () => {
    const img = await added
    // The page CSP allows fnc-img only for img-src, so the renderer checks with a real <img>; status codes come from main.
    const loaded = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => resolve('error'); i.src = img.thumbUrl })
    return { thumbUrl: img.thumbUrl, leaksPaths: 'filePath' in img || 'thumbPath' in img, imgLoad: loaded }
  })
  await step('enqueueEmpty', async () => { try { await window.api.jobs.enqueue({}); return 'resolved' } catch (e) { return e.message } })
  return out
})()`

export function runSmoke(win: BrowserWindow): void {
  const server = process.env['FNC_SMOKE_SERVER'] ?? '127.0.0.1:7861'
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript(SCRIPT(server))
      .then(async (result: Record<string, unknown>) => {
        const thumbUrl = (result['imageAdded'] as { thumbUrl?: string } | undefined)?.thumbUrl
        const probe = async (url: string | undefined): Promise<unknown> => {
          if (!url) return 'no url'
          try {
            const r = await net.fetch(url)
            return { status: r.status, contentType: r.headers.get('content-type') }
          } catch (e) {
            return { threw: String(e) }
          }
        }
        result['thumbFetch'] = await probe(thumbUrl)
        result['fetchDotDot'] = await probe('fnc-img://local/../x.png')
        result['fetchBackslash'] = await probe('fnc-img://local/..%5Cx.png')
        console.log(`FNC_SMOKE ${JSON.stringify(result)}`)
      })
      .catch((err: unknown) => console.log(`FNC_SMOKE ${JSON.stringify({ failed: String(err) })}`))
      .finally(() => app.quit())
  })
}
