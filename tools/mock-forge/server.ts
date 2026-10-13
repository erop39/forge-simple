import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

export interface MockForge {
  url: string
  requests: { method: string; path: string; body: unknown }[]
  respond(
    path: string,
    r: { status?: number; json?: unknown; text?: string; delayMs?: number; hang?: boolean },
  ): void
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
function solidPng(size: number, [r, g, b]: [number, number, number]): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
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
    title: 'sd_xl_base.safetensors [31e35c80fc]',
    model_name: 'sd_xl_base',
    hash: '31e35c80fc',
    sha256: null,
    filename: 'C:\\forge\\models\\Stable-diffusion\\sd_xl_base.safetensors',
    config: null,
  },
  {
    title: 'krea2_turbo_fp8.safetensors [a1b2c3d4e5]',
    model_name: 'krea2_turbo_fp8',
    hash: 'a1b2c3d4e5',
    sha256: null,
    filename: 'C:\\forge\\models\\Stable-diffusion\\krea2_turbo_fp8.safetensors',
    config: null,
  },
]

const MODULES = [
  { model_name: 'ae.safetensors', filename: 'C:\\forge\\models\\VAE\\ae.safetensors' },
  { model_name: 'clip_l.safetensors', filename: 'C:\\forge\\models\\text_encoder\\clip_l.safetensors' },
]

const LORAS = [
  {
    name: 'detail_tweaker',
    alias: 'detail_tweaker',
    path: 'C:\\forge\\models\\Lora\\detail_tweaker.safetensors',
    metadata: {},
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

export function startMockForge(opts: { port?: number; stepMs?: number } = {}): Promise<MockForge> {
  const stepMs = opts.stepMs ?? 50
  const requests: MockForge['requests'] = []
  const overrides = new Map<string, Override>()
  const sockets = new Set<Socket>()
  const life = new AbortController()

  interface Generation {
    step: number
    steps: number
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
    const gen: Generation = { step: 0, steps, interrupted: false, wake: new AbortController() }
    current = gen
    const stop = AbortSignal.any([gen.wake.signal, life.signal])
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs, stop)
      if (gen.interrupted || life.signal.aborted) break
      gen.step = i
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
    return { images: [solidPng(64, [90, 140, 200])], info }
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
      state: { sampling_step: gen.step, sampling_steps: gen.steps, job_no: 0, job_count: 1 },
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
        case '/sdapi/v1/sd-models': return ok(CHECKPOINTS)
        case '/sdapi/v1/sd-modules': return ok(MODULES)
        case '/sdapi/v1/loras': return ok(LORAS)
        case '/sdapi/v1/samplers': return ok(SAMPLERS)
        case '/sdapi/v1/schedulers': return ok(SCHEDULERS)
        case '/sdapi/v1/upscalers': return ok([{ name: 'Latent' }, { name: 'R-ESRGAN 4x+' }])
        case '/sdapi/v1/options':
          return ok({
            sd_model_checkpoint: CHECKPOINTS[0]?.title,
            forge_additional_modules: [],
            CLIP_stop_at_last_layers: 1,
          })
        case '/sdapi/v1/cmd-flags': return ok({ api: true, api_server_stop: false })
        case '/sdapi/v1/memory': return ok(MEMORY)
        case '/sdapi/v1/progress': return ok(progress(query.get('skip_current_image') === 'true'))
      }
    } else if (method === 'POST') {
      if (path === '/sdapi/v1/txt2img') return ok(await enqueue(body))
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
    requests.push({ method, path: url.pathname, body })

    const override = overrides.get(url.pathname)
    if (override) {
      if (override.hang) return
      if (override.delayMs) await sleep(override.delayMs, life.signal)
      const status = override.status ?? 200
      if (override.text !== undefined) return send(res, status, 'text/html; charset=utf-8', override.text)
      return send(res, status, 'application/json', JSON.stringify(override.json ?? {}))
    }
    const out = await route(method, url.pathname, url.searchParams, body)
    send(res, out.status, 'application/json', JSON.stringify(out.json))
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
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        respond(path, r) {
          overrides.set(path, r)
        },
        close() {
          life.abort()
          return new Promise<void>((done) => {
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
  startMockForge({ port })
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
