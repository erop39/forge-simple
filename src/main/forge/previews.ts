import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelKind } from '@shared/types'
import type { ModelMetaRow } from '../storage/repos'
import type { ForgeClient } from './client'
import { isCivitaiImage } from './civitai'

const EXTENSIONS = ['png', 'preview.png', 'jpg', 'preview.jpg', 'jpeg', 'preview.jpeg', 'webp', 'preview.webp']
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const MAX_PARALLEL = 4
const KEY = /^[0-9a-f]{20}$/

/** The files Forge's extra-networks UI treats as a preview of a model file, in the order they are tried. */
export function previewCandidates(modelFilename: string): string[] {
  const dot = modelFilename.lastIndexOf('.')
  const slash = Math.max(modelFilename.lastIndexOf('/'), modelFilename.lastIndexOf('\\'))
  const stem = dot > slash ? modelFilename.slice(0, dot) : modelFilename
  return EXTENSIONS.map((ext) => `${stem}.${ext}`)
}

export interface PreviewDeps {
  client(): ForgeClient
  /** The active server; null when there is none (nothing is served). */
  serverId(): number | null
  cacheDir(): string
  /** An image Civitai holds for the file (https, civitai.com only); used when Forge has no preview of its own. */
  remoteImage?(kind: ModelKind, filename: string): string | null
  meta: {
    get(serverId: number, kind: ModelKind, filename: string): ModelMetaRow | null
    setPreview(serverId: number, kind: ModelKind, filename: string, preview: string): void
    clearPreview?(serverId: number, kind: ModelKind, filename: string): void
  }
  now?(): number
}

export interface PreviewService {
  /** Registers a model file and returns the URL the renderer uses for its preview (`stamp` changes it when the picture does). */
  urlFor(kind: ModelKind, filename: string, stamp?: string | null): string
  /** Makes these JPEG bytes the model's own preview; returns the stored marker (`custom-<ms>`). */
  setCustom(kind: ModelKind, filename: string, bytes: Buffer): Promise<string>
  /** Drops the user's own preview so Forge's (or Civitai's) is looked up again. */
  clearCustom(kind: ModelKind, filename: string): void
  /** Serves `fnc-model://local/<kind>/<key>`: bytes from the cache, or fetched from Forge once. */
  serve(url: string): Promise<Response>
}

const keyOf = (filename: string): string => createHash('sha1').update(filename).digest('hex').slice(0, 20)

/**
 * Previews come from Forge's own thumb route. Only files of the loaded catalog can be asked for (the URL holds a
 * hash, not a path), at most four requests run at a time, and a model without a preview is not looked up again
 * until `clearPreviews` is called for its server.
 */
export function createPreviewService(deps: PreviewDeps): PreviewService {
  const known = new Map<string, { kind: ModelKind; filename: string }>()
  const inFlight = new Map<string, Promise<{ file: string; type: string } | null>>()
  let running = 0
  const waiting: (() => void)[] = []

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try { return await work() } finally {
      running--
      waiting.shift()?.()
    }
  }

  const cachePath = (serverId: number, filename: string, ext: string): string =>
    path.join(deps.cacheDir(), String(serverId), `${keyOf(filename)}.${ext}`)

  async function resolve(kind: ModelKind, filename: string): Promise<{ file: string; type: string } | null> {
    const serverId = deps.serverId()
    if (serverId === null) return null
    const row = deps.meta.get(serverId, kind, filename)
    const remote = deps.remoteImage?.(kind, filename) ?? null
    if (row?.preview?.startsWith('custom-')) {
      const custom = cachePath(serverId, filename, 'custom.jpg')
      try {
        await fs.access(custom)
        return { file: custom, type: 'image/jpeg' }
      } catch { /* the file is gone: fall back to the usual lookup */ }
    }
    if (row?.preview === '' && remote === null) return null
    if (row?.preview) {
      const file = cachePath(serverId, filename, row.preview)
      try {
        await fs.access(file)
        return { file, type: TYPES[row.preview] ?? 'image/png' }
      } catch { /* the cache file is gone: look it up again */ }
    }
    return slot(async () => {
      const client = deps.client()
      for (const candidate of row?.preview === '' ? [] : previewCandidates(filename)) {
        let hit: Awaited<ReturnType<ForgeClient['thumb']>>
        try {
          hit = await client.thumb(candidate)
        } catch {
          return null // Forge is unreachable now: nothing is recorded, the next request tries again
        }
        if (!hit) continue
        const ext = hit.type.includes('jpeg') ? 'jpg' : hit.type.includes('webp') ? 'webp' : 'png'
        const file = cachePath(serverId, filename, ext)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, hit.bytes)
        deps.meta.setPreview(serverId, kind, filename, ext)
        return { file, type: TYPES[ext]! }
      }
      if (remote !== null && isCivitaiImage(remote)) {
        try {
          const res = await fetch(remote, { signal: AbortSignal.timeout(15_000) })
          const type = res.headers.get('content-type') ?? ''
          const bytes = res.ok && type.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : null
          if (bytes && bytes.length <= 8 * 1024 * 1024) {
            const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
            const file = cachePath(serverId, filename, ext)
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, bytes)
            deps.meta.setPreview(serverId, kind, filename, ext)
            return { file, type: TYPES[ext]! }
          }
        } catch { /* Civitai is not reachable now: the next request tries again */ }
      }
      deps.meta.setPreview(serverId, kind, filename, '')
      return null
    })
  }

  return {
    urlFor(kind, filename, stamp) {
      const key = keyOf(filename)
      known.set(`${kind}/${key}`, { kind, filename })
      return `fnc-model://local/${kind}/${key}${stamp ? `?v=${encodeURIComponent(stamp)}` : ''}`
    },
    async setCustom(kind, filename, bytes) {
      const serverId = deps.serverId()
      if (serverId === null) throw new Error('no server')
      const file = cachePath(serverId, filename, 'custom.jpg')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, bytes)
      const marker = `custom-${(deps.now ?? Date.now)()}`
      deps.meta.setPreview(serverId, kind, filename, marker)
      return marker
    },
    clearCustom(kind, filename) {
      const serverId = deps.serverId()
      if (serverId === null) return
      const row = deps.meta.get(serverId, kind, filename)
      if (!row?.preview?.startsWith('custom-')) return
      deps.meta.setPreview(serverId, kind, filename, '')
      deps.meta.clearPreview?.(serverId, kind, filename)
      void fs.rm(cachePath(serverId, filename, 'custom.jpg'), { force: true })
    },
    async serve(url) {
      const match = /^fnc-model:\/\/local\/(checkpoint|lora)\/([0-9a-f]+)(?:\?v=[\w%.-]+)?$/.exec(url)
      if (!match || !KEY.test(match[2]!)) return new Response(null, { status: 404 })
      const entry = known.get(`${match[1]}/${match[2]}`)
      if (!entry) return new Response(null, { status: 404 })
      const flightKey = `${entry.kind}/${entry.filename}`
      let promise = inFlight.get(flightKey)
      if (!promise) {
        promise = resolve(entry.kind, entry.filename).finally(() => inFlight.delete(flightKey))
        inFlight.set(flightKey, promise)
      }
      let found: { file: string; type: string } | null
      try { found = await promise } catch { found = null }
      if (!found) return new Response(null, { status: 404 })
      try {
        const bytes = await fs.readFile(found.file)
        return new Response(bytes, { status: 200, headers: { 'content-type': found.type, 'cache-control': 'private, max-age=86400' } })
      } catch {
        return new Response(null, { status: 404 })
      }
    },
  }
}
