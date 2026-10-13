import type { ReactNode } from 'react'
import styles from './ParamRow.module.css'

type ParamRowProps = { label: string; children: ReactNode }

export function ParamRow({ label, children }: ParamRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  )
}
