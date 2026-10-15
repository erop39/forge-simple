import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerationParams, JobError } from '@shared/types'
import Database from 'better-sqlite3'
import { MIGRATIONS, openDb } from './db'
import { createRepos, DuplicatePresetError, DuplicateServerError, isGenerationParams } from './repos'

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

test('saved jobs accept absent hires and reject malformed hires settings', () => {
  expect(isGenerationParams(params())).toBe(true)
  expect(isGenerationParams(params({ hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }))).toBe(true)
  expect(isGenerationParams({ ...params(), hires: { scale: 3, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } })).toBe(false)
  expect(isGenerationParams({ ...params(), hires: { scale: 2, upscaler: 'Latent', secondPassSteps: -1, denoisingStrength: 0.4 } })).toBe(false)
  expect(isGenerationParams({ ...params(), hires: 'on' })).toBe(false)
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

test('deleting a source detaches saved derivatives without deleting their files or rows', () => {
  const { repos } = setup()
  const s = repos.servers.setActiveUrl('http://a:7860')
  const j = repos.jobs.insert(s.id, 'txt2img', params())
  const source = repos.images.insert(imageRow(j.id))
  const result = repos.images.insert({ ...imageRow(j.id), sourceImageId: source.id })
  expect(repos.images.delete(source.id)?.id).toBe(source.id)
  expect(repos.images.get(result.id)?.sourceImageId).toBeNull()
  expect(repos.images.get(result.id)).not.toBeNull()
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
    expect(db1.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    db1.close()
    const db2 = openDb(file)
    expect(db2.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
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

describe('saved servers', () => {
  test('list is ordered by name, case-insensitive, and add returns the new row', () => {
    const { repos } = setup(100)
    const b = repos.servers.add('beta', 'http://b:7860')
    repos.servers.add('Alpha', 'http://a:7860')
    repos.servers.add('gamma', 'http://c:7860')
    expect(b).toMatchObject({ name: 'beta', url: 'http://b:7860', active: false, lastConnectedAt: null })
    expect(repos.servers.list().map((s) => s.name)).toEqual(['Alpha', 'beta', 'gamma'])
    expect(repos.servers.active()).toBeNull()
  })

  test('add rejects a url that a live server already has', () => {
    const { repos } = setup()
    repos.servers.add('a', 'http://a:7860')
    expect(() => repos.servers.add('other', 'http://a:7860')).toThrow(DuplicateServerError)
    expect(repos.servers.list()).toHaveLength(1)
  })

  test('update renames and changes the url; a url held by another live server is refused', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    repos.servers.add('b', 'http://b:7860')
    expect(repos.servers.update(a.id, { name: 'Home', url: 'http://home:7860' }))
      .toMatchObject({ id: a.id, name: 'Home', url: 'http://home:7860' })
    expect(() => repos.servers.update(a.id, { name: 'Home', url: 'http://b:7860' })).toThrow(DuplicateServerError)
    expect(repos.servers.update(a.id, { name: 'Home 2', url: 'http://home:7860' })?.name).toBe('Home 2')
    expect(repos.servers.update(999, { name: 'x', url: 'http://x' })).toBeNull()
  })

  test('activate makes exactly one server active and stamps lastConnectedAt', () => {
    const { repos } = setup(300)
    const a = repos.servers.add('a', 'http://a:7860')
    const b = repos.servers.add('b', 'http://b:7860')
    repos.servers.activate(a.id)
    expect(repos.servers.activate(b.id)).toMatchObject({ id: b.id, active: true, lastConnectedAt: 300 })
    expect(repos.servers.list().filter((s) => s.active).map((s) => s.id)).toEqual([b.id])
    expect(repos.servers.activate(999)).toBeNull()
    expect(repos.servers.active()?.id).toBe(b.id)
  })

  test('remove is soft: queued jobs go, finished jobs and images stay, the server leaves list and get', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    const b = repos.servers.add('b', 'http://b:7860')
    const done = repos.jobs.insert(a.id, 'txt2img', params())
    repos.jobs.setStatus(done.id, 'done')
    const img = repos.images.insert(imageRow(done.id))
    const failed = repos.jobs.insert(a.id, 'txt2img', params())
    repos.jobs.setStatus(failed.id, 'failed')
    const q1 = repos.jobs.insert(a.id, 'txt2img', params())
    const q2 = repos.jobs.insert(a.id, 'txt2img', params())
    const other = repos.jobs.insert(b.id, 'txt2img', params())

    expect(repos.servers.remove(a.id)).toEqual({ server: expect.objectContaining({ id: a.id }), deletedJobIds: [q1.id, q2.id] })
    expect(repos.jobs.get(q1.id)).toBeNull()
    expect(repos.jobs.get(q2.id)).toBeNull()
    expect(repos.jobs.get(done.id)?.status).toBe('done')
    expect(repos.jobs.get(failed.id)?.status).toBe('failed')
    expect(repos.jobs.get(other.id)?.status).toBe('queued')
    expect(repos.images.list({ limit: 10 }).map((i) => i.id)).toEqual([img.id])
    expect(repos.servers.list().map((s) => s.id)).toEqual([b.id])
    expect(repos.servers.get(a.id)).toBeNull()
    expect(repos.servers.get(b.id)?.name).toBe('b')
    expect(repos.servers.remove(a.id)).toBeNull()
  })

  test('removing the active server leaves no active server', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    repos.servers.activate(a.id)
    repos.servers.remove(a.id)
    expect(repos.servers.active()).toBeNull()
    expect(repos.servers.activate(a.id)).toBeNull()
  })

  test('removing a server drops its stored checkpoint families', () => {
    const { db, repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    const b = repos.servers.add('b', 'http://b:7860')
    const meta = db.prepare("INSERT INTO checkpoint_meta (server_id, filename, family) VALUES (?, 'm.safetensors', 'sdxl')")
    meta.run(a.id)
    meta.run(b.id)
    repos.servers.remove(a.id)
    expect(db.prepare('SELECT server_id FROM checkpoint_meta').all()).toEqual([{ server_id: b.id }])
  })

  test('adding a removed url again revives that row under the new name', () => {
    const { repos } = setup()
    const a = repos.servers.add('old', 'http://a:7860')
    const done = repos.jobs.insert(a.id, 'txt2img', params())
    repos.jobs.setStatus(done.id, 'done')
    repos.servers.activate(a.id)
    repos.servers.remove(a.id)
    const again = repos.servers.add('new', 'http://a:7860')
    expect(again).toMatchObject({ id: a.id, name: 'new', url: 'http://a:7860', active: false })
    expect(repos.servers.list().map((s) => s.name)).toEqual(['new'])
  })

  test('setActiveUrl revives a removed url instead of failing on it', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    repos.servers.remove(a.id)
    expect(repos.servers.setActiveUrl('http://a:7860')).toMatchObject({ id: a.id, active: true })
    expect(repos.servers.list()).toHaveLength(1)
  })

  test('changing a url to one a removed server held frees it from the removed row', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    const b = repos.servers.add('b', 'http://b:7860')
    repos.servers.remove(a.id)
    expect(repos.servers.update(b.id, { name: 'b', url: 'http://a:7860' })).toMatchObject({ id: b.id, url: 'http://a:7860' })
    expect(repos.servers.list().map((s) => s.id)).toEqual([b.id])
  })

  test('hasRunning tells whether any job is running', () => {
    const { repos } = setup()
    const a = repos.servers.add('a', 'http://a:7860')
    const j = repos.jobs.insert(a.id, 'txt2img', params())
    expect(repos.jobs.hasRunning()).toBe(false)
    repos.jobs.setStatus(j.id, 'running')
    expect(repos.jobs.hasRunning()).toBe(true)
  })
})

test('a database at user_version 1 upgrades and keeps its active server and jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-db-'))
  const file = join(dir, 'app.db')
  try {
    const old = new Database(file)
    old.exec(MIGRATIONS[0]!)
    old.pragma('user_version = 1')
    old.prepare("INSERT INTO servers (name, url, active, last_connected_at) VALUES ('home', 'http://home:7860', 1, 5)").run()
    old.prepare("INSERT INTO jobs (server_id, type, status, params, created_at) VALUES (1, 'txt2img', 'queued', '{}', 1)").run()
    old.close()

    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const repos = createRepos(db, () => 1)
    expect(repos.servers.active()).toEqual({ id: 1, name: 'home', url: 'http://home:7860', active: true, lastConnectedAt: 5 })
    expect(repos.servers.list()).toHaveLength(1)
    expect(repos.jobs.nextQueued(1)?.id).toBe(1)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('negative presets', () => {
  test('list is ordered by name ignoring case', () => {
    const { repos } = setup()
    repos.negativePresets.add('beta', 'b text')
    repos.negativePresets.add('Alpha', 'a text')
    repos.negativePresets.add('gamma', 'g text')
    expect(repos.negativePresets.list().map((p) => p.name)).toEqual(['Alpha', 'beta', 'gamma'])
  })

  test('add stores name, text and creation time', () => {
    const { repos } = setup(4242)
    const p = repos.negativePresets.add('blurry', 'blurry, lowres')
    expect(p).toEqual({ id: p.id, name: 'blurry', text: 'blurry, lowres', createdAt: 4242 })
    expect(repos.negativePresets.list()).toEqual([p])
  })

  test('a duplicate name throws DuplicatePresetError, ignoring case', () => {
    const { repos } = setup()
    repos.negativePresets.add('Hands', 'bad hands')
    expect(() => repos.negativePresets.add('Hands', 'x')).toThrow(DuplicatePresetError)
    expect(() => repos.negativePresets.add('hANDS', 'x')).toThrow(DuplicatePresetError)
    expect(repos.negativePresets.list()).toHaveLength(1)
  })

  test('update renames and changes text; unknown id is null', () => {
    const { repos } = setup()
    const p = repos.negativePresets.add('one', 'first')
    expect(repos.negativePresets.update(p.id, { name: 'uno' })).toEqual({ ...p, name: 'uno' })
    expect(repos.negativePresets.update(p.id, { text: 'second' })).toEqual({ ...p, name: 'uno', text: 'second' })
    expect(repos.negativePresets.get(p.id)?.text).toBe('second')
    expect(repos.negativePresets.update(999, { name: 'x' })).toBeNull()
  })

  test('renaming onto another preset name throws; a case-only rename of itself works', () => {
    const { repos } = setup()
    const a = repos.negativePresets.add('a', 'x')
    repos.negativePresets.add('b', 'y')
    expect(() => repos.negativePresets.update(a.id, { name: 'B' })).toThrow(DuplicatePresetError)
    expect(repos.negativePresets.update(a.id, { name: 'A' })?.name).toBe('A')
  })

  test('remove deletes and returns the preset; unknown id is null', () => {
    const { repos } = setup()
    const p = repos.negativePresets.add('gone', 'x')
    expect(repos.negativePresets.remove(p.id)).toEqual(p)
    expect(repos.negativePresets.list()).toEqual([])
    expect(repos.negativePresets.remove(p.id)).toBeNull()
  })
})

test('a database at user_version 2 upgrades with an empty preset table and keeps its servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-db-'))
  const file = join(dir, 'app.db')
  try {
    const old = new Database(file)
    old.exec(MIGRATIONS[0]!)
    old.exec(MIGRATIONS[1]!)
    old.pragma('user_version = 2')
    old.prepare("INSERT INTO servers (name, url, active) VALUES ('home', 'http://home:7860', 1)").run()
    old.close()

    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const repos = createRepos(db, () => 7)
    expect(repos.servers.active()?.name).toBe('home')
    expect(repos.negativePresets.list()).toEqual([])
    expect(repos.negativePresets.add('n', 't').createdAt).toBe(7)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a database at user_version 3 upgrades with empty tag tables and keeps its image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-db-'))
  const file = join(dir, 'app.db')
  try {
    const old = new Database(file)
    for (let i = 0; i < 3; i++) old.exec(MIGRATIONS[i]!)
    old.pragma('user_version = 3')
    old.prepare("INSERT INTO servers (name, url, active) VALUES ('home', 'http://home:7860', 1)").run()
    old.prepare("INSERT INTO jobs (server_id, type, status, params, created_at) VALUES (1, 'txt2img', 'done', '{}', 1)").run()
    old.prepare(
      `INSERT INTO images (job_id, file_path, thumb_path, width, height, seed, infotext, created_at)
       VALUES (1, 'a.png', 'a.jpg', 8, 8, 1, 'i', 1)`,
    ).run()
    old.close()

    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const repos = createRepos(db, () => 7)
    expect(repos.images.get(1)?.filePath).toBe('a.png')
    expect(repos.tags.forImages([1]).size).toBe(0)
    repos.tags.add([1], ['cat'])
    expect(repos.tags.forImages([1]).get(1)).toEqual(['cat'])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const withImages = (n: number) => {
  const ctx = setup()
  const s = ctx.repos.servers.setActiveUrl('http://a:7860')
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const j = ctx.repos.jobs.insert(s.id, 'txt2img', params())
    ids.push(ctx.repos.images.insert(imageRow(j.id)).id)
  }
  return { ...ctx, ids }
}

test('tags.add normalizes names, ignores blanks and over-long names, and is case-insensitive', () => {
  const { repos, ids } = withImages(1)
  repos.tags.add(ids, ['  Red   Hair ', 'red hair', '', '   ', 'x'.repeat(41), 'y'.repeat(40)])
  expect(repos.tags.forImages(ids).get(ids[0]!)).toEqual(['Red Hair', 'y'.repeat(40)])
})

test('tags.add skips unknown image ids and is idempotent', () => {
  const { repos, ids } = withImages(1)
  repos.tags.add([ids[0]!, 999], ['a'])
  repos.tags.add(ids, ['A'])
  expect([...repos.tags.forImages([ids[0]!, 999]).keys()]).toEqual([ids[0]])
  expect(repos.tags.forImages(ids).get(ids[0]!)).toEqual(['a'])
})

test('tags.remove detaches tags and deletes tags no image uses', () => {
  const { repos, db, ids } = withImages(2)
  repos.tags.add(ids, ['shared'])
  repos.tags.add([ids[0]!], ['solo'])
  repos.tags.remove([ids[0]!], ['shared', 'solo'])
  expect(repos.tags.forImages(ids).get(ids[1]!)).toEqual(['shared'])
  expect(db.prepare('SELECT name FROM tags').all()).toEqual([{ name: 'shared' }])
  repos.tags.remove([ids[1]!], ['SHARED'])
  expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 0 })
})

test('deleting the only image with a tag deletes the tag; a shared tag stays', () => {
  const { repos, db, ids } = withImages(2)
  repos.tags.add([ids[0]!], ['solo'])
  repos.tags.add(ids, ['shared'])
  repos.images.delete(ids[0]!)
  expect(db.prepare('SELECT name FROM tags').all()).toEqual([{ name: 'shared' }])
  repos.images.delete(ids[1]!)
  expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 0 })
})

test('tags.suggest matches the prefix without case, orders by use, and ignores hidden images unless revealed', () => {
  const { repos, ids } = withImages(3)
  repos.tags.add([ids[0]!], ['cat', 'castle'])
  repos.tags.add([ids[1]!, ids[2]!], ['Cart'])
  repos.tags.add([ids[2]!], ['car_'])
  expect(repos.tags.suggest('CA', 10, { revealHidden: false })).toEqual(['Cart', 'car_', 'castle', 'cat'])
  expect(repos.tags.suggest('ca', 2, { revealHidden: false })).toEqual(['Cart', 'car_'])
  expect(repos.tags.suggest('car_', 10, { revealHidden: false })).toEqual(['car_'])
  expect(repos.tags.suggest('c%', 10, { revealHidden: false })).toEqual([])
  repos.images.setHidden([ids[0]!], true)
  expect(repos.tags.suggest('ca', 10, { revealHidden: false })).toEqual(['Cart', 'car_'])
  expect(repos.tags.suggest('ca', 10, { revealHidden: true })).toEqual(['Cart', 'car_', 'castle', 'cat'])
})

test('images.setHidden counts existing images and flips the flag both ways', () => {
  const { repos, ids } = withImages(2)
  expect(repos.images.setHidden([ids[0]!, 999], true)).toBe(1)
  expect(repos.images.get(ids[0]!)?.hidden).toBe(true)
  expect(repos.images.get(ids[1]!)?.hidden).toBe(false)
  expect(repos.images.setHidden([ids[0]!], false)).toBe(1)
  expect(repos.images.get(ids[0]!)?.hidden).toBe(false)
})

test('images carry enhanced when their job was an upscale or ran hires', () => {
  const { repos } = setup()
  const server = repos.servers.setActiveUrl('http://a:7860')
  const hires = (scale: 1 | 2) => ({ scale, upscaler: 'Latent', secondPassSteps: 8, denoisingStrength: 0.4 })
  const jobs = [
    repos.jobs.insert(server.id, 'txt2img', params()),
    repos.jobs.insert(server.id, 'txt2img', params({ hires: hires(2) })),
    repos.jobs.insert(server.id, 'txt2img', params({ hires: hires(1) })),
    repos.jobs.insert(server.id, 'upscale', params({ upscale: { sourceImageId: 1, upscaler: 'x', scale: 2 } })),
  ]
  const images = jobs.map((j) => repos.images.insert(imageRow(j.id)))
  expect(images.map((i) => i.enhanced)).toEqual([false, true, false, true])
  expect(repos.images.list({ limit: 10 }).map((i) => i.enhanced).reverse()).toEqual([false, true, false, true])
})

test('clearUnfinished removes failed and interrupted jobs without images and keeps the rest', () => {
  const { repos } = setup()
  const server = repos.servers.setActiveUrl('http://a:7860')
  const add = (status: 'failed' | 'interrupted' | 'queued' | 'done') => {
    const job = repos.jobs.insert(server.id, 'txt2img', params())
    return status === 'queued' ? job : repos.jobs.setStatus(job.id, status)
  }
  const failed = add('failed')
  const interrupted = add('interrupted')
  const queued = add('queued')
  const done = add('done')
  repos.images.insert(imageRow(done.id))
  expect(repos.jobs.clearUnfinished()).toEqual([failed.id, interrupted.id])
  expect(repos.jobs.get(failed.id)).toBeNull()
  expect(repos.jobs.get(queued.id)).not.toBeNull()
  expect(repos.jobs.get(done.id)).not.toBeNull()
  expect(repos.jobs.clearUnfinished()).toEqual([])
})

test('modelMeta keeps marks per server, kind and file, and clearPreviews leaves the marks', () => {
  const { repos } = setup()
  const a = repos.servers.setActiveUrl('http://a:7860')
  const b = repos.servers.setActiveUrl('http://b:7860')
  repos.modelMeta.setFavorite(a.id, 'checkpoint', 'f1', true)
  repos.modelMeta.setNote(a.id, 'checkpoint', 'f1', 'good')
  repos.modelMeta.setFamily(a.id, 'checkpoint', 'f1', 'anima')
  repos.modelMeta.setPreview(a.id, 'checkpoint', 'f1', 'png')
  repos.modelMeta.setTriggers(a.id, 'lora', 'l1', ['x', 'y'])
  expect(repos.modelMeta.get(a.id, 'checkpoint', 'f1')).toEqual({
    family: 'anima', favorite: true, note: 'good', preview: 'png', triggers: null, civitai: null,
  })
  expect(repos.modelMeta.get(b.id, 'checkpoint', 'f1')).toBeNull()
  expect(repos.modelMeta.get(a.id, 'lora', 'f1')).toBeNull()
  expect(repos.modelMeta.list(a.id, 'lora').get('l1')?.triggers).toEqual(['x', 'y'])
  repos.modelMeta.setTriggers(a.id, 'lora', 'l1', null)
  expect(repos.modelMeta.get(a.id, 'lora', 'l1')?.triggers).toBeNull()
  repos.modelMeta.clearPreviews(a.id)
  expect(repos.modelMeta.get(a.id, 'checkpoint', 'f1')).toMatchObject({ preview: null, favorite: true, family: 'anima' })
})
