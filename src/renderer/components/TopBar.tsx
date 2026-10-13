import { GearSix } from '@phosphor-icons/react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { IconButton } from './ui/IconButton'
import { ConnectionChip } from './ConnectionChip'
import styles from './TopBar.module.css'

export function TopBar({ onOpenServer }: { onOpenServer: () => void }) {
  const connection = useAppStore((s) => s.connection)
  return (
    <header className={styles.bar}>
      <ConnectionChip status={connection} onClick={onOpenServer} className={styles.noDrag} />
      <IconButton
        label={t('topbar.settings')}
        icon={<GearSix size={20} />}
        onClick={onOpenServer}
        className={`${styles.noDrag} ${styles.end}`}
      />
    </header>
  )
}
