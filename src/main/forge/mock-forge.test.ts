import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'

let mock: MockForge

afterEach(async () => {
  await mock.close()
})

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${mock.url}${path}`)
  return res.json()
}

const post = (path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${mock.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('unknown paths answer 404 with a JSON detail', async () => {
  mock = await startMockForge()
  const res = await fetch(`${mock.url}/nope`)
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ detail: 'Not Found' })
})

test('serves memory and cmd-flags', async () => {
  mock = await startMockForge()
  expect((await getJson('/sdapi/v1/memory')).cuda.events).toEqual({ retries: 0, oom: 0 })
  expect(await getJson('/sdapi/v1/cmd-flags')).toMatchObject({ api_server_stop: false })
})

test('progress is idle when nothing runs', async () => {
  mock = await startMockForge()
  expect(await getJson('/sdapi/v1/progress')).toEqual({
    progress: 0,
    eta_relative: 0,
    state: { sampling_step: 0, sampling_steps: 0, job_no: 0, job_count: 0 },
    current_image: null,
  })
})

test('progress grows during generation and carries a preview unless skipped', async () => {
  mock = await startMockForge({ stepMs: 40 })
  const running = post('/sdapi/v1/txt2img', { steps: 10 })
  await new Promise((r) => setTimeout(r, 120))
  const first = await getJson('/sdapi/v1/progress')
  await new Promise((r) => setTimeout(r, 120))
  const second = await getJson('/sdapi/v1/progress')
  expect(first.state.sampling_steps).toBe(10)
  expect(second.state.sampling_step).toBeGreaterThan(first.state.sampling_step)
  expect(typeof second.current_image).toBe('string')
  expect((await getJson('/sdapi/v1/progress?skip_current_image=true')).current_image).toBeNull()
  await post('/sdapi/v1/interrupt')
  expect((await running).status).toBe(200)
})

test('the result is a valid 64x64 PNG', async () => {
  mock = await startMockForge({ stepMs: 1 })
  const res = await post('/sdapi/v1/txt2img', { steps: 2 })
  const { images } = (await res.json()) as { images: string[] }
  const png = Buffer.from(images[0] ?? '', 'base64')
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(png.readUInt32BE(16)).toBe(64)
  expect(png.readUInt32BE(20)).toBe(64)
})

test('a second txt2img waits for the first', async () => {
  mock = await startMockForge({ stepMs: 40 })
  const t0 = Date.now()
  const a = post('/sdapi/v1/txt2img', { steps: 5 }).then(() => Date.now() - t0)
  await new Promise((r) => setTimeout(r, 20))
  const b = post('/sdapi/v1/txt2img', { steps: 5 }).then(() => Date.now() - t0)
  const [doneA, doneB] = await Promise.all([a, b])
  expect(doneB).toBeGreaterThanOrEqual(doneA + 150)
})

test('respond() overrides the answer and the request is still recorded', async () => {
  mock = await startMockForge()
  mock.respond('/sdapi/v1/samplers', { status: 503, json: { detail: 'busy' } })
  const res = await fetch(`${mock.url}/sdapi/v1/samplers`)
  expect(res.status).toBe(503)
  expect(mock.requests).toEqual([{ method: 'GET', path: '/sdapi/v1/samplers', query: '', body: undefined }])
})

test('close() terminates a hanging request', async () => {
  mock = await startMockForge()
  mock.respond('/sdapi/v1/sd-models', { hang: true })
  const pending = fetch(`${mock.url}/sdapi/v1/sd-models`).then(
    () => 'responded',
    () => 'dropped',
  )
  await new Promise((r) => setTimeout(r, 50))
  await mock.close()
  expect(await pending).toBe('dropped')
})

test('the default catalog has two checkpoints; catalog many serves a long mixed list', async () => {
  mock = await startMockForge()
  expect(await getJson('/sdapi/v1/sd-models')).toHaveLength(2)
  await mock.close()
  mock = await startMockForge({ catalog: 'many' })
  const many: { title: string }[] = await getJson('/sdapi/v1/sd-models')
  expect(many.length).toBeGreaterThanOrEqual(50)
  expect(new Set(many.map((c) => c.title)).size).toBe(many.length)
  expect(many.some((c) => c.title.includes('exampleSemiRealisticMix_v20LittleDetailer'))).toBe(true)
  expect((await getJson('/sdapi/v1/options')).sd_model_checkpoint).toBe(many[0]?.title)
})

test('failGenerations(n) answers txt2img with Forge-shaped 500s n times', async () => {
  mock = await startMockForge({ stepMs: 1 })
  mock.failGenerations(2)
  for (let i = 0; i < 2; i++) {
    const res = await post('/sdapi/v1/txt2img', { steps: 1 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'TypeError', detail: '', body: '', errors: expect.any(String) })
  }
  expect((await post('/sdapi/v1/txt2img', { steps: 1 })).status).toBe(200)
})

test("failGenerations('untilUnload') fails until unload-checkpoint", async () => {
  mock = await startMockForge({ stepMs: 1, failGenerations: 'untilUnload' })
  expect((await post('/sdapi/v1/txt2img', { steps: 1 })).status).toBe(500)
  expect((await post('/sdapi/v1/txt2img', { steps: 1 })).status).toBe(500)
  expect((await post('/sdapi/v1/unload-checkpoint')).status).toBe(200)
  expect((await post('/sdapi/v1/txt2img', { steps: 1 })).status).toBe(200)
  expect(mock.stats().unloads).toBe(1)
})

test('server-restart is 404 without the flag; with it the mock drops connections, refuses, then comes back healed', async () => {
  mock = await startMockForge({ stepMs: 1, restartMs: 150 })
  expect((await post('/sdapi/v1/server-restart')).status).toBe(404)
  mock.setApiServerStop(true)
  expect(await getJson('/sdapi/v1/cmd-flags')).toMatchObject({ api_server_stop: true })
  mock.failGenerations(5)
  const dropped = await post('/sdapi/v1/server-restart').then(() => 'answered', () => 'dropped')
  expect(dropped).toBe('dropped')
  const refused = await fetch(`${mock.url}/sdapi/v1/progress`).then(() => 'answered', () => 'refused')
  expect(refused).toBe('refused')
  await vi.waitFor(() => expect(mock.stats().restarts).toBe(1))
  expect((await post('/sdapi/v1/txt2img', { steps: 1 })).status).toBe(200)
})
