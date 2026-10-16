import * as Dialog from '@radix-ui/react-dialog'
import { Archive, EyeSlash, Eye, Tag, Trash, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { TagEditor } from './TagEditor'
import { Button } from './ui/Button'
import styles from './SelectionBar.module.css'

type Props = {
  /** The selected images that are on screen now, in gallery order. */
  ids: number[]
  onDelete(ids: number[]): void
}

/** Floats above the prompt bar while images are selected: tags, hide or unhide, delete (with one Undo), clear. */
export function SelectionBar({ ids, onDelete }: Props) {
  const images = useAppStore((s) => s.images)
  const setHidden = useAppStore((s) => s.setHidden)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const chosen = images.filter((image) => ids.includes(image.id))
  const allHidden = chosen.length > 0 && chosen.every((image) => image.hidden)

  return (
    <>
      <div className={styles.bar} role="toolbar" aria-label={t('selection.label')}>
        <span className={styles.count} role="status">{t('selection.count', { n: ids.length })}</span>
        <Button icon={<Tag size={16} />} onClick={() => setTagsOpen(true)}>{t('selection.tags')}</Button>
        <Button icon={allHidden ? <Eye size={16} /> : <EyeSlash size={16} />} onClick={() => void setHidden(ids, !allHidden)}>
          {allHidden ? t('selection.unhide') : t('selection.hide')}
        </Button>
        <Button icon={<Archive size={16} />} onClick={() => setArchiveOpen(true)}>{t('selection.archive')}</Button>
        <Button variant="danger" icon={<Trash size={16} />} onClick={() => { onDelete(ids); clearSelection() }}>{t('selection.delete')}</Button>
        <Button icon={<X size={16} />} onClick={clearSelection}>{t('selection.clear')}</Button>
      </div>
      {tagsOpen && <BatchTags ids={ids} onClose={() => setTagsOpen(false)} />}
      {archiveOpen && <ArchiveImages ids={ids} onClose={() => setArchiveOpen(false)} />}
    </>
  )
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
  const chosen = images.filter((image) => ids.includes(image.id))
  const hidden = chosen.filter((image) => image.hidden || image.locked).length
  const archivable = chosen.length - hidden

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

/** Tags of several images: the ones every image has can be edited, the ones only some have are shown apart. */
function BatchTags({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const images = useAppStore((s) => s.images)
  const addImageTags = useAppStore((s) => s.addImageTags)
  const removeImageTags = useAppStore((s) => s.removeImageTags)
  const chosen = images.filter((image) => ids.includes(image.id))
  const counts = new Map<string, { name: string; n: number }>()
  for (const image of chosen) {
    for (const tag of image.tags) {
      const key = tag.toLowerCase()
      counts.set(key, { name: tag, n: (counts.get(key)?.n ?? 0) + 1 })
    }
  }
  const common = [...counts.values()].filter((c) => c.n === chosen.length).map((c) => c.name)
  const partial = [...counts.values()].filter((c) => c.n < chosen.length).map((c) => c.name)

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t('selection.tagsTitle', { n: ids.length })}</Dialog.Title>
          <TagEditor
            tags={common}
            label={t('tags.title')}
            onChange={(next) => {
              const added = next.filter((tag) => !common.some((c) => c.toLowerCase() === tag.toLowerCase()))
              const removed = common.filter((tag) => !next.some((n) => n.toLowerCase() === tag.toLowerCase()))
              if (added.length > 0) void addImageTags(ids, added)
              if (removed.length > 0) void removeImageTags(ids, removed)
            }}
          />
          {partial.length > 0 && (
            <div className={styles.partial}>
              <span className={styles.hint}>{t('selection.partial')}</span>
              <ul className={styles.partialList}>
                {partial.map((tag) => (
                  <li key={tag} className={styles.partialTag} title={t('selection.partialTitle')}>
                    {tag}
                    <button type="button" className={styles.partialRemove} aria-label={t('tags.remove', { tag })}
                      onClick={() => void removeImageTags(ids, [tag])}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className={styles.actions}><Button autoFocus onClick={onClose}>{t('selection.done')}</Button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
