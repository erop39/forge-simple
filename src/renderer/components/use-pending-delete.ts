import { useCallback, useEffect, useRef, useState } from 'react'

export const UNDO_WINDOW_MS = 5000

type Pending = { ids: number[]; timer: ReturnType<typeof setTimeout> }

/**
 * Delete with undo. `request(ids)` hides the images at once and commits the deletion after the undo window;
 * `undo()` brings them back. A second request commits the first one immediately, and so does unmounting.
 * Images stay hidden while their deletion is in flight and reappear if it fails (the ones that could not be removed).
 */
export function usePendingDelete(commit: (ids: number[]) => Promise<void>) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())
  const [toastCount, setToastCount] = useState(0)
  const pending = useRef<Pending | null>(null)
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })

  const forget = useCallback((ids: number[]): void => {
    setHidden((s) => {
      const next = new Set(s)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const run = useCallback((ids: number[]): void => {
    void commitRef.current(ids).finally(() => forget(ids))
  }, [forget])

  const flush = useCallback((): void => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    run(p.ids)
  }, [run])

  const request = useCallback(
    (input: number | number[]): void => {
      const ids = Array.isArray(input) ? input : [input]
      if (ids.length === 0) return
      flush()
      const timer = setTimeout(() => {
        pending.current = null
        setToastCount(0)
        run(ids)
      }, UNDO_WINDOW_MS)
      pending.current = { ids, timer }
      setHidden((s) => new Set([...s, ...ids]))
      setToastCount(ids.length)
    },
    [flush, run],
  )

  const undo = useCallback((): void => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    setToastCount(0)
    forget(p.ids)
  }, [forget])

  useEffect(() => flush, [flush])

  return { hidden, toastOpen: toastCount > 0, toastCount, request, undo }
}
