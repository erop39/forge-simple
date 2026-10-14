import { useCallback, useEffect, useRef, useState } from 'react'

export const UNDO_WINDOW_MS = 5000

type Pending = { id: number; timer: ReturnType<typeof setTimeout> }

/**
 * Delete with undo. `request(id)` hides the image at once and commits the deletion after the undo window;
 * `undo()` brings it back. A second request commits the first one immediately, and so does unmounting.
 * An image stays hidden while its deletion is in flight and reappears if the deletion fails.
 */
export function usePendingDelete(commit: (id: number) => Promise<void>) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())
  const [toastOpen, setToastOpen] = useState(false)
  const pending = useRef<Pending | null>(null)
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })

  const run = useCallback((id: number): void => {
    void commitRef.current(id).finally(() =>
      setHidden((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      }),
    )
  }, [])

  const flush = useCallback((): void => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    run(p.id)
  }, [run])

  const request = useCallback(
    (id: number): void => {
      flush()
      const timer = setTimeout(() => {
        pending.current = null
        setToastOpen(false)
        run(id)
      }, UNDO_WINDOW_MS)
      pending.current = { id, timer }
      setHidden((s) => new Set(s).add(id))
      setToastOpen(true)
    },
    [flush, run],
  )

  const undo = useCallback((): void => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    setToastOpen(false)
    setHidden((s) => {
      const next = new Set(s)
      next.delete(p.id)
      return next
    })
  }, [])

  useEffect(() => flush, [flush])

  return { hidden, toastOpen, request, undo }
}
