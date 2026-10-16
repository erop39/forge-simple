import * as Menu from '@radix-ui/react-dropdown-menu'
import { CaretDown, Check } from '@phosphor-icons/react'
import styles from './Select.module.css'

export type MultiSelectOption = { value: string; label: string }

type MultiSelectProps = {
  values: string[]
  options: MultiSelectOption[]
  onChange(values: string[]): void
  label: string
  /** What the trigger shows for the current choice (for example "Any" when nothing is checked). */
  summary: string
  /** Text of the row that unchecks everything; shown only while something is checked. */
  clearLabel: string
}

/** A menu in which several options can be checked at once; the menu stays open while the user ticks them. */
export function MultiSelect({ values, options, onChange, label, summary, clearLabel }: MultiSelectProps) {
  return (
    <Menu.Root>
      <Menu.Trigger className={styles.trigger} title={summary}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{summary}</span>
        <CaretDown size={16} aria-hidden className={styles.caret} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={styles.content} align="start" sideOffset={4} collisionPadding={8}>
          {values.length > 0 && (
            <>
              <Menu.Item className={styles.item} onSelect={() => onChange([])}>
                <span className={styles.itemLabel}>{clearLabel}</span>
              </Menu.Item>
              <Menu.Separator className={styles.groupLabel} />
            </>
          )}
          {options.map((option) => (
            <Menu.CheckboxItem
              key={option.value}
              className={styles.item}
              checked={values.includes(option.value)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onChange(checked ? [...values, option.value] : values.filter((v) => v !== option.value))}
            >
              <span className={styles.itemLabel}>{option.label}</span>
              <Menu.ItemIndicator className={styles.indicator}>
                <Check size={16} weight="regular" aria-hidden />
              </Menu.ItemIndicator>
            </Menu.CheckboxItem>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
