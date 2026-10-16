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
