import { Trash } from '@phosphor-icons/react'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { t } from '../i18n/t'
import { IconButton } from './ui/IconButton'
import styles from './ImageTile.module.css'

/** `now`: a moment of the current day, so the caption's time knows what "today" is. */
type ImageTileProps = {
  image: ImageRecord; onOpen(image: ImageRecord, trigger: HTMLButtonElement): void; onDelete(id: number): void; now?: number
}

/** A finished image: only the picture; the frame marking and the delete button show on hover and focus. */
export function ImageTile({ image, onOpen, onDelete, now }: ImageTileProps) {
  const caption = frameCaption(image, now)
  return (
    <div
      role="group"
      aria-label={caption}
      className={styles.tile}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      <button
        type="button"
        className={styles.open}
        aria-label={t('image.open', { n: image.id })}
        onClick={(event) => onOpen(image, event.currentTarget)}
      >
        <img src={image.thumbUrl} loading="lazy" decoding="async" alt="" className={styles.image} />
      </button>
      <span className={`mono ${styles.caption}`} aria-hidden="true">
        {caption}
      </span>
      <IconButton
        className={styles.delete}
        label={t('image.delete')}
        icon={<Trash size={16} />}
        onClick={() => onDelete(image.id)}
      />
    </div>
  )
}
