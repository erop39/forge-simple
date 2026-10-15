import { GearSix, Scroll } from '@phosphor-icons/react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { IconButton } from './ui/IconButton'
import { ConnectionChip } from './ConnectionChip'
import { LockButton } from './LockButton'
import { LOG_TOGGLE_ID } from './LogPanel'
import styles from './TopBar.module.css'

export function TopBar({ onOpenServer }: { onOpenServer: () => void }) {
  const connection = useAppStore((s) => s.connection)
  const noServer = useAppStore((s) => s.settings !== null && !s.settings.serverUrl)
  const serverName = useAppStore((s) => s.servers.find((server) => server.active)?.name ?? null)
  const logOpen = useAppStore((s) => s.logOpen)
  const toggleLog = useAppStore((s) => s.toggleLog)
  return (
    <header className={styles.bar}>
      <ConnectionChip
        status={noServer ? null : connection}
        serverName={noServer ? null : serverName}
        onClick={onOpenServer}
        className={styles.noDrag}
      />
      <LockButton className={`${styles.noDrag} ${styles.end}`} />
      <IconButton
        id={LOG_TOGGLE_ID}
        label={t('topbar.log')}
        icon={<Scroll size={20} />}
        aria-expanded={logOpen}
        onClick={toggleLog}
        className={styles.noDrag}
      />
      <IconButton
        label={t('topbar.settings')}
        icon={<GearSix size={20} />}
        onClick={onOpenServer}
        className={styles.noDrag}
      />
    </header>
  )
}
