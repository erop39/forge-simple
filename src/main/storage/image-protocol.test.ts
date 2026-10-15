import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GenerationParams } from '@shared/types'
import { createLock } from '../lock/lock'
import { createOplog } from '../oplog/oplog'
import { openDb } from './db'
import { createImageHandler, hiddenImageAccess, resolveImageRequest, toImageUrl, toRecordImageUrl } from './image-protocol'
import { createRepos } from './repos'

const base = path.resolve(path.join('tmp-base', 'images'))

test('url round trip', () => {
  const p = path.join(base, '2026-10', '7-42.png')
  expect(resolveImageRequest(toImageUrl(p, base), base)).toBe(p)
})

test('toImageUrl uses forward slashes and encodes each segment', () => {
  const p = path.join(base, 'my folder', 'a#b%.png')
  const url = toImageUrl(p, base)
  expect(url).toBe('fnc-img://local/my%20folder/a%23b%25.png')
  expect(resolveImageRequest(url, base)).toBe(p)
})

test('record URLs survive a folder change, enforce the lock, and refuse files outside managed roots', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'fnc-record-url-'))
  try {
    const old = path.join(temp, 'old')
    const next = path.join(temp, 'next')
    mkdirSync(old)
    mkdirSync(next)
    const file = path.join(old, 'image.png')
    const thumb = path.join(old, 'thumb.jpg')
    writeFileSync(file, 'image')
    writeFileSync(thumb, 'thumb')
    let hidden = true
    let open = false
    const handler = createImageHandler({
      baseDir: () => next, isBlocked: () => false, roots: () => [old, next], lockOpen: () => open,
      lookupImage: (id) => id === 7 ? { filePath: file, thumbPath: thumb, hidden } : null,
    })
    expect(toRecordImageUrl(7, 'image')).toBe('fnc-img://local/image/7')
    expect((await handler(toRecordImageUrl(7, 'image'))).status).toBe(404)
    open = true
    expect((await handler(toRecordImageUrl(7, 'image'))).status).toBe(200)
    expect((await handler(toRecordImageUrl(7, 'thumb'))).headers.get('Cache-Control')).toBe('no-store')
    hidden = false
    open = false
    expect((await handler(toRecordImageUrl(7, 'image'))).status).toBe(200)
    expect((await handler('fnc-img://local/../outside.png')).status).toBe(403)
    const outside = path.join(temp, 'outside.png')
    writeFileSync(outside, 'private')
    const malicious = createImageHandler({ baseDir: () => next, isBlocked: () => false, roots: () => [old, next],
      lockOpen: () => true, lookupImage: () => ({ filePath: outside, thumbPath: outside, hidden: false }) })
    expect((await malicious(toRecordImageUrl(7, 'image'))).status).toBe(404)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('a request for a file inside baseDir resolves to its absolute path', () => {
  expect(resolveImageRequest('fnc-img://local/thumbs/1-2.jpg', base)).toBe(path.join(base, 'thumbs', '1-2.jpg'))
})

test('a query string or fragment is ignored', () => {
  expect(resolveImageRequest('fnc-img://local/a.png?x=1#y', base)).toBe(path.join(base, 'a.png'))
})

test.each([
  'fnc-img://local/../secret.png',
  'fnc-img://local/%2e%2e/x.png',
  'fnc-img://local/C:/Windows/x.png',
  'fnc-img://local/C%3A/Windows/x.png',
  'fnc-img://local/a%5Cb.png',
  'fnc-img://local/a%00b.png',
  'fnc-img://local/../images-evil/x.png',
  'fnc-img://local/%2e%2e/images-evil/x.png',
  'fnc-img://local/',
  'fnc-img://local',
])('resolveImageRequest rejects %s', (u) => {
  expect(resolveImageRequest(u, base)).toBeNull()
})

test('double-encoded traversal is decoded once, so it stays a literal name', () => {
  // %252e%252e decodes once to "%2e%2e", a harmless file name, never to ".."
  const r = resolveImageRequest('fnc-img://local/%252e%252e/x.png', base)
  expect(r).toBe(path.join(base, '%2e%2e', 'x.png'))
})

test('a sibling directory sharing the base prefix is rejected', () => {
  expect(resolveImageRequest('fnc-img://local/../images-evil/x.png', base)).toBeNull()
})

test('a malformed URL returns null', () => {
  expect(resolveImageRequest('not a url', base)).toBeNull()
  expect(resolveImageRequest('fnc-img://local/%E0%A4%A.png', base)).toBeNull()
  expect(resolveImageRequest('', base)).toBeNull()
})

test('a wrong host returns null', () => {
  expect(resolveImageRequest('fnc-img://evil/a.png', base)).toBeNull()
  expect(resolveImageRequest('fnc-img://local.evil/a.png', base)).toBeNull()
  expect(resolveImageRequest('fnc-img://local:80/a.png', base)).toBeNull()
})

test('a wrong scheme returns null', () => {
  expect(resolveImageRequest('http://local/a.png', base)).toBeNull()
  expect(resolveImageRequest('file://local/a.png', base)).toBeNull()
  expect(resolveImageRequest('fnc-img:/local/a.png', base)).toBeNull()
})

test.each([
  'fnc-img://local/thumbs/12345-~1.jpg',
  'fnc-img://local/thumbs/a.jpg.',
  'fnc-img://local/thumbs/a.jpg%20',
  'fnc-img://local/thumbs./a.jpg',
])('resolveImageRequest rejects Windows aliases of another name: %s', (u) => {
  expect(resolveImageRequest(u, base)).toBeNull()
})

describe('the fnc-img handler and the lock', () => {
  let dir: string
  let repos: ReturnType<typeof createRepos>
  let lock: ReturnType<typeof createLock>
  let handle: (url: string) => Promise<Response>
  let hiddenId: number

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fnc-proto-'))
    const db = openDb(':memory:')
    repos = createRepos(db, () => 1)
    lock = createLock(repos.settings, createOplog(db, () => 1))
    await lock.setPassword(null, 'secret-pass')
    const job = repos.jobs.insert(repos.servers.setActiveUrl('http://a:7860').id, 'txt2img', {} as GenerationParams)
    mkdirSync(path.join(dir, '2026-10'))
    mkdirSync(path.join(dir, 'thumbs'))
    const add = (name: string) => {
      const filePath = path.join(dir, '2026-10', `${name}.png`)
      const thumbPath = path.join(dir, 'thumbs', `${name}.jpg`)
      writeFileSync(filePath, `png ${name}`)
      writeFileSync(thumbPath, `jpg ${name}`)
      return repos.images.insert({ jobId: job.id, filePath, thumbPath, width: 1, height: 1, seed: 1, infotext: '', durationMs: null }).id
    }
    hiddenId = add('1-1')
    add('1-2')
    repos.images.setHidden([hiddenId], true)
    handle = createImageHandler({ baseDir: () => dir, ...hiddenImageAccess(repos.images, lock, () => dir) })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const status = async (url: string) => (await handle(url)).status

  test('while the lock is closed a hidden image and its thumbnail answer 404, in any letter case', async () => {
    expect(await status('fnc-img://local/2026-10/1-1.png')).toBe(404)
    expect(await status('fnc-img://local/thumbs/1-1.jpg')).toBe(404)
    expect(await status('fnc-img://local/THUMBS/1-1.JPG')).toBe(404)
    expect(await status('fnc-img://local/2026-10/1-1.png?x#y')).toBe(404)
  })

  test('a visible image is served while the lock is closed', async () => {
    const res = await handle('fnc-img://local/thumbs/1-2.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(await res.text()).toBe('jpg 1-2')
  })

  test('once the lock is open the hidden files are served; closing it blocks them again', async () => {
    await lock.open('secret-pass')
    const res = await handle('fnc-img://local/2026-10/1-1.png')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('png 1-1')
    expect(await status('fnc-img://local/thumbs/1-1.jpg')).toBe(200)
    lock.close()
    expect(await status('fnc-img://local/thumbs/1-1.jpg')).toBe(404)
  })

  test('a hidden file served while open is not cached; a visible one has no such header', async () => {
    await lock.open('secret-pass')
    expect((await handle('fnc-img://local/thumbs/1-1.jpg')).headers.get('Cache-Control')).toBe('no-store')
    expect((await handle('fnc-img://local/2026-10/1-1.png')).headers.get('Cache-Control')).toBe('no-store')
    expect((await handle('fnc-img://local/thumbs/1-2.jpg')).headers.get('Cache-Control')).toBeNull()
  })

  test('a stored path written differently (dots, other separators, case) and a base with a trailing separator still block', async () => {
    const job = repos.jobs.insert(repos.servers.active()!.id, 'txt2img', {} as GenerationParams)
    writeFileSync(path.join(dir, 'thumbs', '7-7.jpg'), 'jpg 7-7')
    const odd = `${dir}/2026-10/../THUMBS/./7-7.JPG`
    const id = repos.images.insert({ jobId: job.id, filePath: odd, thumbPath: odd, width: 1, height: 1, seed: 1, infotext: '', durationMs: null }).id
    repos.images.setHidden([id], true)
    const withSep = createImageHandler({ baseDir: () => dir + path.sep, ...hiddenImageAccess(repos.images, lock, () => dir + path.sep) })
    expect((await handle('fnc-img://local/thumbs/7-7.jpg')).status).toBe(404)
    expect((await withSep('fnc-img://local/thumbs/7-7.jpg')).status).toBe(404)
    await lock.open('secret-pass')
    expect((await withSep('fnc-img://local/thumbs/7-7.jpg')).status).toBe(200)
  })

  test('unhiding makes the files available again', async () => {
    repos.images.setHidden([hiddenId], false)
    expect(await status('fnc-img://local/thumbs/1-1.jpg')).toBe(200)
  })

  test('an unsafe request is refused, a missing file is 404', async () => {
    expect(await status('fnc-img://local/../x.png')).toBe(403)
    expect(await status('fnc-img://local/thumbs/1-1.txt')).toBe(403)
    expect(await status('fnc-img://local/thumbs/9-9.jpg')).toBe(404)
  })
})
