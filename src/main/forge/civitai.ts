import type { CivitaiInfo } from '@shared/types'

const API = 'https://civitai.com/api/v1/model-versions/by-hash/'
const MODEL_API = 'https://civitai.com/api/v1/models/'
const HASH = /^[0-9a-fA-F]{10,64}$/

/** A request Civitai refused for now (rate limit or a server fault): the caller waits and tries later. */
export class CivitaiBusyError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number) {
    super(`Civitai answered HTTP ${status}`)
  }
}

export interface CivitaiClient {
  /** The model version a file's hash belongs to; null when Civitai does not know it. */
  lookup(hash: string, signal?: AbortSignal): Promise<CivitaiInfo | null>
}

/** The newest version in a model's answer (`modelVersions`, newest first on Civitai; chosen by publish date anyway). */
export function parseLatest(json: unknown): CivitaiInfo['latest'] {
  if (typeof json !== 'object' || json === null) return null
  const versions = (json as { modelVersions?: unknown }).modelVersions
  if (!Array.isArray(versions)) return null
  let best: { versionId: number; name: string; publishedAt: number | null } | null = null
  for (const v of versions) {
    if (typeof v !== 'object' || v === null) continue
    const o = v as Record<string, unknown>
    if (typeof o.id !== 'number') continue
    const publishedAt = typeof o.publishedAt === 'string' && Number.isFinite(Date.parse(o.publishedAt)) ? Date.parse(o.publishedAt) : null
    const candidate = { versionId: o.id, name: text(o.name), publishedAt }
    if (best === null || (publishedAt ?? 0) > (best.publishedAt ?? 0) || ((publishedAt ?? 0) === (best.publishedAt ?? 0) && o.id > best.versionId)) best = candidate
  }
  return best
}

/** Allowed image hosts: a preview is only fetched from Civitai's own domains over https. */
export function isCivitaiImage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'civitai.com' || u.hostname.endsWith('.civitai.com'))
  } catch {
    return false
  }
}

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Reduces Civitai's answer to the few fields the app keeps. Anything off-shape reads as "not known". */
export function parseVersion(json: unknown, now: number): CivitaiInfo | null {
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>
  const id = typeof o.id === 'number' ? o.id : null
  const modelId = typeof o.modelId === 'number' ? o.modelId : null
  if (id === null || modelId === null) return null
  const model = typeof o.model === 'object' && o.model !== null ? (o.model as Record<string, unknown>) : {}
  const words = Array.isArray(o.trainedWords)
    ? o.trainedWords.filter((w): w is string => typeof w === 'string').map((w) => w.trim()).filter((w) => w !== '' && w.length <= 120).slice(0, 20)
    : []
  const images = Array.isArray(o.images) ? o.images : []
  const firstImage = images
    .map((i) => (typeof i === 'object' && i !== null ? (i as Record<string, unknown>) : {}))
    .find((i) => typeof i.url === 'string' && isCivitaiImage(i.url) && (i.type === undefined || i.type === 'image'))
  return {
    modelId, versionId: id, name: text(model.name), versionName: text(o.name), baseModel: text(o.baseModel, 60),
    trainedWords: words, imageUrl: firstImage ? (firstImage.url as string) : null, checkedAt: now,
    publishedAt: typeof o.publishedAt === 'string' && Number.isFinite(Date.parse(o.publishedAt)) ? Date.parse(o.publishedAt) : null,
  }
}

/** Looks files up by SHA-256 only; nothing else about the library is sent. */
export function createCivitaiClient(deps: { fetch?: typeof fetch; now(): number }): CivitaiClient {
  const doFetch = deps.fetch ?? fetch
  const latestOf = new Map<number, CivitaiInfo['latest']>()
  async function latest(modelId: number, signal?: AbortSignal): Promise<CivitaiInfo['latest'] | undefined> {
    if (latestOf.has(modelId)) return latestOf.get(modelId)
    try {
      const res = await doFetch(`${MODEL_API}${modelId}`, {
        headers: { accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
      if (!res.ok) return undefined // busy or gone: the file is checked again on the next run
      const found = parseLatest(await res.json())
      latestOf.set(modelId, found)
      return found
    } catch {
      return undefined
    }
  }
  return {
    async lookup(hash, signal) {
      if (!HASH.test(hash)) return null
      const res = await doFetch(`${API}${hash.toLowerCase()}`, {
        headers: { accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
      if (res.status === 404) return null
      if (res.status === 429 || res.status >= 500) {
        const retry = Number(res.headers.get('retry-after'))
        throw new CivitaiBusyError(res.status, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000)
      }
      if (!res.ok) return null
      const info = parseVersion(await res.json(), deps.now())
      if (!info) return null
      const newest = await latest(info.modelId, signal)
      return newest === undefined ? info : { ...info, latest: newest }
    },
  }
}

const BROWSE_API = 'https://civitai.com/api/v1/models'
const PERIOD_MS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const
const PERIOD_NAME = { day: 'Day', week: 'Week', month: 'Month' } as const
const SORT_NAME = { newest: 'Newest', downloads: 'Most Downloaded', rating: 'Highest Rated' } as const

export interface BrowseEntry {
  modelId: number; versionId: number; name: string; versionName: string; baseModel: string; creator: string
  publishedAt: number | null; downloads: number; url: string; imageUrl: string | null
}

/** The newest version of every model in a listing page, reduced to what the browser shows. */
export function parseBrowse(json: unknown): { entries: BrowseEntry[]; next: string | null } {
  const root = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  const list = Array.isArray(root.items) ? root.items : []
  const meta = typeof root.metadata === 'object' && root.metadata !== null ? (root.metadata as Record<string, unknown>) : {}
  const next = typeof meta.nextCursor === 'string' && meta.nextCursor !== '' && meta.nextCursor.length <= 200 ? meta.nextCursor : null
  const entries: BrowseEntry[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const m = raw as Record<string, unknown>
    if (typeof m.id !== 'number') continue
    const versions = Array.isArray(m.modelVersions) ? m.modelVersions : []
    let best: Record<string, unknown> | null = null
    let bestAt = -1
    for (const v of versions) {
      if (typeof v !== 'object' || v === null || typeof (v as { id?: unknown }).id !== 'number') continue
      const at = Date.parse(text((v as Record<string, unknown>).publishedAt, 40))
      const t = Number.isFinite(at) ? at : 0
      if (t > bestAt) { best = v as Record<string, unknown>; bestAt = t }
    }
    if (!best) continue
    const images = Array.isArray(best.images) ? best.images : []
    const img = images
      .map((i) => (typeof i === 'object' && i !== null ? (i as Record<string, unknown>) : {}))
      .find((i) => typeof i.url === 'string' && isCivitaiImage(i.url) && (i.type === undefined || i.type === 'image'))
    const creator = typeof m.creator === 'object' && m.creator !== null ? text((m.creator as Record<string, unknown>).username, 60) : ''
    const stats = typeof best.stats === 'object' && best.stats !== null ? (best.stats as Record<string, unknown>) : {}
    entries.push({
      modelId: m.id, versionId: best.id as number, name: text(m.name), versionName: text(best.name), baseModel: text(best.baseModel, 60), creator,
      publishedAt: bestAt > 0 ? bestAt : null, downloads: typeof stats.downloadCount === 'number' ? stats.downloadCount : 0,
      url: `https://civitai.com/models/${m.id}?modelVersionId=${best.id as number}`, imageUrl: img ? (img.url as string) : null,
    })
  }
  return { entries, next }
}

/** One page of Civitai's public model listing (safe-for-work only); versions older than the period are dropped when sorting by date. */
export async function browseCivitai(
  query: { kind: 'checkpoint' | 'lora'; period: keyof typeof PERIOD_MS; sort: keyof typeof SORT_NAME; baseModels: string[]; text: string; cursor?: string | null },
  deps: { fetch?: typeof fetch; now(): number }, signal?: AbortSignal,
): Promise<{ entries: BrowseEntry[]; next: string | null }> {
  const params = new URLSearchParams({
    types: query.kind === 'checkpoint' ? 'Checkpoint' : 'LORA', sort: SORT_NAME[query.sort], period: PERIOD_NAME[query.period],
    limit: '24', nsfw: 'false',
  })
  for (const b of query.baseModels.slice(0, 10)) params.append('baseModels', b)
  if (query.text.trim() !== '') params.set('query', query.text.trim().slice(0, 100))
  if (query.cursor) params.set('cursor', query.cursor)
  const res = await (deps.fetch ?? fetch)(`${BROWSE_API}?${params}`, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  if (res.status === 429 || res.status >= 500) throw new CivitaiBusyError(res.status, 60_000)
  if (!res.ok) throw new Error(`Civitai answered HTTP ${res.status}`)
  const page = parseBrowse(await res.json())
  if (query.sort !== 'newest') return page
  // Newest-first: everything after the first version outside the window is older still, so paging stops there.
  const cutoff = deps.now() - PERIOD_MS[query.period]
  const kept = page.entries.filter((e) => (e.publishedAt ?? 0) >= cutoff)
  return { entries: kept, next: kept.length < page.entries.length ? null : page.next }
}

/** A small preview of a Civitai image as a data URL (https civitai.com only, at most 400 KB); null on any failure. */
export async function fetchThumb(url: string, doFetch: typeof fetch = fetch): Promise<string | null> {
  if (!isCivitaiImage(url)) return null
  const small = url.replace(/\/(?:width=\d+|original=true)\//, '/width=320/')
  try {
    const res = await doFetch(small, { signal: AbortSignal.timeout(15_000) })
    // The CDN redirects to its blob host: that is fine while it stays on civitai.com (the final address is checked).
    if (res.url !== '' && !isCivitaiImage(res.url)) return null
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !/^image\/(jpeg|png|webp|avif)$/.test(type)) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    return bytes.length > 400_000 ? null : `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}
