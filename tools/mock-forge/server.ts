import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

export interface MockForge {
  url: string
  requests: { method: string; path: string; query: string; body: unknown }[]
  respond(
    path: string,
    r: { status?: number; json?: unknown; text?: string; delayMs?: number; hang?: boolean },
  ): void
  /**
   * Makes the next generations fail with a Forge-shaped HTTP 500 (as after a failed model load):
   * `count` times, or every time until `unload-checkpoint` or a restart (`'untilUnload'`). 0 stops it.
   */
  failGenerations(mode: number | 'untilUnload'): void
  /** Sets the `api_server_stop` launch flag that `cmd-flags` reports and `server-restart` checks. */
  setApiServerStop(on: boolean): void
  /** Completed restarts and unloads so far. */
  stats(): { restarts: number; unloads: number }
  close(): Promise<void>
}

type Override = Parameters<MockForge['respond']>[1]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A solid-colour RGB PNG, base64-encoded. */
function solidPng(size: number, [r, g, b]: [number, number, number], height = size): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

const CHECKPOINTS = [
  {
    title: 'sdxl\\sd_xl_base.safetensors [31e35c80fc]',
    model_name: 'sd_xl_base',
    hash: '31e35c80fc',
    sha256: null,
    filename: 'C:\\forge\\models\\Stable-diffusion\\sd_xl_base.safetensors',
    config: null,
  },
  {
    title: 'krea2\\krea2_turbo_fp8.safetensors [a1b2c3d4e5]',
    model_name: 'krea2_turbo_fp8',
    hash: 'a1b2c3d4e5',
    sha256: null,
    filename: 'C:\\forge\\models\\Stable-diffusion\\krea2_turbo_fp8.safetensors',
    config: null,
  },
]

/** One fictional sd-models entry; the hash comes from the index so titles stay unique and stable. */
function checkpointEntry(folder: string, name: string, index: number) {
  const hash = (0xa0000000 + index * 0x1f3d5b7).toString(16).padStart(10, '0')
  return {
    title: `${folder}\\${name}.safetensors [${hash}]`,
    model_name: name,
    hash,
    sha256: null,
    filename: `C:\\forge\\models\\Stable-diffusion\\${folder}\\${name}.safetensors`,
    config: null,
  }
}

/**
 * A long list across folders and families in mixed order (fictional names), for checking menu
 * scrolling, grouping and an overlong name in the prompt bar. Opt in with `catalog: 'many'`.
 */
const MANY_CHECKPOINTS = (() => {
  const names: [string, string][] = [
    ['illustrious', 'exampleSemiRealisticMix_v20LittleDetailer'],
    ['anima', 'anima_preview_v3'],
    ['krea', 'krea2_turbo_fp8'],
  ]
  const sdxlStems = ['amberMix', 'birchXL', 'cobaltPony', 'duneIllustrious', 'emberAnime', 'fernReal', 'graniteXL']
  for (const stem of sdxlStems) {
    for (const version of ['v9', 'v10', 'v2']) names.push(['illustrious', `${stem}_${version}`])
    names.push(['pony', `${stem}Pony_v1`])
  }
  for (let i = 1; i <= 8; i++) names.push(['anima', `anima_fineTune_${i}`])
  for (let i = 1; i <= 5; i++) names.push(['zimage', `z_image_turbo_${i}`])
  for (let i = 1; i <= 4; i++) names.push(['qwen', `qwen_image_edit_${i}`])
  for (let i = 1; i <= 3; i++) names.push(['lumina', `lumina2_mix_${i}`])
  for (let i = 1; i <= 4; i++) names.push(['krea', `krea2_dev_${i}`])
  // A stride coprime with the length permutes the list, so families come mixed like a real server's.
  const order = names.map((_, i) => (i * 37) % names.length)
  return order.map((n, i) => {
    const [folder, name] = names[n] as [string, string]
    return checkpointEntry(folder, name, i)
  })
})()

const MODULES = [
  { model_name: 'ae.safetensors', filename: 'C:\\forge\\models\\VAE\\ae.safetensors' },
  { model_name: 'clip_l.safetensors', filename: 'C:\\forge\\models\\text_encoder\\clip_l.safetensors' },
]

const LORAS = [
  {
    name: 'detail_tweaker',
    alias: 'detail_tweaker',
    path: 'C:\\forge\\models\\Lora\\detail_tweaker.safetensors',
    metadata: {
      ss_base_model_version: 'sdxl_base_v1-0',
      ss_tag_frequency: { '10_detail': { 'detailed skin': 40, sharp: 12, '1girl': 90 } },
    },
  },
  {
    name: 'style_anima',
    alias: 'style_anima',
    path: 'C:\\forge\\models\\Lora\\style_anima.safetensors',
    metadata: { ss_base_model_version: 'anima' },
  },
]

const SAMPLERS = [
  { name: 'Euler', aliases: ['k_euler'], options: {} },
  { name: 'Euler a', aliases: ['k_euler_a'], options: {} },
]

const SCHEDULERS = [
  { name: 'automatic', label: 'Automatic' },
  { name: 'simple', label: 'Simple' },
]

const GB = 1024 ** 3

const MEMORY = {
  ram: { free: 20 * GB, used: 12 * GB, total: 32 * GB },
  cuda: {
    system: { free: 8 * GB, used: 16 * GB, total: 24 * GB },
    allocated: { current: 10 * GB, peak: 14 * GB },
    reserved: { current: 12 * GB, peak: 15 * GB },
    events: { retries: 0, oom: 0 },
  },
}

const NOT_FOUND = { detail: 'Not Found' }

/** Sentinel: the route asked for a simulated restart. */
const RESTART = { restart: true }

/** The body Forge's exception handler sends with a 500 (fictional message). */

const FORGE_500 = { error: 'TypeError', detail: '', body: '', errors: "'NoneType' object is not callable" }

export interface MockForgeOptions {
  port?: number
  stepMs?: number
  /** 'many': a long mixed-family checkpoint list (MOCK_CATALOG=many from the command line). */
  catalog?: 'default' | 'many'
  /** Whether Forge was started with --api-server-stop (API_SERVER_STOP=1). Default false. */
  apiServerStop?: boolean
  /** How long a simulated restart refuses connections (RESTART_MS). Default 1500. */
  restartMs?: number
  /** Initial generation failures (FAIL_500=<n>|until-unload). */
  failGenerations?: number | 'untilUnload'
}

export function startMockForge(opts: MockForgeOptions = {}): Promise<MockForge> {
  const stepMs = opts.stepMs ?? 50
  const checkpoints = opts.catalog === 'many' ? MANY_CHECKPOINTS : CHECKPOINTS
  const requests: MockForge['requests'] = []
  const overrides = new Map<string, Override>()
  const sockets = new Set<Socket>()
  const life = new AbortController()
  let apiServerStop = opts.apiServerStop ?? false
  const restartMs = opts.restartMs ?? 1500
  let failing: number | 'untilUnload' = opts.failGenerations ?? 0
  let restarts = 0
  let unloads = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let port = opts.port ?? 0

  interface Generation {
    step: number
    steps: number
    jobNo: number
    jobCount: number
    interrupted: boolean
    wake: AbortController
  }
  let current: Generation | null = null
  let queue: Promise<unknown> = Promise.resolve()

  /** Resolves after ms, or earlier when the signal aborts. */
  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done)
    })
  }

  async function runGeneration(body: unknown): Promise<{ images: string[]; info: string }> {
    const params = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const steps = Math.max(1, Math.floor(Number(params.steps ?? 20)))
    const seed = Number(params.seed ?? -1) >= 0 ? Number(params.seed) : 123456789
    const scale = params.enable_hr === true && typeof params.hr_scale === 'number' ? params.hr_scale : 1
    const secondPassSteps = scale > 1 ? Math.max(1, Math.floor(Number(params.hr_second_pass_steps ?? 12))) : 0
    const gen: Generation = { step: 0, steps, jobNo: 0, jobCount: secondPassSteps > 0 ? 2 : 1, interrupted: false, wake: new AbortController() }
    current = gen
    const stop = AbortSignal.any([gen.wake.signal, life.signal])
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs, stop)
      if (gen.interrupted || life.signal.aborted) break
      gen.step = i
    }
    if (secondPassSteps > 0 && !gen.interrupted && !life.signal.aborted) {
      gen.jobNo = 1
      gen.step = 0
      gen.steps = secondPassSteps
      for (let i = 1; i <= secondPassSteps; i++) {
        await sleep(stepMs, stop)
        if (gen.interrupted || life.signal.aborted) break
        gen.step = i
      }
    }
    current = null
    const prompt = String(params.prompt ?? '')
    const info = JSON.stringify({
      prompt,
      seed,
      all_seeds: [seed],
      steps,
      infotexts: [`${prompt}\nSteps: ${steps}, Seed: ${seed}`],
    })
    const source = typeof params.image === 'string' ? Buffer.from(params.image, 'base64') : null
    const upscale = source && source.length >= 24 && typeof params.upscaling_resize === 'number'
      ? params.upscaling_resize : null
    const width = upscale !== null ? Math.max(1, Math.min(4096, Math.round(source!.readUInt32BE(16) * upscale)))
      : (scale > 1 || Array.isArray(params.init_images)) && typeof params.width === 'number'
      ? Math.max(1, Math.min(4096, Math.round(params.width * scale))) : 64
    const height = upscale !== null ? Math.max(1, Math.min(4096, Math.round(source!.readUInt32BE(20) * upscale)))
      : (scale > 1 || Array.isArray(params.init_images)) && typeof params.height === 'number'
      ? Math.max(1, Math.min(4096, Math.round(params.height * scale))) : 64
    return { images: [solidPng(width, [90, 140, 200], height)], info }
  }

  function enqueue(body: unknown): Promise<{ images: string[]; info: string }> {
    const run = queue.then(() => runGeneration(body))
    queue = run.catch(() => undefined)
    return run
  }

  function progress(skipImage: boolean): unknown {
    const gen = current
    if (!gen) {
      return {
        progress: 0,
        eta_relative: 0,
        state: { sampling_step: 0, sampling_steps: 0, job_no: 0, job_count: 0 },
        current_image: null,
      }
    }
    return {
      progress: gen.step / gen.steps,
      eta_relative: ((gen.steps - gen.step) * stepMs) / 1000,
      state: { sampling_step: gen.step, sampling_steps: gen.steps, job_no: gen.jobNo, job_count: gen.jobCount },
      current_image: skipImage ? null : solidPng(8, [40 + ((gen.step * 7) % 200), 120, 160]),
    }
  }

  async function route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const ok = (json: unknown): { status: number; json: unknown } => ({ status: 200, json })
    if (method === 'GET') {
      switch (path) {
        case '/sdapi/v1/sd-models': return ok(checkpoints)
        case '/sdapi/v1/sd-modules': return ok(MODULES)
        case '/sdapi/v1/loras': return ok(LORAS)
        case '/sdapi/v1/samplers': return ok(SAMPLERS)
        case '/sdapi/v1/schedulers': return ok(SCHEDULERS)
        case '/sdapi/v1/upscalers': return ok([{ name: 'None' }, { name: 'R-ESRGAN 4x+' }])
        case '/sdapi/v1/latent-upscale-modes': return ok([{ name: 'Latent' }, { name: 'Latent (nearest)' }])
        case '/sdapi/v1/options':
          return ok({
            sd_model_checkpoint: checkpoints[0]?.title,
            forge_additional_modules: [],
            forge_additional_modules_xl: [],
            forge_additional_modules_krea: MODULES.map((x) => x.filename),
            krea_show_shift: false,
            zit_show_shift: true,
            CLIP_stop_at_last_layers: 1,
          })
        case '/sdapi/v1/cmd-flags': return ok({ api: true, api_server_stop: apiServerStop })
        case '/sdapi/v1/memory': return ok(MEMORY)
        case '/sdapi/v1/progress': return ok(progress(query.get('skip_current_image') === 'true'))
      }
    } else if (method === 'POST') {
      if (path === '/sdapi/v1/txt2img' || path === '/sdapi/v1/img2img') {
        if (failing === 'untilUnload' || failing > 0) {
          if (failing !== 'untilUnload') failing--
          return { status: 500, json: FORGE_500 }
        }
        return ok(await enqueue(body))
      }
      if (path === '/sdapi/v1/extra-single-image') {
        const result = await enqueue(body)
        return ok({ image: result.images[0], html_info: '' })
      }
      if (path === '/sdapi/v1/unload-checkpoint') {
        if (failing === 'untilUnload') failing = 0
        unloads++
        return ok({})
      }
      if (path === '/sdapi/v1/server-restart') {
        // Real Forge registers the route only with --api-server-stop.
        return apiServerStop ? { status: 200, json: RESTART } : { status: 404, json: NOT_FOUND }
      }
      if (path === '/sdapi/v1/interrupt') {
        if (current) {
          current.interrupted = true
          current.wake.abort()
        }
        return ok({})
      }
    }
    return { status: 404, json: NOT_FOUND }
  }

  function send(res: ServerResponse, status: number, contentType: string, payload: string): void {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': contentType })
    res.end(payload)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const url = new URL(req.url ?? '/', 'http://mock')
    const method = req.method ?? 'GET'
    requests.push({ method, path: url.pathname, query: url.search.slice(1), body })

    // Forge's thumb route: a preview file next to a model. Here only two models have one.
    if (url.pathname === '/sd_extra_networks/thumb') {
      const file = url.searchParams.get('filename') ?? ''
      if (/(sd_xl_base\.preview|detail_tweaker)\.png$/.test(file)) {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from(solidPng(64, [90, 140, 200], 85), 'base64'))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"Not Found"}')
      }
      return
    }

    const override = overrides.get(url.pathname)
    if (override) {
      if (override.hang) return
      if (override.delayMs) await sleep(override.delayMs, life.signal)
      const status = override.status ?? 200
      if (override.text !== undefined) return send(res, status, 'text/html; charset=utf-8', override.text)
      return send(res, status, 'application/json', JSON.stringify(override.json ?? {}))
    }
    const out = await route(method, url.pathname, url.searchParams, body)
    if (out.json === RESTART) {
      // The process exits while answering: the client sees the connection drop.
      req.socket.destroy()
      simulateRestart()
      return
    }
    send(res, out.status, 'application/json', JSON.stringify(out.json))
  }

  /** Drops every connection, refuses new ones for restartMs, then listens again with a fresh model state. */
  function simulateRestart(): void {
    if (current) {
      current.interrupted = true
      current.wake.abort()
    }
    failing = 0
    server.close()
    for (const socket of sockets) socket.destroy()
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (life.signal.aborted) return
      server.listen(port, '127.0.0.1', () => { restarts++ })
    }, restartMs)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.destroyed) res.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no address'))
      port = address.port
      server.off('error', reject)
      server.on('error', (err) => console.error('mock-forge:', err))
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        respond(path, r) {
          overrides.set(path, r)
        },
        failGenerations(mode) {
          failing = mode
        },
        setApiServerStop(on) {
          apiServerStop = on
        },
        stats: () => ({ restarts, unloads }),
        close() {
          life.abort()
          if (restartTimer) clearTimeout(restartTimer)
          return new Promise<void>((done) => {
            if (!server.listening) return done()
            server.close(() => done())
            for (const socket of sockets) socket.destroy()
          })
        },
      })
    })
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = Number(process.env.PORT ?? 7861)
  const stepMs = process.env.STEP_MS === undefined ? undefined : Number(process.env.STEP_MS)
  startMockForge({
    port,
    ...(stepMs !== undefined ? { stepMs } : {}),
    catalog: process.env.MOCK_CATALOG === 'many' ? 'many' : 'default',
    apiServerStop: process.env.API_SERVER_STOP === '1',
    ...(process.env.RESTART_MS !== undefined ? { restartMs: Number(process.env.RESTART_MS) } : {}),
    ...(process.env.FAIL_500 !== undefined
      ? { failGenerations: process.env.FAIL_500 === 'until-unload' ? ('untilUnload' as const) : Number(process.env.FAIL_500) }
      : {}),
  })
    .then((mock) => {
      console.log(`Mock Forge listening on ${mock.url}`)
      const stop = (): void => {
        void mock.close().then(() => process.exit(0))
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
