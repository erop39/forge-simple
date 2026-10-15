import * as Dialog from '@radix-ui/react-dialog'
import { X } from '@phosphor-icons/react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { errorText } from '../i18n/error-text'
import { t, type MessageKey } from '../i18n/t'
import type { LockDialogMode } from '../state/store'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import styles from './LockDialog.module.css'

/** Matches the main-process limits for a password. */
const MIN_PASSWORD = 4
const MAX_PASSWORD = 1024

type FieldName = 'current' | 'password' | 'repeat'
const FIELDS: Record<LockDialogMode, { name: FieldName; label: MessageKey; autoComplete: string }[]> = {
  set: [
    { name: 'password', label: 'lock.password', autoComplete: 'new-password' },
    { name: 'repeat', label: 'lock.repeat', autoComplete: 'new-password' },
  ],
  open: [{ name: 'password', label: 'lock.password', autoComplete: 'current-password' }],
  change: [
    { name: 'current', label: 'lock.current', autoComplete: 'current-password' },
    { name: 'password', label: 'lock.new', autoComplete: 'new-password' },
    { name: 'repeat', label: 'lock.repeatNew', autoComplete: 'new-password' },
  ],
}
const TITLES: Record<LockDialogMode, MessageKey> = { set: 'lock.setTitle', open: 'lock.openTitle', change: 'lock.changeTitle' }
const HINTS: Record<LockDialogMode, MessageKey> = { set: 'lock.setHint', open: 'lock.openHint', change: 'lock.changeHint' }

/** Sets the first password, unlocks hidden images, or changes the password; opened through the store. */
export function LockDialog() {
  const mode = useAppStore((s) => s.lockDialog)
  const close = useAppStore((s) => s.closeLockDialog)
  const first = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // The dialog has no trigger of its own: the focus goes back to whatever opened it, if it is still there.
  // A layout effect reads it before the dialog's own focus handling moves it.
  const returnTo = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (mode !== null && returnTo.current === null && document.activeElement instanceof HTMLElement) {
      returnTo.current = document.activeElement
    }
  }, [mode])

  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={panel}
          className={styles.content}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(first.current ?? panel.current)?.focus()
          }}
          onCloseAutoFocus={(e) => {
            const target = returnTo.current
            returnTo.current = null
            if (!target?.isConnected) return
            e.preventDefault()
            target.focus()
          }}
        >
          {mode !== null && (
            <>
              <div className={styles.head}>
                <Dialog.Title className={styles.title}>{t(TITLES[mode])}</Dialog.Title>
                <Dialog.Close asChild>
                  <IconButton label={t('lock.close')} icon={<X size={16} />} />
                </Dialog.Close>
              </div>
              <LockForm key={mode} mode={mode} first={first} />
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LockForm({ mode, first }: { mode: LockDialogMode; first: RefObject<HTMLInputElement | null> }) {
  const unlock = useAppStore((s) => s.unlock)
  const setLockPassword = useAppStore((s) => s.setLockPassword)
  const openLockDialog = useAppStore((s) => s.openLockDialog)
  const [values, setValues] = useState<Record<FieldName, string>>({ current: '', password: '', repeat: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const errorId = useId()

  // Focus the first field when the mode changes inside an open dialog (open → change).
  useEffect(() => first.current?.focus(), [first])

  /** The local reason the entry cannot be sent, or null. */
  function problem(): MessageKey | null {
    if (mode === 'open') return null
    if (values.password.length < MIN_PASSWORD) return 'lock.tooShort'
    if (values.password !== values.repeat) return 'lock.mismatch'
    return null
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    const local = problem()
    if (local !== null) {
      setError(t(local))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'open') await unlock(values.password)
      else await setLockPassword(mode === 'change' ? values.current : null, values.password)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Dialog.Description className={styles.hint}>{t(HINTS[mode])}</Dialog.Description>
      {FIELDS[mode].map((field, i) => (
        <label key={field.name} className={styles.field}>
          <span className={styles.label}>{t(field.label)}</span>
          <input
            ref={i === 0 ? first : undefined}
            className={styles.input}
            type="password"
            value={values[field.name]}
            readOnly={busy}
            autoComplete={field.autoComplete}
            maxLength={MAX_PASSWORD}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
          />
        </label>
      ))}
      {error !== null && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {mode === 'open' && (
          <Button className={styles.aside} disabled={busy} onClick={() => openLockDialog('change')}>
            {t('lock.change')}
          </Button>
        )}
        <Dialog.Close asChild>
          <Button disabled={busy}>{t('lock.cancel')}</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy || values.password === ''}>
          {mode === 'open' ? t('lock.unlock') : t('lock.save')}
        </Button>
      </div>
    </form>
  )
}
