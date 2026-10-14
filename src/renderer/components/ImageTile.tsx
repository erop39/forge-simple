import { Trash } from '@phosphor-icons/react'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { t } from '../i18n/t'
import { IconButton } from './ui/IconButton'
import styles from './ImageTile.module.css'

type ImageTileProps = { image: ImageRecord; onDelete(id: number): void }

/** A finished image: only the picture; the frame marking and the delete button show on hover and focus. */
export function ImageTile({ image, onDelete }: ImageTileProps) {
  const caption = frameCaption(image)
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={caption}
      className={styles.tile}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      <img src={image.thumbUrl} loading="lazy" decoding="async" alt="" className={styles.image} />
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
