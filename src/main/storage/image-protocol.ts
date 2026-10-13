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
  }
  const base = path.resolve(baseDir)
  const resolved = path.resolve(base, `.${decoded}`)
  return resolved.startsWith(base + path.sep) ? resolved : null
}
