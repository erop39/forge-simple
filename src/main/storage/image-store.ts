import { promises as fs } from 'node:fs'
import path from 'node:path'
import { crc32, inflateSync } from 'node:zlib'

export type MakeThumb = (png: Buffer) => { thumb: Buffer; width: number; height: number }

export interface SavedImage { filePath: string; thumbPath: string; width: number; height: number }

export class SourceImageError extends Error {
  constructor(readonly kind: 'missing' | 'corrupt') {
    super(`Source image ${kind}`)
  }
}

const DATA_URL_PREFIX = /^data:image\/[^;,]+;base64,/i
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const MAX_DECODED_BYTES = 256 * 1024 * 1024

function validPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || bytes.length > MAX_SOURCE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  let ihdr = false
  let ended = false
  const imageData: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) return false
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false
    if (!ihdr) {
      if (type !== 'IHDR' || length !== 13 || bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0) return false
      ihdr = true
    } else if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, end - 4))
    else if (type === 'IEND') {
      if (length !== 0 || imageData.length === 0 || end !== bytes.length) return false
      ended = true
      break
    }
    offset = end
  }
  if (!ended) return false
  try {
    inflateSync(Buffer.concat(imageData), { maxOutputLength: MAX_DECODED_BYTES })
    return true
  } catch {
    return false
  }
}

function monthFolder(createdAt: number): string {
  const d = new Date(createdAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export function createImageStore(dir: () => string, makeThumb: MakeThumb, roots: () => string[] = () => [dir()]): {
  save(pngBase64: string, name: { jobId: number; seed: number; createdAt: number }): Promise<SavedImage>
  remove(filePath: string, thumbPath: string): Promise<void>
  readSource(filePath: string): Promise<string>
  /** A thumbnail's bytes, read only from inside an approved folder (no symlink out of it); SourceImageError otherwise. */
  readThumb(thumbPath: string): Promise<Buffer>
} {
  async function removeOne(file: string): Promise<void> {
    const resolved = path.resolve(file)
    for (const root of roots()) {
      if (!inside(path.resolve(root), resolved)) continue
      try {
        const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(resolved))])
        if (realParent === realRoot || inside(realRoot, realParent)) {
          await fs.rm(resolved, { force: true })
          return
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
    }
    throw new SourceImageError('corrupt')
  }

  async function remove(filePath: string, thumbPath: string): Promise<void> {
    await Promise.all([removeOne(filePath), removeOne(thumbPath)])
  }

  return {
    async readThumb(thumbPath) {
      const resolved = path.resolve(thumbPath)
      try {
        const realFile = await fs.realpath(resolved)
        for (const root of roots()) {
          if (!inside(path.resolve(root), resolved) || !inside(await fs.realpath(root), realFile)) continue
          return await fs.readFile(realFile)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SourceImageError('missing')
        throw err
      }
      throw new SourceImageError('corrupt')
    },
    async readSource(filePath) {
      const resolved = path.resolve(filePath)
      if (path.extname(resolved).toLowerCase() !== '.png'
        || !roots().some((root) => inside(path.resolve(root), resolved))) {
        throw new SourceImageError('corrupt')
      }
      let bytes: Buffer
      try {
        const realFile = await fs.realpath(resolved)
        let managed = false
        for (const root of roots()) {
          if (!inside(path.resolve(root), resolved)) continue
          if (inside(await fs.realpath(root), realFile)) { managed = true; break }
        }
        if (!managed) throw new SourceImageError('corrupt')
        bytes = await fs.readFile(realFile)
      } catch (err) {
        if (err instanceof SourceImageError) throw err
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SourceImageError('missing')
        throw err
      }
      if (!validPng(bytes)) {
        throw new SourceImageError('corrupt')
      }
      return bytes.toString('base64')
    },
    async save(pngBase64, name) {
      const root = dir()
      let filePath = ''
      let thumbPath = ''
      let pngCreated = false
      let thumbCreated = false
      try {
        const png = Buffer.from(pngBase64.replace(DATA_URL_PREFIX, ''), 'base64')
        const fileDir = path.join(root, monthFolder(name.createdAt))
        const thumbDir = path.join(root, 'thumbs')
        await fs.mkdir(fileDir, { recursive: true })
        await fs.mkdir(thumbDir, { recursive: true })
        const realRoot = await fs.realpath(root)
        if (!inside(realRoot, await fs.realpath(fileDir)) || !inside(realRoot, await fs.realpath(thumbDir))) throw new SourceImageError('corrupt')
        // A name left by a crash before its row was stored is not overwritten: the next free suffix is used.
        for (let n = 0; ; n++) {
          const base = `${name.jobId}-${name.seed}${n === 0 ? '' : `-${n}`}`
          filePath = path.join(fileDir, `${base}.png`)
          thumbPath = path.join(thumbDir, `${base}.jpg`)
          try {
            await fs.writeFile(filePath, png, { flag: 'wx' })
            pngCreated = true
            break
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 999) throw err
          }
        }
        const { thumb, width, height } = makeThumb(png)
        await fs.writeFile(thumbPath, thumb, { flag: 'wx' })
        thumbCreated = true
        return { filePath, thumbPath, width, height }
      } catch (err) {
        if (pngCreated) await removeOne(filePath).catch(() => undefined)
        if (thumbCreated) await removeOne(thumbPath).catch(() => undefined)
        throw err
      }
    },
    remove,
  }
}
