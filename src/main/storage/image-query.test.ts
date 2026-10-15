import type { GenerationParams } from '@shared/types'
import { openDb } from './db'
import { createRepos } from './repos'

const params = (over: Partial<GenerationParams> = {}): GenerationParams => ({
  family: 'sdxl', checkpoint: 'model.safetensors [abc]', modules: [], prompt: 'p', negativePrompt: 'n',
  width: 64, height: 64, steps: 20, cfgScale: 7, distilledCfg: 3.5, shift: null, clipSkip: null,
  sampler: 'Euler', scheduler: 'Simple', seed: -1, count: 1, loras: [], ...over,
})

const setup = () => {
  const repos = createRepos(openDb(':memory:'), () => 1)
  const server = repos.servers.setActiveUrl('http://a:7860')
  const add = (over: Partial<GenerationParams> = {}): number => {
    const job = repos.jobs.insert(server.id, 'txt2img', params(over))
    return repos.images.insert({
      jobId: job.id, filePath: 'a.png', thumbPath: 'a.jpg', width: 64, height: 64, seed: 1, infotext: 'i', durationMs: null,
    }).id
  }
  const ids = (q: Parameters<typeof repos.images.query>[0], revealHidden = false): number[] =>
    repos.images.query(q, { revealHidden }).map((r) => r.id)
  return { repos, add, ids }
}

test('text matches prompt, checkpoint and LoRA names from the job params, case-insensitive', () => {
  const { add, ids } = setup()
  const a = add({ prompt: 'A Red Dragon' })
  const b = add({ checkpoint: 'dragonFruit.safetensors' })
  const c = add({ loras: [{ name: 'Dragon_style', weight: 1, enabled: true }] })
  add({ prompt: 'a cat' })
  expect(ids({ limit: 10, text: 'dRaGoN' })).toEqual([c, b, a])
})

test('several tags narrow the result (AND)', () => {
  const { repos, add, ids } = setup()
  const a = add()
  const b = add()
  const c = add()
  repos.tags.add([a, b], ['cat'])
  repos.tags.add([b, c], ['night'])
  expect(ids({ limit: 10, tags: ['cat'] })).toEqual([b, a])
  expect(ids({ limit: 10, tags: ['cat', 'NIGHT'] })).toEqual([b])
})

test('text and tags combine', () => {
  const { repos, add, ids } = setup()
  const a = add({ prompt: 'dragon' })
  add({ prompt: 'dragon' })
  const c = add({ prompt: 'cat' })
  repos.tags.add([a, c], ['x'])
  expect(ids({ limit: 10, text: 'dragon', tags: ['x'] })).toEqual([a])
})

test('cursor: beforeId pages without gaps or repeats', () => {
  const { add, ids } = setup()
  const all = Array.from({ length: 7 }, () => add({ prompt: 'same' })).reverse()
  const seen: number[] = []
  let before: number | undefined
  for (;;) {
    const page = ids({ limit: 3, text: 'same', ...(before === undefined ? {} : { beforeId: before }) })
    if (page.length === 0) break
    seen.push(...page)
    before = page[page.length - 1]
  }
  expect(seen).toEqual(all)
})

test('hidden images are excluded from text/tag matches unless revealHidden', () => {
  const { repos, add, ids } = setup()
  const a = add({ prompt: 'dragon' })
  const b = add({ prompt: 'dragon' })
  repos.tags.add([a, b], ['t'])
  repos.images.setHidden([a], true)
  expect(ids({ limit: 10, text: 'dragon' })).toEqual([b])
  expect(ids({ limit: 10, tags: ['t'] })).toEqual([b])
  expect(ids({ limit: 10, text: 'dragon' }, true)).toEqual([b, a])
  expect(ids({ limit: 10, tags: ['t'] }, true)).toEqual([b, a])
})

test('hidden images without filters are still listed (as locked rows) when not revealed', () => {
  const { repos, add } = setup()
  const a = add()
  const b = add()
  repos.images.setHidden([a], true)
  const rows = repos.images.query({ limit: 10 }, { revealHidden: false })
  expect(rows.map((r) => [r.id, r.hidden])).toEqual([[b, false], [a, true]])
})

test('LIKE wildcards in text are literal: "50%" does not match everything', () => {
  const { add, ids } = setup()
  const a = add({ prompt: 'at 50% zoom' })
  add({ prompt: '500 things' })
  const c = add({ prompt: 'a_b' })
  add({ prompt: 'axb' })
  const d = add({ prompt: 'back\\slash' })
  expect(ids({ limit: 10, text: '50%' })).toEqual([a])
  expect(ids({ limit: 10, text: 'a_b' })).toEqual([c])
  expect(ids({ limit: 10, text: '\\' })).toEqual([d])
})

test('Cyrillic tags differing only in case are one tag, and a tag filter matches it in any case', () => {
  const { repos, add, ids } = setup()
  const a = add()
  const b = add()
  repos.tags.add([a], ['Кот'])
  repos.tags.add([b], ['кот'])
  expect(repos.tags.forImages([a, b])).toEqual(new Map([[a, ['Кот']], [b, ['Кот']]]))
  expect(ids({ limit: 10, tags: ['КОТ'] })).toEqual([b, a])
  repos.tags.remove([a, b], ['кОт'])
  expect(repos.tags.forImages([a, b]).size).toBe(0)
})

test('text search folds Cyrillic case: "ЗАКАТ" finds the prompt "закат"', () => {
  const { add, ids } = setup()
  const a = add({ prompt: 'красный закат' })
  const b = add({ loras: [{ name: 'Закат_стиль', weight: 1, enabled: true }] })
  add({ prompt: 'рассвет' })
  expect(ids({ limit: 10, text: 'ЗАКАТ' })).toEqual([b, a])
})

test('tag suggestions fold Cyrillic case and ignore spaces around the prefix', () => {
  const { repos, add } = setup()
  repos.tags.add([add()], ['Кот'])
  expect(repos.tags.suggest('  кО ', 10, { revealHidden: false })).toEqual(['Кот'])
})

test('beforeId combines with tags and with hidden filtering', () => {
  const { repos, add, ids } = setup()
  const all = Array.from({ length: 6 }, () => add())
  repos.tags.add(all, ['t'])
  repos.images.setHidden([all[3]!], true)
  const [, , , , e, f] = all
  // Newest first: f, e, (d hidden), c, b, a. A cursor at e continues with c.
  expect(ids({ limit: 2, tags: ['t'] })).toEqual([f, e])
  expect(ids({ limit: 2, tags: ['t'], beforeId: e! })).toEqual([all[2], all[1]])
  expect(ids({ limit: 2, tags: ['t'], beforeId: e! }, true)).toEqual([all[3], all[2]])
  expect(ids({ limit: 10, beforeId: all[4]! })).toEqual([all[3], all[2], all[1], all[0]])
})
