import { promises as fs } from 'node:fs'
import path from 'node:path'

export type MakeThumb = (png: Buffer) => { thumb: Buffer; width: number; height: number }

export interface SavedImage { filePath: string; thumbPath: string; width: number; height: number }

const DATA_URL_PREFIX = /^data:image\/[^;,]+;base64,/i

function monthFolder(createdAt: number): string {
  const d = new Date(createdAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function createImageStore(dir: () => string, makeThumb: MakeThumb): {
  save(pngBase64: string, name: { jobId: number; seed: number; createdAt: number }): Promise<SavedImage>
  remove(filePath: string, thumbPath: string): Promise<void>
} {
  async function remove(filePath: string, thumbPath: string): Promise<void> {
    await Promise.all([fs.rm(filePath, { force: true }), fs.rm(thumbPath, { force: true })])
  }

  return {
    async save(pngBase64, name) {
      const root = dir()
      const base = `${name.jobId}-${name.seed}`
      const filePath = path.join(root, monthFolder(name.createdAt), `${base}.png`)
      const thumbPath = path.join(root, 'thumbs', `${base}.jpg`)
      try {
        const png = Buffer.from(pngBase64.replace(DATA_URL_PREFIX, ''), 'base64')
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.mkdir(path.dirname(thumbPath), { recursive: true })
        await fs.writeFile(filePath, png)
        const { thumb, width, height } = makeThumb(png)
        await fs.writeFile(thumbPath, thumb)
        return { filePath, thumbPath, width, height }
      } catch (err) {
        await remove(filePath, thumbPath).catch(() => undefined)
        throw err
      }
    },
    remove,
  }
}
