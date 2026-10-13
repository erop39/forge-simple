import * as Dialog from '@radix-ui/react-dialog'
import { X } from '@phosphor-icons/react'
import { useRef, useState, type FormEvent } from 'react'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import styles from './ServerDialog.module.css'

type ServerDialogProps = { open: boolean; onOpenChange: (open: boolean) => void }

/** Without a configured server the dialog cannot be dismissed: the app is unusable without one. */
export function ServerDialog({ open, onOpenChange }: ServerDialogProps) {
  const hasServer = Boolean(useAppStore((s) => s.settings?.serverUrl))
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next || hasServer) && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          onEscapeKeyDown={(e) => !hasServer && e.preventDefault()}
          onInteractOutside={(e) => !hasServer && e.preventDefault()}
        >
          <ServerForm dismissible={hasServer} onDone={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ServerForm({ dismissible, onDone }: { dismissible: boolean; onDone: () => void }) {
  const initial = useAppStore((s) => s.settings?.serverUrl ?? '')
  const setServerUrl = useAppStore((s) => s.setServerUrl)
  const [url, setUrl] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || url.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const check = await setServerUrl(url.trim())
      if (check.ok) return onDone()
      setError(errorText(check.errorKey))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
    input.current?.focus()
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.head}>
        <Dialog.Title className={styles.title}>{t('server.title')}</Dialog.Title>
        {dismissible && (
          <Dialog.Close asChild>
            <IconButton label={t('server.close')} icon={<X size={16} />} />
          </Dialog.Close>
        )}
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{t('server.address')}</span>
        <input
          ref={input}
          className={`mono ${styles.input}`}
          value={url}
          placeholder={t('server.placeholder')}
          readOnly={busy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? 'server-error server-hint' : 'server-hint'}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {error !== null && (
        <p id="server-error" role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <Dialog.Description id="server-hint" className={styles.hint}>
        {t('server.hint')}
      </Dialog.Description>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || url.trim() === ''}>
          <span className={styles.stack}>
            <span aria-hidden={busy} className={busy ? styles.hidden : undefined}>
              {t('server.connect')}
            </span>
            <span aria-hidden={!busy} className={busy ? undefined : styles.hidden}>
              {t('server.connecting')}
            </span>
          </span>
        </Button>
      </div>
    </form>
  )
}
