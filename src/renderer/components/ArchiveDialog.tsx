import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import styles from './SelectionBar.module.css'

/** The archive dialog, mounted once in App: it keeps its own copy of the chosen ids, so the selection changing under it does not close it. */
export function ArchiveDialog() {
  const ids = useAppStore((s) => s.archiveFor)
  const close = useAppStore((s) => s.closeArchive)
  return ids === null ? null : <ArchiveImages ids={ids} onClose={close} />
}

/** Moves the selected images into an archive folder; hidden images are named as skipped, never archived. */
function ArchiveImages({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const images = useAppStore((s) => s.images)
  const archiveState = useAppStore((s) => s.archiveState)
  const chooseDir = useAppStore((s) => s.chooseArchiveDir)
  const createArchive = useAppStore((s) => s.createArchive)
  const [dir, setDir] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // Counted once when the dialog opens: the archived images leave the gallery (and the selection) while it works.
  const [hidden] = useState(() => images.filter((image) => ids.includes(image.id) && (image.hidden || image.locked)).length)
  const archivable = ids.length - hidden

  useEffect(() => {
    let alive = true
    void archiveState().then((s) => { if (alive) setDir(s.dir) }, () => undefined)
    return () => { alive = false }
  }, [archiveState])

  async function pick(): Promise<void> {
    setError(null)
    try { const next = await chooseDir(); if (next) setDir(next) }
    catch (e) { setError(errorText(e)) }
  }

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await createArchive(ids, label.trim())
      setDone(t('archive.done', { n: result.archived, name: result.name }))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t('archive.title', { n: archivable })}</Dialog.Title>
          {done === null ? (
            <>
              <p className={styles.hint}>{t('archive.explain')}</p>
              {hidden > 0 && <p className={styles.hint}>{t('archive.skipHidden', { n: hidden })}</p>}
              <div className={styles.field}>
                <span className={styles.hint}>{t('archive.folder')}</span>
                <span className={styles.path} title={dir ?? ''}>{dir ?? '…'}</span>
                <Button disabled={busy} onClick={() => void pick()}>{t('archive.chooseFolder')}</Button>
              </div>
              <label className={styles.field}>
                <span className={styles.hint}>{t('archive.label')}</span>
                <input className={styles.input} maxLength={60} placeholder={t('archive.labelPlaceholder')} value={label}
                  onChange={(event) => setLabel(event.target.value)} />
              </label>
              {error && <p role="alert" className={styles.error}>{error}</p>}
              <div className={styles.actions}>
                <Button disabled={busy} onClick={onClose}>{t('archive.cancel')}</Button>
                <Button variant="primary" disabled={busy || archivable === 0} onClick={() => void run()}>
                  {busy ? t('archive.working') : t('archive.confirm')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p role="status" className={styles.hint}>{done}</p>
              <div className={styles.actions}><Button autoFocus onClick={onClose}>{t('selection.done')}</Button></div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
