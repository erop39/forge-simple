import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import type { RestartOutcome } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import styles from './ForgeRestart.module.css'

const REFUSED: Record<Exclude<RestartOutcome, 'restarting'>, MessageKey> = {
  notAllowed: 'forge.restartNotAllowed',
  notRestartable: 'forge.restartNotRestartable',
}

type RestartConfirmProps = {
  /** Called after Forge accepted the restart. */
  onRestarting: () => void
  onCancel: () => void
}

/** Asks before restarting Forge and explains a refusal. Shared by the server dialog and RestartDialog. */
export function RestartConfirm({ onRestarting, onCancel }: RestartConfirmProps) {
  const restartForge = useAppStore((s) => s.restartForge)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restart(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await restartForge()
      setBusy(false)
      if (outcome === 'restarting') onRestarting()
      else setError(t(REFUSED[outcome]))
    } catch (e) {
      setBusy(false)
      setError(errorText(e))
    }
  }

  return (
    <div className={styles.confirm}>
      <p className={styles.body}>{t('forge.restartBody')}</p>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button autoFocus onClick={onCancel} disabled={busy}>
          {t('forge.restartNo')}
        </Button>
        <Button variant="danger" onClick={() => void restart()} disabled={busy}>
          {busy ? t('forge.restarting') : t('forge.restartYes')}
        </Button>
      </div>
    </div>
  )
}

/** The restart confirmation opened from a failed job tile or the unhealthy notice. */
export function RestartDialog() {
  const open = useAppStore((s) => s.restartAsked)
  const close = useAppStore((s) => s.closeRestart)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t('forge.restartTitle')}</Dialog.Title>
          {open && <RestartConfirm onRestarting={close} onCancel={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
