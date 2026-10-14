import * as Menu from '@radix-ui/react-dropdown-menu'
import { CaretDown, Check } from '@phosphor-icons/react'
import { useEffect, useId, useRef, type RefObject } from 'react'
import styles from './Select.module.css'

/** `group` labels the group the option belongs to; consecutive options with the same group form one group. */
export type SelectOption = { value: string; label: string; group?: string }

type SelectProps = {
  value: string
  options: SelectOption[]
  onChange(value: string): void
  label: string
  /** False keeps the label for assistive tech only, for a row that already shows it. */
  showLabel?: boolean
  /** Takes the remaining width of a flex row and ellipsizes the value; the full value is the tooltip. */
  grow?: boolean
}

/** Distance the menu keeps from the window edges; equals --sp-2. */
const COLLISION_PADDING = 8

type Run = { group: string | undefined; options: SelectOption[] }

function runs(options: SelectOption[]): Run[] {
  const out: Run[] = []
  for (const option of options) {
    const last = out[out.length - 1]
    if (last && last.group === option.group) last.options.push(option)
    else out.push({ group: option.group, options: [option] })
  }
  return out
}

function Item({ option }: { option: SelectOption }) {
  return (
    <Menu.RadioItem value={option.value} className={styles.item}>
      <span className={styles.itemLabel}>{option.label}</span>
      <Menu.ItemIndicator className={styles.indicator}>
        <Check size={16} weight="regular" aria-hidden />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  )
}

/**
 * Mounted with the menu: moves focus to the checked option and scrolls it into view, so a long
 * list opens where the value is. Runs a frame later, after Radix's own open focus and after the
 * menu is positioned (its height cap depends on the position).
 */
function FocusChecked({ content }: { content: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const checked = content.current?.querySelector<HTMLElement>('[role="menuitemradio"][data-state="checked"]')
      if (!checked) return
      checked.focus({ preventScroll: true })
      checked.scrollIntoView?.({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [content])
  return null
}

function Group({ run }: { run: Run }) {
  const labelId = useId()
  return (
    <Menu.Group aria-labelledby={labelId}>
      <Menu.Label id={labelId} className={styles.groupLabel}>
        {run.group}
      </Menu.Label>
      {run.options.map((option) => (
        <Item key={option.value} option={option} />
      ))}
    </Menu.Group>
  )
}

export function Select({ value, options, onChange, label, showLabel = true, grow = false }: SelectProps) {
  const current = options.find((option) => option.value === value)
  const shown = current?.label ?? value
  const content = useRef<HTMLDivElement>(null)

  return (
    <Menu.Root>
      <Menu.Trigger
        className={grow ? `${styles.trigger} ${styles.grow}` : styles.trigger}
        title={grow ? shown : undefined}
      >
        <span className={showLabel ? styles.label : 'sr-only'}>{label}</span>
        <span className={styles.value}>{shown}</span>
        <CaretDown size={16} aria-hidden className={styles.caret} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={content}
          className={styles.content}
          align="start"
          sideOffset={4}
          collisionPadding={COLLISION_PADDING}
        >
          <FocusChecked content={content} />
          <Menu.RadioGroup value={value} onValueChange={onChange}>
            {runs(options).map((run, index) =>
              run.group === undefined ? (
                run.options.map((option) => <Item key={option.value} option={option} />)
              ) : (
                <Group key={`${index}:${run.group}`} run={run} />
              ),
            )}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
