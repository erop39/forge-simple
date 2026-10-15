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

export interface ImageHandlerDeps {
  baseDir(): string
  /** True when the file (relative to baseDir, OS separators) must not be served now: a hidden image while locked. */
  isBlocked(relPath: string): boolean
}

/**
 * The `fnc-img` protocol: 403 for an unsafe address or a non-image file, 404 for a missing file and for a file
 * the lock blocks (the same answer, so a blocked file cannot be told from a missing one).
 */
export function createImageHandler(deps: ImageHandlerDeps): (url: string) => Promise<Response> {
  return async (url) => {
    const base = deps.baseDir()
    const file = resolveImageRequest(url, base)
    const type = file ? IMAGE_TYPES[path.extname(file).toLowerCase()] : undefined
    if (!file || !type) return new Response(null, { status: 403 })
    if (deps.isBlocked(path.relative(path.resolve(base), file))) return new Response(null, { status: 404 })
    try {
      return new Response(new Uint8Array(await fs.readFile(file)), { headers: { 'Content-Type': type } })
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      return new Response(null, { status: missing ? 404 : 500 })
    }
  }
}

/** Blocks the files (full image and thumbnail) of hidden images while the lock is closed. */
export function hiddenImageBlocker(
  images: { isHiddenFile(absPath: string): boolean },
  lock: { isOpen(): boolean },
  baseDir: () => string,
): (relPath: string) => boolean {
  return (relPath) => !lock.isOpen() && images.isHiddenFile(path.join(path.resolve(baseDir()), relPath))
}
