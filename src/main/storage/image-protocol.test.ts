import path from 'node:path'
import { resolveImageRequest, toImageUrl } from './image-protocol'

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
