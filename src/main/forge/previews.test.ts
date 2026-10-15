import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockForge, type MockForge } from '../../../tools/mock-forge/server'
import { openDb } from '../storage/db'
import { createRepos } from '../storage/repos'
import { createForgeClient } from './client'
import { createPreviewService, previewCandidates } from './previews'

const WITH_PREVIEW = String.raw`C:\forge\models\Stable-diffusion\sd_xl_base.safetensors`
const WITHOUT = String.raw`C:\forge\models\Stable-diffusion\plain.safetensors`

let mock: MockForge
let dir: string

beforeEach(async () => {
  mock = await startMockForge({ stepMs: 10 })
  dir = mkdtempSync(join(tmpdir(), 'fnc-previews-'))
})
afterEach(async () => {
  await mock.close()
  rmSync(dir, { recursive: true, force: true })
})

function make() {
  const db = openDb(':memory:')
  const repos = createRepos(db, () => 1)
  const server = repos.servers.setActiveUrl(mock.url)
  const service = createPreviewService({
    client: () => createForgeClient(mock.url), serverId: () => server.id, cacheDir: () => dir, meta: repos.modelMeta,
  })
  return { service, repos, server }
}

const thumbRequests = () => mock.requests.filter((r) => r.path === '/sd_extra_networks/thumb')

test('candidates follow Forge: png, preview.png, jpg, preview.jpg, jpeg, preview.jpeg, webp, preview.webp', () => {
  expect(previewCandidates(String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.safetensors`)).toEqual([
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.png`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.preview.png`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.jpg`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.preview.jpg`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.jpeg`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.preview.jpeg`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.webp`,
    String.raw`D:\models\Stable-diffusion\sdxl\exampleMix_v10.preview.webp`,
  ])
  expect(previewCandidates('/models/a.b/c.safetensors')[0]).toBe('/models/a.b/c.png')
})

test('the first request tries the candidates, caches the bytes and remembers the file; later ones use the cache', async () => {
  const { service, repos, server } = make()
  const url = service.urlFor('checkpoint', WITH_PREVIEW)
  const res = await service.serve(url)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(50)
  expect(thumbRequests()).toHaveLength(2) // sd_xl_base.png (404), then sd_xl_base.preview.png
  expect(repos.modelMeta.get(server.id, 'checkpoint', WITH_PREVIEW)?.preview).toBe('png')
  expect(readdirSync(join(dir, String(server.id)))).toHaveLength(1)
  expect((await service.serve(url)).status).toBe(200)
  expect(thumbRequests()).toHaveLength(2)
})

test('a model without a preview answers 404 once and is not looked up again', async () => {
  const { service, repos, server } = make()
  const url = service.urlFor('checkpoint', WITHOUT)
  expect((await service.serve(url)).status).toBe(404)
  expect(thumbRequests()).toHaveLength(8)
  expect(repos.modelMeta.get(server.id, 'checkpoint', WITHOUT)?.preview).toBe('')
  expect((await service.serve(url)).status).toBe(404)
  expect(thumbRequests()).toHaveLength(8)
  repos.modelMeta.clearPreviews(server.id)
  await service.serve(url)
  expect(thumbRequests()).toHaveLength(16)
})

test('only registered files can be asked for; unknown keys and malformed URLs are 404 without a request', async () => {
  const { service } = make()
  expect((await service.serve('fnc-model://local/checkpoint/0123456789abcdef0123')).status).toBe(404)
  expect((await service.serve('fnc-model://local/checkpoint/../../etc')).status).toBe(404)
  expect((await service.serve('fnc-model://local/other/0123456789abcdef0123')).status).toBe(404)
  expect(thumbRequests()).toHaveLength(0)
})

test('an unreachable Forge answers 404 and records nothing', async () => {
  const { repos, server } = make()
  const service = createPreviewService({
    client: () => createForgeClient('http://127.0.0.1:1'), serverId: () => server.id, cacheDir: () => dir, meta: repos.modelMeta,
  })
  const url = service.urlFor('lora', WITH_PREVIEW)
  expect((await service.serve(url)).status).toBe(404)
  expect(repos.modelMeta.get(server.id, 'lora', WITH_PREVIEW)?.preview ?? null).toBeNull()
})
