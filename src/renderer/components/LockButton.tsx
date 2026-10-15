import { LockSimple, LockSimpleOpen } from '@phosphor-icons/react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { IconButton } from './ui/IconButton'

/**
 * The lock over hidden images in the top bar. Closed: asks for the password (or for a first one when none is
 * set). Open: locks at once.
 */
export function LockButton({ className }: { className?: string }) {
  const lock = useAppStore((s) => s.lock)
  const openLockDialog = useAppStore((s) => s.openLockDialog)
  const lockNow = useAppStore((s) => s.lockNow)
  const label = !lock.hasPassword ? t('lock.setUp') : lock.open ? t('lock.lockHidden') : t('lock.unlockHidden')
  const onClick = (): void => {
    if (!lock.hasPassword) openLockDialog('set')
    else if (lock.open) void lockNow()
    else openLockDialog('open')
  }
  return (
    <IconButton
      label={label}
      icon={lock.open ? <LockSimpleOpen size={20} /> : <LockSimple size={20} />}
      onClick={onClick}
      className={className}
    />
  )
}
