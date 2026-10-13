import * as Menu from '@radix-ui/react-dropdown-menu'
import { CaretDown, Check } from '@phosphor-icons/react'
import styles from './Select.module.css'

type SelectProps = {
  value: string
  options: { value: string; label: string }[]
  onChange(value: string): void
  label: string
  /** False keeps the label for assistive tech only, for a row that already shows it. */
  showLabel?: boolean
}

export function Select({ value, options, onChange, label, showLabel = true }: SelectProps) {
  const current = options.find((option) => option.value === value)
  return (
    <Menu.Root>
      <Menu.Trigger className={styles.trigger}>
        <span className={showLabel ? styles.label : 'sr-only'}>{label}</span>
        <span className={styles.value}>{current?.label ?? value}</span>
        <CaretDown size={16} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={styles.content} align="start" sideOffset={4}>
          <Menu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <Menu.RadioItem key={option.value} value={option.value} className={styles.item}>
                <span className={styles.itemLabel}>{option.label}</span>
                <Menu.ItemIndicator className={styles.indicator}>
                  <Check size={16} weight="regular" aria-hidden />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
