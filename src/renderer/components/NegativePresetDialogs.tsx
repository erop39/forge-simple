import * as Dialog from '@radix-ui/react-dialog'
import { PencilSimple, Trash, X } from '@phosphor-icons/react'
import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { NegativePreset } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import styles from './NegativePresets.module.css'

/** Matches the main-process limit for a preset name. */
const MAX_NAME = 80

type DialogProps = {
  open: boolean
  onOpenChange(open: boolean): void
  /** Takes the focus back on close (the dialogs have no trigger of their own). */
  returnFocus?: RefObject<HTMLElement | null>
}

type FrameProps = DialogProps & {
  title: string
  /** Takes the focus on open; without it the panel itself does (not the close button, whose tooltip would take the first Escape). */
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

/** The shared frame: overlay, panel, title with a close button. Content mounts only while open. */
function Frame({ open, onOpenChange, returnFocus, title, initialFocus, children }: FrameProps) {
  const panel = useRef<HTMLDivElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={panel}
          className={styles.content}
          // Radix would focus the first tabbable element (the close button), and an autoFocus field
          // loses the focus when the dialog opens from a menu; so the focus is placed here.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(initialFocus?.current ?? panel.current)?.focus()
          }}
          onCloseAutoFocus={(e) => {
            if (!returnFocus?.current) return
            e.preventDefault()
            returnFocus.current.focus()
          }}
        >
          <div className={styles.head}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label={t('presets.close')} icon={<X size={16} />} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Runs a store call that may be refused; tracks busy state and the refusal text. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    let ok = false
    try {
      await action()
      ok = true
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
    return ok
  }
  return { busy, error, run }
}

/** Asks for a name and saves `text` as a new preset. */
export function SavePresetDialog({ text, ...props }: DialogProps & { text: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Frame {...props} title={t('presets.saveTitle')} initialFocus={input}>
      <SaveForm input={input} text={text} onDone={() => props.onOpenChange(false)} />
    </Frame>
  )
}

type SaveFormProps = { input: RefObject<HTMLInputElement | null>; text: string; onDone(): void }

function SaveForm({ input, text, onDone }: SaveFormProps) {
  const addNegativePreset = useAppStore((s) => s.addNegativePreset)
  const [name, setName] = useState('')
  const { busy, error, run } = useAction()
  const errorId = useId()
  const blank = name.trim() === ''

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (blank) return
    if (await run(() => addNegativePreset(name.trim(), text))) onDone()
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Dialog.Description className={styles.hint}>{t('presets.saveHint')}</Dialog.Description>
      <label className={styles.field}>
        <span className={styles.label}>{t('presets.name')}</span>
        <input
          ref={input}
          className={styles.input}
          value={name}
          placeholder={t('presets.namePlaceholder')}
          readOnly={busy}
          spellCheck={false}
          autoComplete="off"
          maxLength={MAX_NAME}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {error !== null && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Dialog.Close asChild>
          <Button disabled={busy}>{t('presets.cancel')}</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={busy || blank}>
          {t('presets.save')}
        </Button>
      </div>
    </form>
  )
}

/** Lists the presets with inline rename and delete-with-confirmation. */
export function ManagePresetsDialog(props: DialogProps) {
  return (
    <Frame {...props} title={t('presets.manageTitle')}>
      <PresetList />
    </Frame>
  )
}

type RowMode = { id: number; kind: 'rename' | 'confirm' } | null

function PresetList() {
  const presets = useAppStore((s) => s.negativePresets)
  const [mode, setMode] = useState<RowMode>(null)
  return (
    <div className={styles.form}>
      <Dialog.Description className={styles.hint}>{t('presets.manageHint')}</Dialog.Description>
      {presets.length === 0 ? (
        <p className={styles.empty}>{t('presets.empty')}</p>
      ) : (
        <ul className={styles.list} aria-label={t('presets.list')}>
          {presets.map((preset) => (
            <PresetRow
              key={preset.id}
              preset={preset}
              mode={mode?.id === preset.id ? mode.kind : null}
              onMode={(kind) => setMode(kind ? { id: preset.id, kind } : null)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

type PresetRowProps = {
  preset: NegativePreset
  mode: 'rename' | 'confirm' | null
  onMode(kind: 'rename' | 'confirm' | null): void
}

function PresetRow({ preset, mode, onMode }: PresetRowProps) {
  const renameNegativePreset = useAppStore((s) => s.renameNegativePreset)
  const removeNegativePreset = useAppStore((s) => s.removeNegativePreset)
  const [name, setName] = useState(preset.name)
  const { busy, error, run } = useAction()
  const nameId = useId()
  const errorId = useId()

  async function rename(event: FormEvent): Promise<void> {
    event.preventDefault()
    const next = name.trim()
    if (next === '') return
    if (next === preset.name) {
      onMode(null)
      return
    }
    if (await run(() => renameNegativePreset(preset.id, next))) onMode(null)
  }

  const alert = error !== null && (
    <p id={errorId} role="alert" className={styles.error}>
      {error}
    </p>
  )

  if (mode === 'rename') {
    return (
      <li className={styles.rowBlock}>
        <form className={styles.row} onSubmit={rename} noValidate>
          <input
            className={`${styles.input} ${styles.rowInput}`}
            value={name}
            aria-label={t('presets.name')}
            readOnly={busy}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            maxLength={MAX_NAME}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <div className={styles.rowActions}>
            <Button disabled={busy} onClick={() => { setName(preset.name); onMode(null) }}>
              {t('presets.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>
              {t('presets.save')}
            </Button>
          </div>
        </form>
        {alert}
      </li>
    )
  }

  if (mode === 'confirm') {
    return (
      <li className={styles.rowBlock} aria-labelledby={nameId}>
        <div className={styles.row}>
          <p id={nameId} className={styles.confirmText}>
            {t('presets.deleteConfirm', { name: preset.name })}
          </p>
          <div className={styles.rowActions}>
            <Button autoFocus disabled={busy} onClick={() => onMode(null)}>
              {t('presets.deleteNo')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(() => removeNegativePreset(preset.id))}>
              {t('presets.deleteYes')}
            </Button>
          </div>
        </div>
        {alert}
      </li>
    )
  }

  return (
    <li className={styles.rowBlock} aria-labelledby={nameId}>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span id={nameId} className={styles.name} title={preset.name}>
            {preset.name}
          </span>
          <span className={styles.text} title={preset.text}>
            {preset.text}
          </span>
        </div>
        <div className={styles.rowActions}>
          <IconButton
            label={t('presets.rename', { name: preset.name })}
            icon={<PencilSimple size={16} />}
            onClick={() => { setName(preset.name); onMode('rename') }}
          />
          <IconButton
            label={t('presets.delete', { name: preset.name })}
            icon={<Trash size={16} />}
            onClick={() => onMode('confirm')}
          />
        </div>
      </div>
      {alert}
    </li>
  )
}
