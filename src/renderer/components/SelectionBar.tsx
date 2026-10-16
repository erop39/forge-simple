import * as Dialog from '@radix-ui/react-dialog'
import { Archive, EyeSlash, Eye, Tag, Trash, X } from '@phosphor-icons/react'
import { useState } from 'react'
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
  const openArchive = useAppStore((s) => s.openArchive)
  const [tagsOpen, setTagsOpen] = useState(false)
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
        <Button icon={<Archive size={16} />} onClick={() => openArchive(ids)}>{t('selection.archive')}</Button>
        <Button variant="danger" icon={<Trash size={16} />} onClick={() => { onDelete(ids); clearSelection() }}>{t('selection.delete')}</Button>
        <Button icon={<X size={16} />} onClick={clearSelection}>{t('selection.clear')}</Button>
      </div>
      {tagsOpen && <BatchTags ids={ids} onClose={() => setTagsOpen(false)} />}
    </>
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
