import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import styles from './IconButton.module.css'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string
  icon: ReactNode
}

export function IconButton({ label, icon, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <Tooltip text={label}>
      <button type={type} aria-label={label} className={[styles.button, className].filter(Boolean).join(' ')} {...rest}>
        {icon}
      </button>
    </Tooltip>
  )
}
