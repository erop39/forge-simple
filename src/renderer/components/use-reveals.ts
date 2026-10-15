import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { GalleryItem } from '../state/gallery-items'

/** Previews kept for jobs that may still turn into images (cancelled and failed jobs leave theirs behind). */
const KEPT_PREVIEWS = 8

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The job → image crossfade. Remembers the last live preview of every running job; when an image of such a
 * job appears, it is returned in `reveals` (image id → preview) until `done(id)` is called, so its tile can
 * fade the picture in over the preview. Images of jobs never seen running (older pages, earlier sessions)
 * and every image under reduced motion appear at once. Runs as a layout effect, so the new tile never paints
 * a frame without its preview.
 */
export function useReveals(items: readonly GalleryItem[]) {
  const previews = useRef(new Map<number, string>())
  const [reveals, setReveals] = useState<ReadonlyMap<number, string>>(new Map())

  useLayoutEffect(() => {
    const seen = previews.current
    const found: [number, string][] = []
    for (const item of items) {
      if (item.kind === 'job') {
        const preview = item.progress?.preview
        if (item.job.status === 'running' && preview) {
          seen.delete(item.job.id)
          seen.set(item.job.id, preview)
        }
        continue
      }
      const preview = seen.get(item.image.jobId)
      if (preview === undefined) continue
      seen.delete(item.image.jobId)
      if (!item.image.locked && !reducedMotion()) found.push([item.image.id, preview])
    }
    for (const id of seen.keys()) if (seen.size > KEPT_PREVIEWS) seen.delete(id)
    if (found.length > 0) setReveals((current) => new Map([...current, ...found]))
  }, [items])

  const done = useCallback((id: number) => {
    setReveals((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])

  return { reveals, done }
}
