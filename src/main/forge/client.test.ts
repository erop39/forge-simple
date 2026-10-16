import { createServer } from 'node:http'
import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'
import {
  DEFAULT_LIST_TIMEOUT_MS,
  DEFAULT_LORAS_TIMEOUT_MS,
  DEFAULT_PING_TIMEOUT_MS,
  ForgeError,
  createForgeClient,
  normalizeBaseUrl,
  type Txt2ImgBody,
} from './client'

let mock: MockForge

beforeEach(async () => {
  mock = await startMockForge({ stepMs: 10 })
})

afterEach(async () => {
  await mock.close()
})

const body: Txt2ImgBody = {
  prompt: 'a cat',
  negative_prompt: '',
  steps: 4,
  cfg_scale: 1,
  distilled_cfg_scale: 3.5,
  sampler_name: 'Euler',
  scheduler: 'Simple',
  width: 512,
  height: 512,
  seed: 7,
  batch_size: 1,
  n_iter: 1,
  send_images: true,
  save_images: false,
  override_settings: { sd_model_checkpoint: 'sd_xl_base.safetensors' },
  override_settings_restore_afterwards: false,
}

async function expectForgeError(promise: Promise<unknown>, expected: Partial<ForgeError>): Promise<ForgeError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the call to reject')
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ForgeError)
  expect(err).toMatchObject(expected)
  return err as ForgeError
}

async function closedPortUrl(): Promise<string> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

describe('normalizeBaseUrl', () => {
  test.each([
    ['100.1.2.3:7860', 'http://100.1.2.3:7860'],
    ['http://host:7860/', 'http://host:7860'],
    ['https://host/forge/', 'https://host/forge'],
    ['  http://host:7860  ', 'http://host:7860'],
    ['host:7860///', 'http://host:7860'],
    ['localhost', 'http://localhost'],
  ])('normalizeBaseUrl(%s) → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected)
  })

  test.each([[''], ['   '], ['http://'], ['ftp://host'], ['http://exa mple.com']])(
    'rejects %j as invalid',
    (input) => {
      expect(() => normalizeBaseUrl(input)).toThrow(ForgeError)
      try {
        normalizeBaseUrl(input)
      } catch (e) {
        expect((e as ForgeError).kind).toBe('invalid')
      }
    },
  )
})

describe('defaults', () => {
  test('timeouts default to 10 s for lists and 5 s for ping', () => {
    expect(DEFAULT_LIST_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_PING_TIMEOUT_MS).toBe(5_000)
    expect(DEFAULT_LORAS_TIMEOUT_MS).toBe(180_000)
  })
})

describe('list calls', () => {
  test('models() maps the list', async () => {
    const models = await createForgeClient(mock.url).models()
    expect(models.map((m) => m.model_name)).toEqual(['sd_xl_base', 'krea2_turbo_fp8'])
    expect(models[0]).toMatchObject({ title: expect.stringContaining('sd_xl_base.safetensors'), hash: '31e35c80fc' })
    expect(typeof models[0]?.filename).toBe('string')
  })

  test('models() keeps a null hash', async () => {
    mock.respond('/sdapi/v1/sd-models', { json: [{ title: 't', model_name: 'm', filename: 'f', hash: null }] })
    expect(await createForgeClient(mock.url).models()).toEqual([
      { title: 't', model_name: 'm', filename: 'f', hash: null, sha256: null },
    ])
  })

  test('modules() and loras() map their lists', async () => {
    const client = createForgeClient(mock.url)
    expect((await client.modules()).map((m) => m.model_name)).toEqual(['ae.safetensors', 'clip_l.safetensors'])
    expect((await client.loras()).map((l) => l.name)).toEqual(['detail_tweaker', 'style_anima'])
    expect((await client.loras())[1]!.metadata).toEqual({ ss_base_model_version: 'anima' })
  })

  test('samplers() returns plain names', async () => {
    expect(await createForgeClient(mock.url).samplers()).toEqual(['Euler', 'Euler a'])
  })

  test('schedulers() returns labels and upscalers() plain names', async () => {
    const client = createForgeClient(mock.url)
    expect(await client.schedulers()).toEqual(['Automatic', 'Simple'])
    expect(await client.upscalers()).toEqual(['None', 'R-ESRGAN 4x+'])
    expect(await client.latentUpscaleModes()).toEqual(['Latent', 'Latent (nearest)'])
  })

  test('schedulers() falls back to the name when the label is missing', async () => {
    mock.respond('/sdapi/v1/schedulers', { json: [{ name: 'karras' }, { name: 'beta', label: '' }] })
    expect(await createForgeClient(mock.url).schedulers()).toEqual(['karras', 'beta'])
  })

  test('options() returns the options object', async () => {
    const options = await createForgeClient(mock.url).options()
    expect(options).toMatchObject({ forge_additional_modules: [], CLIP_stop_at_last_layers: 1 })
  })

  test('progress() returns the idle state', async () => {
    expect(await createForgeClient(mock.url).progress()).toMatchObject({
      progress: 0,
      current_image: null,
      state: { sampling_step: 0, sampling_steps: 0 },
    })
  })

  test('a base URL with a sub-path is joined with the endpoint path', async () => {
    mock.respond('/forge/sdapi/v1/samplers', { json: [{ name: 'DPM++' }] })
    const client = createForgeClient(`${mock.url}/forge/`)
    expect(await client.samplers()).toEqual(['DPM++'])
    expect(mock.requests.at(-1)?.path).toBe('/forge/sdapi/v1/samplers')
  })

  test('a scheme-less address is accepted', async () => {
    const client = createForgeClient(mock.url.replace('http://', ''))
    expect((await client.samplers()).length).toBe(2)
  })
})

describe('errors', () => {
  test.each([
    ['error', { error: 'OutOfMemoryError', errors: 'CUDA out of memory' }, 'OutOfMemoryError: CUDA out of memory'],
    // Forge's own exception handler shape: the class name in `error`, its message in `errors`.
    ['error (Forge shape)', { error: 'TypeError', detail: '', body: '', errors: "'NoneType' object is not callable" },
      "TypeError: 'NoneType' object is not callable"],
    ['error without message', { error: 'TypeError', detail: '', body: '', errors: '' }, 'TypeError'],
    ['detail', { detail: 'Not allowed' }, 'Not allowed'],
    ['message', { message: 'boom' }, 'boom'],
  ])('HTTP 500 with a JSON %s becomes ForgeError http with detail', async (_field, json, detail) => {
    mock.respond('/sdapi/v1/sd-models', { status: 500, json })
    await expectForgeError(createForgeClient(mock.url).models(), { kind: 'http', status: 500, detail })
  })

  test('HTTP error with a plain text body uses its first 200 characters as detail', async () => {
    mock.respond('/sdapi/v1/sd-models', { status: 502, text: 'x'.repeat(500) })
    const err = await expectForgeError(createForgeClient(mock.url).models(), { kind: 'http', status: 502 })
    expect(err.detail).toBe('x'.repeat(200))
  })

  test('an unknown path becomes ForgeError http 404 with the server detail', async () => {
    mock.respond('/sdapi/v1/samplers', { status: 404, json: { detail: 'Not Found' } })
    await expectForgeError(createForgeClient(mock.url).samplers(), { kind: 'http', status: 404, detail: 'Not Found' })
  })

  test('an HTML body becomes ForgeError invalid', async () => {
    mock.respond('/sdapi/v1/sd-models', { text: '<html><body>Welcome to nginx</body></html>' })
    await expectForgeError(createForgeClient(mock.url).models(), { kind: 'invalid' })
  })

  test('JSON of the wrong top-level shape becomes ForgeError invalid', async () => {
    mock.respond('/sdapi/v1/sd-models', { json: { detail: 'surprise' } })
    mock.respond('/sdapi/v1/options', { json: [] })
    mock.respond('/sdapi/v1/progress', { json: [] })
    mock.respond('/sdapi/v1/txt2img', { json: { images: 'nope' } })
    const client = createForgeClient(mock.url)
    await expectForgeError(client.models(), { kind: 'invalid' })
    await expectForgeError(client.options(), { kind: 'invalid' })
    await expectForgeError(client.progress(), { kind: 'invalid' })
    await expectForgeError(client.txt2img(body), { kind: 'invalid' })
  })

  test('a refused connection becomes ForgeError network', async () => {
    const client = createForgeClient(await closedPortUrl())
    await expectForgeError(client.models(), { kind: 'network' })
    await expectForgeError(client.ping(), { kind: 'network' })
  })
})

describe('timeouts', () => {
  test('list calls time out (10 s by default; injectable here)', async () => {
    mock.respond('/sdapi/v1/sd-models', { hang: true })
    const client = createForgeClient(mock.url, { listTimeoutMs: 50 })
    await expectForgeError(client.models(), { kind: 'timeout' })
  })

  test('loras() uses its own, longer timeout', async () => {
    mock.respond('/sdapi/v1/loras', { hang: true })
    const client = createForgeClient(mock.url, { listTimeoutMs: 5_000, lorasTimeoutMs: 50 })
    await expectForgeError(client.loras(), { kind: 'timeout' })
  })

  test('ping times out (5 s by default; injectable here)', async () => {
    mock.respond('/sdapi/v1/progress', { hang: true })
    const client = createForgeClient(mock.url, { pingTimeoutMs: 50 })
    await expectForgeError(client.ping(), { kind: 'timeout' })
  })

test('ping rejects a 200 JSON object that is not a Forge progress', async () => {
    mock.respond('/sdapi/v1/progress', { json: {} })
    await expectForgeError(createForgeClient(mock.url).ping(), { kind: 'invalid' })
  })

  test('ping resolves with a latency in ms and skips the preview image', async () => {
    const ms = await createForgeClient(mock.url).ping()
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(mock.requests.at(-1)).toMatchObject({ path: '/sdapi/v1/progress', query: 'skip_current_image=true' })
  })
})

describe('generation', () => {
  test('txt2img has no timeout but aborts on signal', async () => {
    const slow = await startMockForge({ stepMs: 100 })
    try {
      const client = createForgeClient(slow.url, { listTimeoutMs: 20, pingTimeoutMs: 20 })
      const long = client.txt2img({ ...body, steps: 3 })
      await expect(long).resolves.toMatchObject({ images: [expect.any(String)] })

      const controller = new AbortController()
      const pending = client.txt2img({ ...body, steps: 50 }, controller.signal)
      setTimeout(() => controller.abort(), 30)
      await expectForgeError(pending, { kind: 'network', detail: 'aborted' })
    } finally {
      await slow.close()
    }
  })

  test('txt2img rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expectForgeError(createForgeClient(mock.url).txt2img(body, controller.signal), {
      kind: 'network',
      detail: 'aborted',
    })
  })

  test('txt2img posts the body unchanged', async () => {
    const result = await createForgeClient(mock.url).txt2img(body)
    expect(mock.requests.at(-1)).toMatchObject({ method: 'POST', path: '/sdapi/v1/txt2img' })
    expect(mock.requests.at(-1)?.body).toEqual(body)
    expect(result.images).toHaveLength(1)
    expect(JSON.parse(result.info)).toMatchObject({ all_seeds: [7] })
  })

  test('interrupt() ends a running txt2img early with a partial image', async () => {
    const slow = await startMockForge({ stepMs: 200 })
    try {
      const client = createForgeClient(slow.url)
      const started = Date.now()
      const running = client.txt2img({ ...body, steps: 100 })
      await new Promise((r) => setTimeout(r, 50))
      await client.interrupt()
      const result = await running
      expect(result.images).toHaveLength(1)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await slow.close()
    }
  })
})

test('img2img posts source bytes and resize settings to its endpoint', async () => {
  const imgBody = { ...body, init_images: ['cG5n'], denoising_strength: 0.6, resize_mode: 1 as const }
  const result = await createForgeClient(mock.url).img2img(imgBody)
  expect(result.images).toHaveLength(1)
  expect(mock.requests.at(-1)).toMatchObject({ method: 'POST', path: '/sdapi/v1/img2img', body: imgBody })
})

test('upscale maps the single-image extras response and rejects malformed replies', async () => {
  const request = { image: 'cG5n', upscaling_resize: 2 as const, upscaler_1: 'R-ESRGAN 4x+',
    resize_mode: 0 as const, show_extras_results: true as const }
  const client = createForgeClient(mock.url)
  expect(await client.upscale(request)).toMatchObject({ images: [expect.any(String)], info: '' })
  expect(mock.requests.at(-1)).toMatchObject({ method: 'POST', path: '/sdapi/v1/extra-single-image', body: request })
  mock.respond('/sdapi/v1/extra-single-image', { json: { images: ['wrong'] } })
  await expectForgeError(client.upscale(request), { kind: 'invalid' })
})

describe('server control', () => {
  test('memory() reads the read-only endpoint and keeps absent CUDA fields null', async () => {
    const client = createForgeClient(mock.url)
    expect(await client.memory()).toMatchObject({
      ramTotal: 32 * 1024 ** 3, vramUsed: 16 * 1024 ** 3, vramTotal: 24 * 1024 ** 3, oom: 0,
    })
    expect(mock.requests.at(-1)).toMatchObject({ method: 'GET', path: '/sdapi/v1/memory' })
    mock.respond('/sdapi/v1/memory', { json: { ram: { used: 123 } } })
    expect(await client.memory()).toMatchObject({ ramUsed: 123, vramUsed: null, oom: null })
  })

  test('stats() treats a missing optional extension as absent and reads it when offered', async () => {
    const client = createForgeClient(mock.url)
    expect(await client.stats()).toBeNull()
    mock.respond('/forge-neo-client/v1/stats', { json: { version: '1', cpu: { percent: 25 }, gpu: { utilization: null } } })
    expect(await client.stats()).toMatchObject({ version: '1', cpuPercent: 25, gpuUtilization: null })
    expect(mock.requests.at(-1)).toMatchObject({ method: 'GET', path: '/forge-neo-client/v1/stats' })
  })

  test('cmdFlags() reads the launch flags', async () => {
    expect(await createForgeClient(mock.url).cmdFlags()).toMatchObject({ api_server_stop: false })
    mock.setApiServerStop(true)
    expect(await createForgeClient(mock.url).cmdFlags()).toMatchObject({ api_server_stop: true })
  })

  test('unloadCheckpoint() posts to unload-checkpoint; an HTTP error is a ForgeError', async () => {
    await createForgeClient(mock.url).unloadCheckpoint()
    expect(mock.requests.at(-1)).toMatchObject({ method: 'POST', path: '/sdapi/v1/unload-checkpoint' })
    expect(mock.stats().unloads).toBe(1)
    mock.respond('/sdapi/v1/unload-checkpoint', { hang: true })
    await expectForgeError(createForgeClient(mock.url).unloadCheckpoint(50), { kind: 'timeout' })
    mock.respond('/sdapi/v1/unload-checkpoint', { status: 500, json: { detail: 'nope' } })
    await expectForgeError(createForgeClient(mock.url).unloadCheckpoint(), { kind: 'http', status: 500 })
  })

  test('restartServer(): a dropped connection after sending means restarting', async () => {
    const restarting = await startMockForge({ apiServerStop: true, restartMs: 100 })
    try {
      expect(await createForgeClient(restarting.url).restartServer()).toBe('restarting')
      await vi.waitFor(() => expect(restarting.stats().restarts).toBe(1))
      expect(await createForgeClient(restarting.url).ping()).toBeGreaterThanOrEqual(0)
    } finally {
      await restarting.close()
    }
  })

  test('restartServer(): a 200 answer means restarting', async () => {
    mock.respond('/sdapi/v1/server-restart', { json: {} })
    expect(await createForgeClient(mock.url).restartServer()).toBe('restarting')
  })

  test('restartServer(): 404 and 403 mean the flag is missing, 501 a launcher that cannot restart', async () => {
    expect(await createForgeClient(mock.url).restartServer()).toBe('notAllowed')
    mock.respond('/sdapi/v1/server-restart', { status: 403, json: { detail: 'Server stop not enabled' } })
    expect(await createForgeClient(mock.url).restartServer()).toBe('notAllowed')
    mock.respond('/sdapi/v1/server-restart', { status: 501, text: '' })
    expect(await createForgeClient(mock.url).restartServer()).toBe('notRestartable')
  })

  test('restartServer(): a refused connection or another HTTP error rejects', async () => {
    await expectForgeError(createForgeClient(await closedPortUrl()).restartServer(), { kind: 'network' })
    mock.respond('/sdapi/v1/server-restart', { status: 500, json: { detail: 'boom' } })
    await expectForgeError(createForgeClient(mock.url).restartServer(), { kind: 'http', status: 500 })
  })
})
