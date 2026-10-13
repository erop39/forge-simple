import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerationParams, JobError } from '@shared/types'
import { openDb } from './db'
import { createRepos } from './repos'

const params = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  family: 'sdxl', checkpoint: 'model.safetensors [abc]', modules: [], prompt: 'p', negativePrompt: 'n',
  width: 1024, height: 1024, steps: 20, cfgScale: 7, distilledCfg: 3.5, shift: null, clipSkip: null,
  sampler: 'Euler', scheduler: 'Simple', seed: -1, count: 1, loras: [], ...over,
})

const setup = (t = 1000) => {
  const db = openDb(':memory:')
  let time = t
  const repos = createRepos(db, () => time)
  return { db, repos, setTime: (v: number) => { time = v } }
}

const imageRow = (jobId: number) => ({
  jobId, filePath: `/i/${jobId}.png`, thumbPath: `/t/${jobId}.jpg`, width: 64, height: 64, seed: 1,
  infotext: 'info', durationMs: null,
})

test('nextQueued returns the oldest queued job of that server only', () => {
  const { repos } = setup()
  const a = repos.servers.setActiveUrl('http://a:7860')
  const b = repos.servers.setActiveUrl('http://b:7860')
  repos.jobs.insert(b.id, 'txt2img', params())
  const first = repos.jobs.insert(a.id, 'txt2img', params())
  repos.jobs.insert(a.id, 'txt2img', params())
  expect(repos.jobs.nextQueued(a.id)?.id).toBe(first.id)
})

test('setStatus(done) stamps finishedAt and stores the patch', () => {
  const { repos, setTime } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  setTime(5000)
  const done = repos.jobs.setStatus(j.id, 'done', { durationMs: 4100, stepsPerSec: 5.5, peakVram: 9000 })
  expect(done.status).toBe('done')
  expect(done.finishedAt).toBe(5000)
  expect(done.durationMs).toBe(4100)
  expect(done.stepsPerSec).toBe(5.5)
  expect(done.peakVram).toBe(9000)
})

test('setStatus keeps finishedAt null for running and throws for unknown id', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  expect(repos.jobs.setStatus(j.id, 'running').finishedAt).toBeNull()
  expect(() => repos.jobs.setStatus(999, 'done')).toThrow()
})

test('markRunningInterrupted flips only running jobs', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const q = repos.jobs.insert(s.id, 'txt2img', params())
  const r = repos.jobs.insert(s.id, 'txt2img', params())
  repos.jobs.setStatus(r.id, 'running')
  expect(repos.jobs.markRunningInterrupted()).toBe(1)
  expect(repos.jobs.get(q.id)?.status).toBe('queued')
  expect(repos.jobs.get(r.id)?.status).toBe('interrupted')
})

test('listActive excludes done and cancelled', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const ids = (['queued', 'running', 'failed', 'interrupted', 'done', 'cancelled'] as const).map((st) => {
    const j = repos.jobs.insert(s.id, 'txt2img', params())
    if (st !== 'queued') repos.jobs.setStatus(j.id, st)
    return j.id
  })
  expect(repos.jobs.listActive().map((j) => j.id)).toEqual(ids.slice(0, 4))
})

test('images.list pages by beforeId in descending order', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  for (let i = 0; i < 5; i++) repos.images.insert(imageRow(j.id))
  expect(repos.images.list({ limit: 2 }).map((i) => i.id)).toEqual([5, 4])
  expect(repos.images.list({ limit: 2, beforeId: 4 }).map((i) => i.id)).toEqual([3, 2])
})

test('images.delete returns the deleted row or null', () => {
  const { repos } = setup(777)
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  const img = repos.images.insert(imageRow(j.id))
  expect(img).toMatchObject({ hidden: false, sourceImageId: null, createdAt: 777, filePath: '/i/1.png' })
  expect(repos.images.delete(img.id)).toEqual(img)
  expect(repos.images.list({ limit: 10 })).toEqual([])
  expect(repos.images.delete(img.id)).toBeNull()
})

test('setActiveUrl reuses the row for the same url and keeps one active', () => {
  const { repos, setTime } = setup(100)
  const a = repos.servers.setActiveUrl('http://a:7860')
  expect(a).toMatchObject({ name: 'a', active: true, lastConnectedAt: 100 })
  const b = repos.servers.setActiveUrl('http://b:7860')
  setTime(200)
  const a2 = repos.servers.setActiveUrl('http://a:7860')
  expect(a2.id).toBe(a.id)
  expect(a2.lastConnectedAt).toBe(200)
  expect(repos.servers.active()?.id).toBe(a.id)
  expect(b.id).not.toBe(a.id)
})

test('active is null before any server is set', () => {
  expect(setup().repos.servers.active()).toBeNull()
})

test('params survive a JSON round trip', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const p = params({ loras: [{ name: 'x', weight: 0.8, enabled: true }], shift: null, clipSkip: 2 })
  const j = repos.jobs.insert(s.id, 'img2img', p)
  expect(repos.jobs.get(j.id)?.params).toEqual(p)
})

test('settings get/set overwrite', () => {
  const { repos } = setup()
  expect(repos.settings.get('k')).toBeNull()
  repos.settings.set('k', 'v1')
  repos.settings.set('k', 'v2')
  expect(repos.settings.get('k')).toBe('v2')
})

test('openDb is idempotent on an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-db-'))
  const file = join(dir, 'app.db')
  try {
    const db1 = openDb(file)
    createRepos(db1, () => 1).settings.set('k', 'v')
    expect(db1.pragma('user_version', { simple: true })).toBe(1)
    db1.close()
    const db2 = openDb(file)
    expect(db2.pragma('user_version', { simple: true })).toBe(1)
    expect(createRepos(db2, () => 1).settings.get('k')).toBe('v')
    expect(db2.pragma('foreign_keys', { simple: true })).toBe(1)
    db2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('job error round-trips as a structured value', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  const err: JobError = { code: 'missingParts', missing: ['a.safetensors'] }
  expect(repos.jobs.setStatus(j.id, 'failed', { error: err }).error).toEqual(err)
  expect(repos.jobs.get(j.id)?.error).toEqual(err)
  expect(repos.jobs.insert(s.id, 'txt2img', params()).error).toBeNull()
})

test('a legacy non-JSON error text reads back as an unexpected error', () => {
  const { db, repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  db.prepare('UPDATE jobs SET error = ? WHERE id = ?').run('out of memory', j.id)
  expect(repos.jobs.get(j.id)?.error).toEqual({ code: 'unexpected', detail: 'out of memory' })
})

test('a job row with unparsable params can still be read', () => {
  const { db, repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  db.prepare('UPDATE jobs SET params = ? WHERE id = ?').run('not json {', j.id)
  expect(() => repos.jobs.get(j.id)).not.toThrow()
  expect(() => repos.jobs.nextQueued(s.id)).not.toThrow()
  expect(() => repos.jobs.listActive()).not.toThrow()
})

test.each(['null', '5', '"text"', '[1]'])('params %s reads back as an empty object', (text) => {
  const { db, repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  db.prepare('UPDATE jobs SET params = ? WHERE id = ?').run(text, j.id)
  expect(repos.jobs.get(j.id)?.params).toEqual({})
  expect(repos.jobs.nextQueued(s.id)?.params).toEqual({})
})

test('markRunningInterrupted stores the stopped error code', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  repos.jobs.setStatus(j.id, 'running')
  expect(repos.jobs.markRunningInterrupted()).toBe(1)
  expect(repos.jobs.get(j.id)).toMatchObject({ status: 'interrupted', error: { code: 'stopped' } })
})
