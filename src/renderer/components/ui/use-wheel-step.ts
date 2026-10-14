import { useEffect, useRef, type RefObject } from 'react'

/** Wheel distance (px) per step: one mouse notch on Windows; a trackpad needs a full notch's worth of travel. */
export const WHEEL_PX_PER_STEP = 100
/** Shift+wheel moves this many steps per notch. */
export const SHIFT_STEPS = 10
/** Pixels per wheel unit for DOM_DELTA_LINE (3 lines per notch) and DOM_DELTA_PAGE. */
const LINE_PX = WHEEL_PX_PER_STEP / 3
const PAGE_PX = WHEEL_PX_PER_STEP

export type WheelBounds = { min: number; max: number; step: number; multipleOf?: number | undefined }

/** Strips float noise such as 7.000000001 from repeated decimal steps. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6

/** The value after `steps` steps (negative: down), clamped to the bounds and on a multiple of `multipleOf`. */
export function wheelValue(value: number, steps: number, { min, max, step, multipleOf }: WheelBounds): number {
  let next = tidy(value + steps * step)
  if (multipleOf !== undefined) {
    next = Math.round(next / multipleOf) * multipleOf
    // Clamping must not leave a value that is not a multiple.
    if (next > max) next = Math.floor(max / multipleOf) * multipleOf
    if (next < min) next = Math.ceil(min / multipleOf) * multipleOf
    return next
  }
  return Math.min(max, Math.max(min, next))
}

type WheelStepOptions = WheelBounds & { value: number; onCommit(value: number): void }

/**
 * Changes a value with the mouse wheel while the pointer is over `target` (no focus needed): up adds a step,
 * down removes one, Shift moves SHIFT_STEPS. The page never scrolls under a handled wheel, also at a bound.
 * React's onWheel is passive, so a native listener is attached to be able to preventDefault.
 */
export function useWheelStep(target: RefObject<HTMLElement | null>, options: WheelStepOptions): void {
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const el = target.current
    if (!el) return
    let travel = 0
    function onWheel(event: WheelEvent): void {
      // Chromium turns Shift+wheel into horizontal scrolling: read deltaX then.
      const raw = event.deltaY !== 0 ? event.deltaY : event.shiftKey ? event.deltaX : 0
      if (raw === 0) return
      event.preventDefault()
      const px = event.deltaMode === 1 ? raw * LINE_PX : event.deltaMode === 2 ? raw * PAGE_PX : raw
      if (travel !== 0 && Math.sign(px) !== Math.sign(travel)) travel = 0
      travel += px
      const notches = Math.trunc(travel / WHEEL_PX_PER_STEP)
      if (notches === 0) return
      travel -= notches * WHEEL_PX_PER_STEP
      const o = latest.current
      // Wheel up (negative delta) increases the value.
      const next = wheelValue(o.value, -notches * (event.shiftKey ? SHIFT_STEPS : 1), o)
      if (next !== o.value) o.onCommit(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [target])
}
