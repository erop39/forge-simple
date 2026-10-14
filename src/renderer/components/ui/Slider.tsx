import * as RadixSlider from '@radix-ui/react-slider'
import { useRef } from 'react'
import { useWheelStep } from './use-wheel-step'
import styles from './Slider.module.css'

type SliderProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Called on every change (live); values are always within bounds and on a step. */
  onCommit(value: number): void
  /** Shows the label inside a bordered control instead of leaving it to the surrounding row. */
  inline?: boolean
}

/**
 * A horizontal slider with the current value as a mono readout. Keyboard per Radix: arrows, PageUp/PageDown,
 * Home/End; the mouse wheel over it steps the value (Shift: ten steps).
 */
export function Slider({ label, value, min, max, step, onCommit, inline = false }: SliderProps) {
  const wrapper = useRef<HTMLSpanElement>(null)
  useWheelStep(wrapper, { value, min, max, step, onCommit })
  const slider = (
    <>
      <RadixSlider.Root
        className={styles.root}
        // A stored value outside the range (e.g. older steps > max) keeps its readout; the thumb clamps.
        value={[Math.min(max, Math.max(min, value))]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => {
          if (next !== undefined && next !== value) onCommit(next)
        }}
      >
        <RadixSlider.Track className={styles.track}>
          <RadixSlider.Range className={styles.range} />
        </RadixSlider.Track>
        <RadixSlider.Thumb className={styles.thumb} aria-label={label} />
      </RadixSlider.Root>
      <span className={`mono ${styles.readout}`} aria-hidden="true">
        {value}
      </span>
    </>
  )
  if (!inline) return <span ref={wrapper} className={styles.plain}>{slider}</span>
  return (
    <span ref={wrapper} className={styles.inline}>
      <span className={styles.label} aria-hidden="true">
        {label}
      </span>
      {slider}
    </span>
  )
}
