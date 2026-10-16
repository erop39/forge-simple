import type { RestartOutcome } from '@shared/types'
import type { ForgeStats, MemoryMetrics } from '@shared/types'
import { parseMemory } from './resources'
import { parseStats } from './stats'

export const DEFAULT_LIST_TIMEOUT_MS = 10_000
export const DEFAULT_PING_TIMEOUT_MS = 5_000
export const DEFAULT_LORAS_TIMEOUT_MS = 180_000
export const DEFAULT_CONTROL_TIMEOUT_MS = 60_000

export type ForgeErrorKind = 'network' | 'timeout' | 'http' | 'invalid'

export class ForgeError extends Error {
  kind: ForgeErrorKind
  status?: number
  detail?: string

  constructor(kind: ForgeErrorKind, message: string, extra: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'ForgeError'
    this.kind = kind
    if (extra.status !== undefined) this.status = extra.status
    if (extra.detail !== undefined) this.detail = extra.detail
  }
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new ForgeError('invalid', 'Server address is empty')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ForgeError('invalid', 'Server address is not a valid URL', { detail: trimmed })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    throw new ForgeError('invalid', 'Server address must be an http or https URL', { detail: trimmed })
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export interface Txt2ImgBody {
  prompt: string
  negative_prompt: string
  steps: number
  cfg_scale: number
  distilled_cfg_scale?: number
  enable_hr?: true
  hr_scale?: number
  hr_upscaler?: string
  hr_second_pass_steps?: number
  hr_cfg?: number
  hr_distilled_cfg?: number
  denoising_strength?: number
  sampler_name: string
  scheduler: string
  width: number
  height: number
  seed: number
  batch_size: 1
  n_iter: 1
  send_images: true
  save_images: false
  override_settings: Record<string, unknown>
  override_settings_restore_afterwards: false
}

export interface Img2ImgBody extends Omit<Txt2ImgBody, 'enable_hr' | 'hr_scale' | 'hr_upscaler' | 'hr_second_pass_steps' | 'hr_cfg' | 'hr_distilled_cfg'> {
  init_images: string[]
  denoising_strength: number
  resize_mode: 0 | 1 | 2 | 3
}

export interface UpscaleBody {
  image: string
  upscaling_resize: 1.5 | 2 | 4
  upscaler_1: string
  resize_mode: 0
  show_extras_results: true
}

export interface GenerationResponse {
  images: string[]
  info: string
}

export interface ProgressResponse {
  progress: number
  eta_relative: number
  current_image: string | null
  state: { sampling_step: number; sampling_steps: number; job_no: number; job_count: number }
}

export interface SdModel {
  title: string
  model_name: string
  filename: string
  hash: string | null
  sha256: string | null
}

export interface SdModule {
  model_name: string
  filename: string
}

export interface LoraItem {
  name: string
  alias: string
  path: string
  metadata: Record<string, unknown>
}

export type { RestartOutcome }

/** Connection errors that mean Forge dropped a request it had received (rather than never getting it). */
const DROPPED = /other side closed|socket hang up|ECONNRESET|EPIPE|terminated|UND_ERR_SOCKET/i

export interface ForgeClient {
  ping(): Promise<number>
  txt2img(body: Txt2ImgBody, signal?: AbortSignal): Promise<GenerationResponse>
  img2img(body: Img2ImgBody, signal?: AbortSignal): Promise<GenerationResponse>
  upscale(body: UpscaleBody, signal?: AbortSignal): Promise<GenerationResponse>
  progress(): Promise<ProgressResponse>
  /** Read-only Forge process and CUDA memory readings. */
  memory(): Promise<MemoryMetrics>
  /** Optional read-only companion extension; null means HTTP 404. */
  stats(): Promise<ForgeStats | null>
  interrupt(): Promise<void>
  models(): Promise<SdModel[]>
  modules(): Promise<SdModule[]>
  loras(): Promise<LoraItem[]>
  /** A file next to a model (its preview) through Forge's thumb route; null when Forge has none. */
  thumb(filename: string): Promise<{ bytes: Buffer; type: string } | null>
  samplers(): Promise<string[]>
  /** Scheduler labels (e.g. "Automatic"), falling back to the internal name. */
  schedulers(): Promise<string[]>
  upscalers(): Promise<string[]>
  /** Forge's latent second-pass modes (`Latent`, `Latent (nearest)`…): they are not in `upscalers()`. */
  latentUpscaleModes(): Promise<string[]>
  options(): Promise<Record<string, unknown>>
  /** Forge's launch flags (`/cmd-flags`), e.g. `api_server_stop`. */
  cmdFlags(): Promise<Record<string, unknown>>
  /** Unloads the current checkpoint; the next generation loads it afresh. Default timeout: the control timeout. */
  unloadCheckpoint(timeoutMs?: number): Promise<void>
  /** Asks Forge to restart itself; throws a ForgeError only when the request could not be sent or failed otherwise. */
  restartServer(): Promise<RestartOutcome>
}

const API = '/sdapi/v1'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(what: string): ForgeError {
  return new ForgeError('invalid', `Unexpected response from Forge: ${what}`)
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw invalid(`${what} is not a list`)
  return v
}

function asObj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw invalid(`${what} is not an object`)
  return v
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw invalid(`${what}.${key} is not a string`)
  return v
}

function num(o: Obj, key: string, what: string): number {
  const v = o[key]
  if (typeof v !== 'number') throw invalid(`${what}.${key} is not a number`)
  return v
}

function errorDetail(text: string): string {
  try {
    const json: unknown = JSON.parse(text)
    if (isObj(json)) {
      // Forge's exception handler puts the class name in `error` and its message in `errors`.
      if (typeof json.error === 'string' && json.error !== '' && typeof json.errors === 'string' && json.errors !== '') {
        return `${json.error}: ${json.errors}`.slice(0, 300)
      }
      for (const key of ['detail', 'error', 'message']) {
        const v = json[key]
        if (v === undefined || v === null || v === '') continue
        return (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200)
      }
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, 200)
}

function parseProgress(value: unknown): ProgressResponse {
  const json = asObj(value, 'progress')
  const state = asObj(json.state, 'progress.state')
  const image = json.current_image
  return {
    progress: num(json, 'progress', 'progress'),
    eta_relative: typeof json.eta_relative === 'number' ? json.eta_relative : 0,
    current_image: typeof image === 'string' && image !== '' ? image : null,
    state: {
      sampling_step: num(state, 'sampling_step', 'state'),
      sampling_steps: num(state, 'sampling_steps', 'state'),
      job_no: typeof state.job_no === 'number' ? state.job_no : 0,
      job_count: typeof state.job_count === 'number' ? state.job_count : 0,
    },
  }
}

export function createForgeClient(
  baseUrl: string,
  opts: { listTimeoutMs?: number; pingTimeoutMs?: number; lorasTimeoutMs?: number; controlTimeoutMs?: number } = {},
): ForgeClient {
  const base = normalizeBaseUrl(baseUrl)
  const listTimeoutMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS
  const pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
  const lorasTimeoutMs = opts.lorasTimeoutMs ?? DEFAULT_LORAS_TIMEOUT_MS
  const controlTimeoutMs = opts.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS

  async function request(
    method: 'GET' | 'POST',
    path: string,
    o: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const timeout = o.timeoutMs === undefined ? undefined : AbortSignal.timeout(o.timeoutMs)
    const signals = [timeout, o.signal].filter((s): s is AbortSignal => s !== undefined)
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined
    let status: number
    let text: string
    try {
      const res = await fetch(base + path, {
        method,
        ...(o.body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.body) }
          : {}),
        ...(signal ? { signal } : {}),
      })
      status = res.status
      text = await res.text()
    } catch (e) {
      if (o.signal?.aborted) throw new ForgeError('network', 'Request was aborted', { detail: 'aborted' })
      if (timeout?.aborted) throw new ForgeError('timeout', 'Forge did not answer in time')
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined
      throw new ForgeError('network', 'Could not reach Forge', {
        detail: cause ?? (e instanceof Error ? e.message : String(e)),
      })
    }
    if (status < 200 || status >= 300) {
      throw new ForgeError('http', `Forge answered HTTP ${status}`, { status, detail: errorDetail(text) })
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ForgeError('invalid', 'Forge answered with a body that is not JSON', {
        status,
        detail: text.slice(0, 200),
      })
    }
  }

  const list = async (path: string, timeoutMs = listTimeoutMs): Promise<unknown[]> =>
    asArray(await request('GET', `${API}/${path}`, { timeoutMs }), path)

  const names = (items: unknown[], what: string): string[] =>
    items.map((item) => (typeof item === 'string' ? item : str(asObj(item, what), 'name', what)))

  return {
    async ping() {
      const started = performance.now()
      parseProgress(
        await request('GET', `${API}/progress?skip_current_image=true`, { timeoutMs: pingTimeoutMs }),
      )
      return Math.round(performance.now() - started)
    },

    async txt2img(body, signal) {
      const json = asObj(
        await request('POST', `${API}/txt2img`, { body, ...(signal ? { signal } : {}) }),
        'txt2img',
      )
      const images = asArray(json.images, 'images')
      if (!images.every((i): i is string => typeof i === 'string')) throw invalid('images holds a non-string')
      return { images, info: typeof json.info === 'string' ? json.info : '' }
    },

    async img2img(body, signal) {
      const json = asObj(
        await request('POST', `${API}/img2img`, { body, ...(signal ? { signal } : {}) }),
        'img2img',
      )
      const images = asArray(json.images, 'images')
      if (!images.every((i): i is string => typeof i === 'string')) throw invalid('images holds a non-string')
      return { images, info: typeof json.info === 'string' ? json.info : '' }
    },

    async upscale(body, signal) {
      const json = asObj(
        await request('POST', `${API}/extra-single-image`, { body, ...(signal ? { signal } : {}) }),
        'extra-single-image',
      )
      const image = str(json, 'image', 'extra-single-image')
      if (image === '') throw invalid('extra-single-image.image is empty')
      return { images: [image], info: '' }
    },

    async progress() {
      return parseProgress(await request('GET', `${API}/progress`, { timeoutMs: listTimeoutMs }))
    },

    async memory() {
      return parseMemory(await request('GET', `${API}/memory`, { timeoutMs: pingTimeoutMs }))
    },

    async stats() {
      try {
        return parseStats(await request('GET', '/forge-neo-client/v1/stats', { timeoutMs: pingTimeoutMs }))
      } catch (error) {
        if (error instanceof ForgeError && error.kind === 'http' && error.status === 404) return null
        throw error
      }
    },

    async interrupt() {
      await request('POST', `${API}/interrupt`, { timeoutMs: listTimeoutMs })
    },

    async models() {
      return (await list('sd-models')).map((item) => {
        const o = asObj(item, 'sd-models item')
        return {
          title: str(o, 'title', 'sd-models'),
          model_name: str(o, 'model_name', 'sd-models'),
          filename: str(o, 'filename', 'sd-models'),
          hash: typeof o.hash === 'string' ? o.hash : null,
          sha256: typeof o.sha256 === 'string' ? o.sha256 : null,
        }
      })
    },

    async modules() {
      return (await list('sd-modules')).map((item) => {
        const o = asObj(item, 'sd-modules item')
        return { model_name: str(o, 'model_name', 'sd-modules'), filename: str(o, 'filename', 'sd-modules') }
      })
    },

    async loras() {
      return (await list('loras', lorasTimeoutMs)).map((item) => {
        const o = asObj(item, 'loras item')
        return {
          name: str(o, 'name', 'loras'),
          alias: typeof o.alias === 'string' ? o.alias : str(o, 'name', 'loras'),
          path: str(o, 'path', 'loras'),
          metadata: isObj(o.metadata) ? o.metadata : {},
        }
      })
    },

    async thumb(filename) {
      let res: Response
      try {
        res = await fetch(`${base}/sd_extra_networks/thumb?filename=${encodeURIComponent(filename)}`,
          { signal: AbortSignal.timeout(listTimeoutMs) })
      } catch (e) {
        throw new ForgeError('network', 'Could not reach Forge', { detail: e instanceof Error ? e.message : String(e) })
      }
      if (!res.ok) return null
      const type = res.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) return null
      return { bytes: Buffer.from(await res.arrayBuffer()), type }
    },

    async samplers() {
      return names(await list('samplers'), 'samplers item')
    },

    async schedulers() {
      return (await list('schedulers')).map((item) => {
        const o = asObj(item, 'schedulers item')
        return typeof o.label === 'string' && o.label !== '' ? o.label : str(o, 'name', 'schedulers item')
      })
    },

    async upscalers() {
      return names(await list('upscalers'), 'upscalers item')
    },

    async latentUpscaleModes() {
      return names(await list('latent-upscale-modes'), 'latent-upscale-modes item')
    },

    async options() {
      return asObj(await request('GET', `${API}/options`, { timeoutMs: listTimeoutMs }), 'options')
    },

    async cmdFlags() {
      return asObj(await request('GET', `${API}/cmd-flags`, { timeoutMs: listTimeoutMs }), 'cmd-flags')
    },

    async unloadCheckpoint(timeoutMs = controlTimeoutMs) {
      await request('POST', `${API}/unload-checkpoint`, { timeoutMs })
    },

    async restartServer() {
      try {
        await request('POST', `${API}/server-restart`, { timeoutMs: controlTimeoutMs })
        return 'restarting'
      } catch (err) {
        if (!(err instanceof ForgeError)) throw err
        if (err.kind === 'http' && (err.status === 404 || err.status === 403)) return 'notAllowed'
        if (err.kind === 'http' && err.status === 501) return 'notRestartable'
        // A 2xx body that is not JSON is still an accepted restart.
        if (err.kind === 'invalid' && err.status !== undefined && err.status < 300) return 'restarting'
        // The process exits while answering: the connection drops after the request was sent.
        if (err.kind === 'network' && DROPPED.test(err.detail ?? '')) return 'restarting'
        throw err
      }
    },
  }
}
