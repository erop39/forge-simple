import * as Menu from '@radix-ui/react-dropdown-menu'
import { CaretDown } from '@phosphor-icons/react'
import styles from './Select.module.css'

type SelectProps = {
  value: string
  options: { value: string; label: string }[]
  onChange(value: string): void
  label: string
}

export function Select({ value, options, onChange, label }: SelectProps) {
  const current = options.find((option) => option.value === value)
  return (
    <Menu.Root>
      <Menu.Trigger className={styles.trigger}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{current?.label ?? value}</span>
        <CaretDown size={16} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={styles.content} align="start" sideOffset={4}>
          <Menu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <Menu.RadioItem key={option.value} value={option.value} className={styles.item}>
                {option.label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
