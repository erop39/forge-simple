import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
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

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const result = Buffer.alloc(body.length + 8)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function onePixelPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

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

test('readSource returns only a managed PNG and rejects corrupt or outside files', async () => {
  const store = createImageStore(() => root, stubThumb)
  const valid = onePixelPng()
  const saved = await store.save(valid.toString('base64'), name)
  expect(await store.readSource(saved.filePath)).toBe(valid.toString('base64'))
  await fs.writeFile(saved.filePath, valid.subarray(0, 33))
  await expect(store.readSource(saved.filePath)).rejects.toThrow()
  await fs.writeFile(saved.filePath, valid)
  const badCrc = Buffer.from(valid)
  badCrc[30] = badCrc[30]! ^ 1
  await fs.writeFile(saved.filePath, badCrc)
  await expect(store.readSource(saved.filePath)).rejects.toThrow()
  await expect(store.readSource(path.join(root, '..', 'outside.png'))).rejects.toThrow()
  await fs.writeFile(saved.filePath, 'broken')
  await expect(store.readSource(saved.filePath)).rejects.toThrow()
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
