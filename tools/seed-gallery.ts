/**
 * Fills a throwaway user-data folder with fictional finished images, for checking the gallery with many
 * tiles in the real window. Never point it at a real profile.
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/tsx/dist/cli.mjs \
 *     tools/seed-gallery.ts <user-data-dir> [count=400] [server-url=http://127.0.0.1:7861]
 *
 * It runs under Electron-as-Node so better-sqlite3 has the app's ABI. Each image is a small solid-colour
 * PNG with one of several aspect ratios; the same file serves as its thumbnail.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { defaultParams } from '../src/shared/profiles'
import { openDb } from '../src/main/storage/db'
import { createRepos } from '../src/main/storage/repos'

const [dir, countArg = '400', serverUrl = 'http://127.0.0.1:7861'] = process.argv.slice(2)
if (!dir) {
  console.error('usage: seed-gallery.ts <user-data-dir> [count] [server-url]')
  process.exit(1)
}
const count = Number(countArg)

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A solid-colour RGB PNG of `width` × `height`. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Generation sizes (width, height) the fictional images cycle through. */
const SIZES: [number, number][] = [[832, 1216], [1024, 1024], [1216, 832], [896, 1152], [768, 1344], [1344, 768]]

const db = openDb(join(dir, 'forge-neo-client.db'))
let clock = Date.now() - count * 60_000
const repos = createRepos(db, () => clock)
const server = repos.servers.list().find((s) => s.url === serverUrl) ?? repos.servers.add('Mock', serverUrl)
repos.servers.activate(server.id)
const imagesDir = join(dir, 'images')
mkdirSync(join(imagesDir, 'seed'), { recursive: true })

for (let i = 0; i < count; i++) {
  clock += 60_000
  const [width, height] = SIZES[i % SIZES.length]!
  const base = defaultParams('sdxl', 'exampleMix_v10.safetensors', { samplers: [], schedulers: [] })
  // A prompt, so the viewer's saved-settings check accepts the job.
  const params = { ...base, prompt: `seeded image ${i + 1}`, width, height }
  const job = repos.jobs.insert(server.id, 'txt2img', params)
  repos.jobs.setStatus(job.id, 'done', { durationMs: 20_000 })
  const hue = (i * 47) % 360
  const colour: [number, number, number] = [
    Math.round(127 + 100 * Math.cos((hue * Math.PI) / 180)),
    Math.round(127 + 100 * Math.cos(((hue - 120) * Math.PI) / 180)),
    Math.round(127 + 100 * Math.cos(((hue + 120) * Math.PI) / 180)),
  ]
  const file = join(imagesDir, 'seed', `${job.id}.png`)
  writeFileSync(file, solidPng(Math.round(width / 16), Math.round(height / 16), colour))
  repos.images.insert({
    jobId: job.id, filePath: file, thumbPath: file, width, height, seed: i, infotext: '', durationMs: 20_000,
  })
}
db.close()
console.log(`seeded ${count} images into ${dir}`)
