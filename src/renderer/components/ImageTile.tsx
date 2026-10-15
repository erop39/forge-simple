import { Eye, EyeSlash, LockSimple, Trash } from '@phosphor-icons/react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { t } from '../i18n/t'
import { IconButton } from './ui/IconButton'
import styles from './ImageTile.module.css'

/** `now`: a moment of the current day, so the caption's time knows what "today" is. */
type ImageTileProps = {
  image: ImageRecord
  onOpen(image: ImageRecord, trigger: HTMLButtonElement): void
  /** Delete (the button, or `Delete` on the focused tile). */
  onDelete(id: number): void
  /** Hide or unhide (the button, or `H` on the focused tile). */
  onToggleHidden(image: ImageRecord): void
  /** A locked tile asks for the password instead of opening. */
  onUnlock(trigger: HTMLButtonElement): void
  now?: number
  /** The gallery's roving tab stop: false takes the tile's buttons out of the tab order. */
  tabStop?: boolean
  /** The job's last live preview: the picture fades in over it once loaded, then `onRevealed` drops it. */
  revealFrom?: string | null
  onRevealed?(id: number): void
}

/** How long the picture takes to fade in over the preview; the same as `--dur-reveal`. */
export const REVEAL_MS = 260

/**
 * A finished image: only the picture; the frame marking and the actions show on hover and focus.
 * A hidden image while the lock is closed is a hatched tile with a lock, of the same size, without the picture.
 * The open (or unlock) button is the tile's focus target (`data-primary`) for the gallery's keyboard navigation.
 */
export function ImageTile({
  image, onOpen, onDelete, onToggleHidden, onUnlock, now, tabStop = true, revealFrom = null, onRevealed,
}: ImageTileProps) {
  const caption = frameCaption(image, now)
  const ratio = { aspectRatio: `${image.width} / ${image.height}` }
  const tabIndex = tabStop ? 0 : -1
  const [loaded, setLoaded] = useState(false)
  const revealing = revealFrom !== null && !image.locked
  useEffect(() => {
    if (!revealing || !loaded) return
    const timer = setTimeout(() => onRevealed?.(image.id), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealing, loaded, onRevealed, image.id])

  if (image.locked) {
    return (
      <div role="group" aria-label={caption} className={`${styles.tile} ${styles.locked}`} style={ratio}>
        <button
          type="button"
          className={`${styles.open} ${styles.unlock}`}
          data-primary
          tabIndex={tabIndex}
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
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'h' || event.key === 'H') onToggleHidden(image)
    else if (event.key === 'Delete') onDelete(image.id)
    else return
    event.preventDefault()
  }
  // While revealing, the picture stays transparent over the preview until it has loaded, then fades in.
  const revealClass = !revealing ? '' : loaded ? ` ${styles.reveal}` : ` ${styles.revealWaiting}`

  return (
    <div role="group" aria-label={caption} className={styles.tile} style={ratio} onKeyDown={onKeyDown}>
      {revealing && <img src={revealFrom} alt="" className={styles.preview} />}
      <button
        type="button"
        className={styles.open}
        draggable
        onDragStart={(event) => event.dataTransfer.setData('application/x-forge-neo-image-id', String(image.id))}
        data-primary
        tabIndex={tabIndex}
        aria-label={t('image.open', { n: image.id })}
        onClick={(event) => onOpen(image, event.currentTarget)}
      >
        <img
          src={image.thumbUrl}
          loading="lazy"
          decoding="async"
          alt=""
          className={`${styles.image}${revealClass}`}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
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
          tabIndex={tabIndex}
          onClick={() => onToggleHidden(image)}
        />
        <IconButton
          className={styles.action}
          label={t('image.delete')}
          icon={<Trash size={16} />}
          tabIndex={tabIndex}
          onClick={() => onDelete(image.id)}
        />
      </div>
    </div>
  )
}
