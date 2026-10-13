import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createImageStore, type MakeThumb } from './image-store'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fnc-store-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const THUMB = Buffer.from([0xff, 0xd8, 9, 9])
const stubThumb: MakeThumb = () => ({ thumb: THUMB, width: 640, height: 480 })
const createdAt = new Date(2026, 9, 13, 12, 0, 0).getTime()
const name = { jobId: 7, seed: 42, createdAt }

const exists = (p: string) => fs.access(p).then(() => true, () => false)

test('save writes the png and the thumb and returns their sizes', async () => {
  const dir = path.join(root, 'images')
  const store = createImageStore(() => dir, stubThumb)
  const r = await store.save(PNG.toString('base64'), name)
  expect(r.filePath).toBe(path.join(dir, '2026-10', '7-42.png'))
  expect(r.thumbPath).toBe(path.join(dir, 'thumbs', '7-42.jpg'))
  expect(r.width).toBe(640)
  expect(r.height).toBe(480)
  expect(await fs.readFile(r.filePath)).toEqual(PNG)
  expect(await fs.readFile(r.thumbPath)).toEqual(THUMB)
})

test('save hands the decoded png to makeThumb', async () => {
  const seen: Buffer[] = []
  const store = createImageStore(() => root, (png) => { seen.push(png); return stubThumb(png) })
  await store.save(PNG.toString('base64'), name)
  expect(seen).toEqual([PNG])
})

test('save strips a data-URL prefix', async () => {
  const store = createImageStore(() => root, stubThumb)
  const r = await store.save(`data:image/png;base64,${PNG.toString('base64')}`, name)
  expect(await fs.readFile(r.filePath)).toEqual(PNG)
})

test('save names the month folder from createdAt in local time', async () => {
  const store = createImageStore(() => root, stubThumb)
  const r = await store.save(PNG.toString('base64'), { ...name, createdAt: new Date(2026, 0, 1, 0, 30).getTime() })
  expect(path.basename(path.dirname(r.filePath))).toBe('2026-01')
})

test('save creates missing folders', async () => {
  const dir = path.join(root, 'a', 'b', 'c')
  const store = createImageStore(() => dir, stubThumb)
  const r = await store.save(PNG.toString('base64'), name)
  expect(await exists(r.filePath)).toBe(true)
  expect(await exists(r.thumbPath)).toBe(true)
})

test('save rejects when the directory cannot be created', async () => {
  const file = path.join(root, 'occupied')
  await fs.writeFile(file, 'x')
  const store = createImageStore(() => file, stubThumb)
  await expect(store.save(PNG.toString('base64'), name)).rejects.toBeDefined()
})

test('save removes the partial png when the thumb step fails', async () => {
  const store = createImageStore(() => root, () => { throw new Error('thumb failed') })
  await expect(store.save(PNG.toString('base64'), name)).rejects.toThrow('thumb failed')
  expect(await exists(path.join(root, '2026-10', '7-42.png'))).toBe(false)
  expect(await exists(path.join(root, 'thumbs', '7-42.jpg'))).toBe(false)
})

test('remove deletes both files', async () => {
  const store = createImageStore(() => root, stubThumb)
  const r = await store.save(PNG.toString('base64'), name)
  await store.remove(r.filePath, r.thumbPath)
  expect(await exists(r.filePath)).toBe(false)
  expect(await exists(r.thumbPath)).toBe(false)
})

test('remove ignores files that are already gone', async () => {
  const store = createImageStore(() => root, stubThumb)
  await expect(store.remove(path.join(root, 'no.png'), path.join(root, 'no.jpg'))).resolves.toBeUndefined()
})
