import { WarningCircle, X } from '@phosphor-icons/react'
import { t } from '../../i18n/t'
import { Button } from './Button'
import { IconButton } from './IconButton'
import styles from './Notice.module.css'

type NoticeProps = {
  text: string
  action?: { label: string; onClick: () => void }
  onDismiss?: () => void
}

/** An inline alert: text, an optional action button and an optional dismiss button. */
export function Notice({ text, action, onDismiss }: NoticeProps) {
  return (
    <div role="alert" className={styles.notice}>
      <WarningCircle size={20} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>{text}</span>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
      {onDismiss && <IconButton label={t('notice.dismiss')} icon={<X size={16} />} onClick={onDismiss} />}
    </div>
  )
}
