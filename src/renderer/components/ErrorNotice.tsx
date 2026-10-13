import { WarningCircle, X } from '@phosphor-icons/react'
import { t } from '../i18n/t'
import { IconButton } from './ui/IconButton'
import styles from './ErrorNotice.module.css'

type ErrorNoticeProps = { text: string; onDismiss: () => void }

export function ErrorNotice({ text, onDismiss }: ErrorNoticeProps) {
  return (
    <div role="alert" className={styles.notice}>
      <WarningCircle size={20} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>{text}</span>
      <IconButton label={t('notice.dismiss')} icon={<X size={16} />} onClick={onDismiss} />
    </div>
  )
}
