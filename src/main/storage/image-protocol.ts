import { promises as fs } from 'node:fs'
import path from 'node:path'

const PREFIX = 'fnc-img://local'
// Scheme and host are matched on the raw string: `new URL` would collapse "/../" segments
// before they could be rejected.
const REQUEST = /^fnc-img:\/\/local(\/[^?#]*)?(?:[?#].*)?$/

/** Builds `fnc-img://local/<path relative to baseDir>` with forward slashes and encoded segments. */
export function toImageUrl(absPath: string, baseDir: string): string {
  const rel = path.relative(baseDir, absPath)
  return `${PREFIX}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`
}

/** Maps an image URL to an absolute path inside baseDir, or null when it is not a safe local image URL. */
export function resolveImageRequest(url: string, baseDir: string): string | null {
  const match = REQUEST.exec(url)
  if (!match || match[1] === undefined) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return null
  }
  for (const segment of decoded.split('/')) {
    if (segment === '..' || /[\\:\u0000]/.test(segment)) return null
    // Windows opens "a.png." and "a.png " as "a.png", and "NAME~1.PNG" as the long name: such another spelling
    // of a file would get past the hidden-file check, so these names are refused (the store never writes them).
    if (segment.includes('~') || /[. ]$/.test(segment)) return null
  }
  const base = path.resolve(baseDir)
  const resolved = path.resolve(base, `.${decoded}`)
  return resolved.startsWith(base + path.sep) ? resolved : null
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
const RECORD_REQUEST = /^fnc-img:\/\/local\/(image|thumb)\/([1-9]\d*)$/

/** Stable URLs survive changes to the folder for future images; the database resolves each ID. */
export function toRecordImageUrl(id: number, kind: 'image' | 'thumb'): string {
  return `${PREFIX}/${kind}/${id}`
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export interface ImageHandlerDeps {
  baseDir(): string
  /** True when the file (relative to baseDir, OS separators) must not be served now: a hidden image while locked. */
  isBlocked(relPath: string): boolean
  /** True for a file of a hidden image: served (while open) without being cached. */
  isHidden?(relPath: string): boolean
  /** Production URLs resolve a DB image ID and check every stored path against approved folders. */
  lookupImage?(id: number): { filePath: string; thumbPath: string; hidden: boolean } | null
  roots?(): string[]
  lockOpen?(): boolean
}

/**
 * The `fnc-img` protocol: 403 for an unsafe address or a non-image file, 404 for a missing file and for a file
 * the lock blocks (the same answer, so a blocked file cannot be told from a missing one). A hidden image's file
 * served while the lock is open carries `Cache-Control: no-store`.
 */
export function createImageHandler(deps: ImageHandlerDeps): (url: string) => Promise<Response> {
  return async (url) => {
    if (deps.lookupImage) {
      const match = RECORD_REQUEST.exec(url)
      if (!match) return new Response(null, { status: 403 })
      const row = deps.lookupImage(Number(match[2]))
      if (!row || (row.hidden && !deps.lockOpen?.())) return new Response(null, { status: 404 })
      const file = match[1] === 'image' ? row.filePath : row.thumbPath
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()]
      if (!type) return new Response(null, { status: 403 })
      let realFile: string
      try { realFile = await fs.realpath(file) }
      catch { return new Response(null, { status: 404 }) }
      let allowed = false
      for (const root of deps.roots?.() ?? [deps.baseDir()]) {
        if (!inside(path.resolve(root), path.resolve(file))) continue
        try {
          if (inside(await fs.realpath(root), realFile)) { allowed = true; break }
        } catch { /* the old volume may be offline */ }
      }
      if (!allowed) return new Response(null, { status: 404 })
      const headers: Record<string, string> = { 'Content-Type': type }
      if (row.hidden) headers['Cache-Control'] = 'no-store'
      try { return new Response(new Uint8Array(await fs.readFile(realFile)), { headers }) }
      catch { return new Response(null, { status: 404 }) }
    }
    const base = deps.baseDir()
    const file = resolveImageRequest(url, base)
    const type = file ? IMAGE_TYPES[path.extname(file).toLowerCase()] : undefined
    if (!file || !type) return new Response(null, { status: 403 })
    const rel = path.relative(path.resolve(base), file)
    if (deps.isBlocked(rel)) return new Response(null, { status: 404 })
    const headers: Record<string, string> = { 'Content-Type': type }
    if (deps.isHidden?.(rel)) headers['Cache-Control'] = 'no-store'
    try {
      return new Response(new Uint8Array(await fs.readFile(file)), { headers })
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return new Response(null, { status: missing ? 404 : 500 })
    }
  }
}

/**
 * Same file, ignoring how the path was written: both sides are resolved (separators, `.`/`..`, a trailing
 * separator in the images folder) and compared without letter case in any script (Windows and macOS file
 * names are case-insensitive).
 */
const fileKey = (p: string): string => path.resolve(p).toLowerCase()

/** Which requested files belong to hidden images, and which of them the closed lock blocks. */
export function hiddenImageAccess(
  images: { hiddenFilePaths(): string[] },
  lock: { isOpen(): boolean },
  baseDir: () => string,
): { isHidden(relPath: string): boolean; isBlocked(relPath: string): boolean } {
  const isHidden = (relPath: string): boolean => {
    const wanted = fileKey(path.join(path.resolve(baseDir()), relPath))
    return images.hiddenFilePaths().some((stored) => fileKey(stored) === wanted)
  }
  return { isHidden, isBlocked: (relPath) => !lock.isOpen() && isHidden(relPath) }
}
