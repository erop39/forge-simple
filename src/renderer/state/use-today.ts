import { useEffect, useState } from 'react'

/**
 * A moment of the current local day, renewed just after each midnight so day-relative labels
 * ("14:03" vs "Oct 13, 14:03") switch over. One timer per caller; the gallery calls it once for all tiles.
 */
export function useToday(): number {
  const [today, setToday] = useState(() => Date.now())
  useEffect(() => {
    const d = new Date(today)
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    const timer = setTimeout(() => setToday(Date.now()), Math.max(1000, nextMidnight - Date.now() + 1000))
    return () => clearTimeout(timer)
  }, [today])
  return today
}
