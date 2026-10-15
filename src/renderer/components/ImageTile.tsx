import { Eye, EyeSlash, LockSimple, Trash } from '@phosphor-icons/react'
import type { KeyboardEvent } from 'react'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { t } from '../i18n/t'
import { IconButton } from './ui/IconButton'
import styles from './ImageTile.module.css'

/** `now`: a moment of the current day, so the caption's time knows what "today" is. */
type ImageTileProps = {
  image: ImageRecord
  onOpen(image: ImageRecord, trigger: HTMLButtonElement): void
  onDelete(id: number): void
  /** Hide or unhide (the button, or `H` on the focused tile). */
  onToggleHidden(image: ImageRecord): void
  /** A locked tile asks for the password instead of opening. */
  onUnlock(trigger: HTMLButtonElement): void
  now?: number
}

/**
 * A finished image: only the picture; the frame marking and the actions show on hover and focus.
 * A hidden image while the lock is closed is a hatched tile with a lock, of the same size, without the picture.
 */
export function ImageTile({ image, onOpen, onDelete, onToggleHidden, onUnlock, now }: ImageTileProps) {
  const caption = frameCaption(image, now)
  const ratio = { aspectRatio: `${image.width} / ${image.height}` }

  if (image.locked) {
    return (
      <div role="group" aria-label={caption} className={`${styles.tile} ${styles.locked}`} style={ratio}>
        <button
          type="button"
          className={`${styles.open} ${styles.unlock}`}
          aria-label={t('image.lockedOpen', { n: image.id })}
          onClick={(event) => onUnlock(event.currentTarget)}
        >
          <LockSimple size={20} aria-hidden="true" />
        </button>
        <span className={`mono ${styles.caption}`} aria-hidden="true">
          {caption}
        </span>
      </div>
    )
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.key !== 'h' && event.key !== 'H') || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    onToggleHidden(image)
  }

  return (
    <div role="group" aria-label={caption} className={styles.tile} style={ratio} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={styles.open}
        aria-label={t('image.open', { n: image.id })}
        onClick={(event) => onOpen(image, event.currentTarget)}
      >
        <img src={image.thumbUrl} loading="lazy" decoding="async" alt="" className={styles.image} />
      </button>
      {image.hidden && (
        <span className={styles.badge}>
          <EyeSlash size={16} aria-hidden="true" />
          {t('image.hiddenBadge')}
        </span>
      )}
      <span className={`mono ${styles.caption}`} aria-hidden="true">
        {caption}
      </span>
      <div className={styles.actions}>
        <IconButton
          className={styles.action}
          label={image.hidden ? t('image.unhide') : t('image.hide')}
          icon={image.hidden ? <Eye size={16} /> : <EyeSlash size={16} />}
          onClick={() => onToggleHidden(image)}
        />
        <IconButton
          className={styles.action}
          label={t('image.delete')}
          icon={<Trash size={16} />}
          onClick={() => onDelete(image.id)}
        />
      </div>
    </div>
  )
}
