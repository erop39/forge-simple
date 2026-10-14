import { useEffect, useRef, useState } from 'react'

/** Small pixel deltas (a trackpad) add up to one step per this many pixels. */
export const WHEEL_PX_PER_STEP = 100
/** A pixel delta at least this large is one mouse-wheel notch on its own. */
export const NOTCH_MIN_PX = 50
/** Shift+wheel moves this many steps per notch. */
export const SHIFT_STEPS = 10

export type WheelBounds = { min: number; max: number; step: number; multipleOf?: number | undefined }

/** Strips float noise such as 7.000000001 from repeated decimal steps. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * The value after `steps` steps (negative: down), clamped to the bounds and on a multiple of `multipleOf`.
 * A value already outside the bounds never moves the wrong way: wheel up above max stays put.
 */
export function wheelValue(value: number, steps: number, { min, max, step, multipleOf }: WheelBounds): number {
  let next = tidy(value + steps * step)
  if (multipleOf !== undefined) {
    next = Math.round(next / multipleOf) * multipleOf
    // Clamping must not leave a value that is not a multiple.
    if (next > max) next = Math.floor(max / multipleOf) * multipleOf
    if (next < min) next = Math.ceil(min / multipleOf) * multipleOf
  } else {
    next = Math.min(max, Math.max(min, next))
  }
  if ((steps > 0 && next < value) || (steps < 0 && next > value)) return value
  return next
}

type WheelStepOptions = WheelBounds & { value: number; onCommit(value: number): void }

/**
 * Changes a value with the mouse wheel while the pointer is over the element given to the returned callback
 * ref (no focus needed): up adds a step, down removes one, Shift moves SHIFT_STEPS. A discrete wheel event
 * (line or page mode, or a pixel delta of a notch's size) is exactly one notch; small pixel deltas from a
 * trackpad add up to one step per WHEEL_PX_PER_STEP. The page never scrolls under a handled wheel, also at a
 * bound. React's onWheel is passive, so a native listener is attached to be able to preventDefault; the
 * callback ref re-attaches it when the element is replaced.
 */
export function useWheelStep(options: WheelStepOptions): (el: HTMLElement | null) => void {
  const latest = useRef(options)
  latest.current = options
  const [el, setEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!el) return
    let travel = 0
    function onWheel(event: WheelEvent): void {
      // Chromium turns Shift+wheel into horizontal scrolling: read deltaX then.
      const raw = event.deltaY !== 0 ? event.deltaY : event.shiftKey ? event.deltaX : 0
      if (raw === 0) return
      event.preventDefault()
      let notches: number
      if (event.deltaMode !== 0 || Math.abs(raw) >= NOTCH_MIN_PX) {
        travel = 0
        notches = Math.sign(raw)
      } else {
        if (travel !== 0 && Math.sign(raw) !== Math.sign(travel)) travel = 0
        travel += raw
        notches = Math.trunc(travel / WHEEL_PX_PER_STEP)
        travel -= notches * WHEEL_PX_PER_STEP
      }
      if (notches === 0) return
      const o = latest.current
      // Wheel up (negative delta) increases the value.
      const next = wheelValue(o.value, -notches * (event.shiftKey ? SHIFT_STEPS : 1), o)
      if (next !== o.value) o.onCommit(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el])

  return setEl
}
