import { useState, type KeyboardEvent } from 'react'
import { useWheelStep } from './use-wheel-step'
import styles from './NumberField.module.css'

type NumberFieldProps = {
  label: string
  value: number
  min: number
  max: number
  /** Arrow Up/Down increment. */
  step?: number
  integer?: boolean
  /** Only multiples of this value are valid. */
  multipleOf?: number
  onCommit(value: number): void
  /** Shows the label inside the field instead of leaving it to the surrounding row. */
  inline?: boolean
}

const INTEGER = /^\d+$/
const DECIMAL = /^\d+(\.\d+)?$/

/**
 * Commits every valid edit at once; an invalid draft is never committed and is dropped on blur.
 * The mouse wheel over the field steps the value (Shift: ten steps), staying on `multipleOf`.
 */
export function NumberField({
  label, value, min, max, step = 1, integer = true, multipleOf, onCommit, inline = false,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const wrapper = useWheelStep({
    value, min, max, step, multipleOf,
    onCommit: (next) => {
      setDraft(null)
      onCommit(next)
    },
  })

  const valid = (n: number): boolean =>
    n >= min && n <= max && (multipleOf === undefined || n % multipleOf === 0)

  function edit(text: string): void {
    setDraft(text)
    const trimmed = text.trim()
    if (!(integer ? INTEGER : DECIMAL).test(trimmed)) return
    const n = Number(trimmed)
    if (valid(n)) onCommit(n)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const direction = event.key === 'ArrowUp' ? 1 : -1
    const next = Math.round((value + direction * step) * 100) / 100
    setDraft(null)
    if (next >= min && next <= max) onCommit(next)
  }

  const input = (
    <input
      ref={inline ? undefined : wrapper}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      role="spinbutton"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`mono ${styles.input}`}
      value={draft ?? String(value)}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => edit(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => setDraft(null)}
    />
  )
  if (!inline) return input
  return (
    <label ref={wrapper} className={styles.inline}>
      <span className={styles.label}>{label}</span>
      {input}
    </label>
  )
}
