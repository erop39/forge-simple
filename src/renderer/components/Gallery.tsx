import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { t } from '../i18n/t'
import { galleryItems, itemKey, type GalleryItem } from '../state/gallery-items'
import { neighbour, placeItems, visibleSlice, type Direction, type Placed } from '../state/masonry'
import { useAppStore } from '../state/StoreProvider'
import { useToday } from '../state/use-today'
import { GalleryEmpty } from './EmptyState'
import { ImageTile } from './ImageTile'
import { ImageViewer } from './ImageViewer'
import { JobTile } from './JobTile'
import { Button } from './ui/Button'
import { usePendingDelete } from './use-pending-delete'
import { useReveals } from './use-reveals'
import styles from './Gallery.module.css'
import type { ImageRecord } from '@shared/types'

/** Minimum tile width of 220 px plus the gap. */
const COLUMN_WIDTH = 226
const MIN_COLUMNS = 2
/** The space between tiles; the same as `--gap-tile`. */
const GAP = 6
/** Assumed until the first measurement: two columns and the minimum window height. */
const UNMEASURED = { width: 2 * COLUMN_WIDTH, height: 700 }

export const columnCountFor = (width: number): number => Math.max(MIN_COLUMNS, Math.floor(width / COLUMN_WIDTH))

/** The content size of the scroll area: its width lays out the columns, its height is one screen. */
function useViewportSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [size, setSize] = useState(UNMEASURED)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (!rect || rect.width <= 0) return
      setSize((s) => (s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }))
    })
    ro.observe(el)
    observer.current = ro
  }, [])
  return [ref, size]
}

const KEY_DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end',
}

/** The tile slot (`data-key`) an event happened in. */
const cellOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>('[data-key]') : null

/**
 * The canvas: job and image tiles in masonry columns, new ones at the top-left, older images paged in at
 * the end. Only the tiles within a screen above and below the view are in the DOM (plus the one holding
 * the gallery's single tab stop); the arrow keys, Home and End move that tab stop between tiles.
 */
export function Gallery() {
  const jobs = useAppStore((s) => s.jobs)
  const progress = useAppStore((s) => s.progress)
  const images = useAppStore((s) => s.images)
  const servers = useAppStore((s) => s.servers)
  const exhausted = useAppStore((s) => s.imagesExhausted)
  const hasParams = useAppStore((s) => s.params !== null)
  const deleteImage = useAppStore((s) => s.deleteImage)
  const loadMoreImages = useAppStore((s) => s.loadMoreImages)
  const viewRequest = useAppStore((s) => s.viewRequest)
  const today = useToday()
  const clearViewRequest = useAppStore((s) => s.clearViewRequest)
  const setHidden = useAppStore((s) => s.setHidden)
  const openLockDialog = useAppStore((s) => s.openLockDialog)
  const hasPassword = useAppStore((s) => s.lock.hasPassword)
  const [viewportRef, viewport] = useViewportSize()
  const scrollArea = useRef<HTMLDivElement | null>(null)
  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollArea.current = el
      viewportRef(el)
    },
    [viewportRef],
  )
  const [scrollTop, setScrollTop] = useState(0)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const focusRequest = useRef<string | null>(null)
  const pointerDown = useRef(false)
  const { hidden, toastOpen, request, undo } = usePendingDelete(deleteImage)
  const [viewerImage, setViewerImage] = useState<ImageRecord | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const [pendingNextId, setPendingNextId] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const openViewer = (image: ImageRecord, trigger: HTMLButtonElement): void => {
    opener.current = trigger
    setViewerImage(image)
  }

  // Without a loaded server list every queued job counts as the active server's.
  const activeServerId = servers.length === 0 ? undefined : (servers.find((s) => s.active)?.id ?? null)
  const items = useMemo(
    () => galleryItems(jobs, progress, images, activeServerId)
      .filter((i) => i.kind !== 'image' || !hidden.has(i.image.id)),
    [jobs, progress, images, activeServerId, hidden],
  )
  // The viewer pages through the images it can show: a locked tile has nothing to open.
  const visibleImages = useMemo(
    () => items.flatMap((item) => item.kind === 'image' && !item.image.locked ? [item.image] : []),
    [items],
  )
  const viewerIndex = visibleImages.findIndex((image) => image.id === viewerImage?.id)
  const hasPrevious = viewerIndex > 0
  const hasNext = viewerIndex >= 0 && (viewerIndex < visibleImages.length - 1 || (!exhausted && !loadingOlder))

  useEffect(() => {
    if (pendingNextId === null) return
    const index = visibleImages.findIndex((image) => image.id === pendingNextId)
    const next = visibleImages[index + 1]
    if (index >= 0 && next) {
      setViewerImage(next)
      setPendingNextId(null)
    } else if (!loadingOlder) {
      setPendingNextId(null)
    }
  }, [pendingNextId, visibleImages, loadingOlder])

  // The lock closed while a hidden image was on screen: the viewer goes with it, in the same render (the
  // picture is never painted again), and the state follows.
  const viewerLocked = viewerImage !== null && images.some((i) => i.id === viewerImage.id && i.locked)
  useEffect(() => {
    if (viewerImage && images.some((i) => i.id === viewerImage.id && i.locked)) {
      setPendingNextId(null)
      setViewerImage(null)
    }
  }, [images, viewerImage])

  // Another part of the window (the activity log) asked to show an image: open it when it is loaded.
  useEffect(() => {
    if (viewRequest === null) return
    const image = visibleImages.find((i) => i.id === viewRequest)
    if (image) {
      opener.current = null
      setPendingNextId(null)
      setViewerImage(image)
    }
    clearViewRequest()
  }, [viewRequest, visibleImages, clearViewRequest])

  const closeViewer = (): void => {
    setPendingNextId(null)
    setViewerImage(null)
  }
  const previousImage = (): void => {
    if (!hasPrevious) return
    setPendingNextId(null)
    setViewerImage(visibleImages[viewerIndex - 1]!)
  }
  const nextImage = (): void => {
    if (!hasNext) return
    const next = visibleImages[viewerIndex + 1]
    if (next) {
      setViewerImage(next)
      return
    }
    setPendingNextId(viewerImage!.id)
    setLoadingOlder(true)
    void loadMoreImages().finally(() => setLoadingOlder(false))
  }

  const { reveals, done: revealed } = useReveals(items)
  const columnCount = columnCountFor(viewport.width)
  const { placed, height } = useMemo(
    () => placeItems(items, columnCount, viewport.width, GAP),
    [items, columnCount, viewport.width],
  )
  const byKey = useMemo(() => new Map(items.map((item) => [itemKey(item), item])), [items])
  const placedByKey = useMemo(() => new Map(placed.map((p) => [p.key, p])), [placed])
  // The single tab stop: the tile last focused, or the first one when that tile is gone.
  const active = activeKey !== null && placedByKey.has(activeKey) ? activeKey : (placed[0]?.key ?? null)
  // One screen of margin above and below the view; the tab stop's tile always stays, so focus is never lost.
  const band = visibleSlice(placed, scrollTop - viewport.height, scrollTop + 2 * viewport.height)
  const activePlaced = active === null ? undefined : placedByKey.get(active)
  const rendered: Placed[] = activePlaced && !band.includes(activePlaced) ? [...band, activePlaced] : band

  // Older images page in when the bottom of the rendered band is less than a screen from the end. A page
  // that failed changes nothing here, so it is retried on the next scroll rather than in a loop.
  useEffect(() => {
    if (exhausted || images.length === 0) return
    if (height - (scrollTop + 2 * viewport.height) < viewport.height) void loadMoreImages()
  }, [scrollTop, viewport.height, height, exhausted, images.length, loadMoreImages])

  /** Focuses the tile's focus target and scrolls it into view; false when its tile is not in the DOM. */
  const focusTile = (key: string): boolean => {
    const cell = scrollArea.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)
    const target = cell?.querySelector<HTMLElement>('[data-primary]')
    if (!cell || !target) return false
    target.focus({ preventScroll: true })
    cell.scrollIntoView({ block: 'nearest' })
    return true
  }
  /** Moves the tab stop to `key` and focuses it, after the next render when its tile is not in the DOM yet. */
  const moveFocus = (key: string): void => {
    setActiveKey(key)
    focusRequest.current = focusTile(key) ? null : key
  }
  useLayoutEffect(() => {
    const key = focusRequest.current
    if (key !== null && focusTile(key)) focusRequest.current = null
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const direction = KEY_DIRECTIONS[event.key]
    const cell = cellOf(event.target)
    if (!direction || !cell || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    const next = neighbour(placed, cell.dataset['key']!, direction)
    if (next !== null) moveFocus(next)
  }
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const cell = cellOf(event.target)
    if (!cell) return
    setActiveKey(cell.dataset['key']!)
    // Keyboard focus (Tab into the gallery) brings the tile into view; a click leaves the scroll alone.
    if (!pointerDown.current) cell.scrollIntoView({ block: 'nearest' })
    pointerDown.current = false
  }

  /** Delete with Undo; when the focus was in that tile it moves to the next one (the previous one at the end). */
  const deleteTile = (id: number): void => {
    const key = itemKey({ kind: 'image', image: { id } as ImageRecord })
    const focused = scrollArea.current?.querySelector(`[data-key="${key}"]`)?.contains(document.activeElement) ?? false
    const at = placed.findIndex((p) => p.key === key)
    const next = placed[at + 1]?.key ?? placed[at - 1]?.key
    request(id)
    if (focused && next !== undefined) moveFocus(next)
  }
  const toggleHidden = (image: ImageRecord): void => void setHidden([image.id], !image.hidden)
  // Without a password (it was reset) a new one is set first; it then unlocks as usual.
  const unlock = (): void => openLockDialog(hasPassword ? 'open' : 'set')
  const serverName = (id: number): string | null => servers.find((s) => s.id === id)?.name ?? null

  const empty = items.length === 0 && hasParams && hidden.size === 0
  const renderTile = (item: GalleryItem, tabStop: boolean) =>
    item.kind === 'job' ? (
      <JobTile
        job={item.job}
        progress={item.progress}
        queuePosition={item.queuePosition}
        waitingFor={item.waiting ? serverName(item.job.serverId) : null}
        now={today}
        tabStop={tabStop}
      />
    ) : (
      <ImageTile
        image={item.image}
        onOpen={openViewer}
        onDelete={deleteTile}
        onToggleHidden={toggleHidden}
        onUnlock={unlock}
        now={today}
        tabStop={tabStop}
        revealFrom={reveals.get(item.image.id) ?? null}
        onRevealed={revealed}
      />
    )

  return (
    <>
      <div ref={scrollRef} className={styles.gallery} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {empty ? (
          <GalleryEmpty />
        ) : (
          <div
            className={styles.canvas}
            style={{ height }}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onPointerDown={() => {
              pointerDown.current = true
            }}
            onPointerUp={() => {
              pointerDown.current = false
            }}
          >
            {rendered.map((p) => (
              <div
                key={p.key}
                data-key={p.key}
                data-column={p.column}
                className={styles.cell}
                style={{ width: p.w, height: p.h, transform: `translate(${p.x}px, ${p.y}px)` }}
              >
                {renderTile(byKey.get(p.key)!, p.key === active)}
              </div>
            ))}
          </div>
        )}
      </div>
      <ImageViewer
        image={viewerLocked ? null : viewerImage}
        opener={opener}
        onClose={closeViewer}
        onPrevious={previousImage}
        onNext={nextImage}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        position={viewerIndex + 1}
        loadedCount={visibleImages.length}
      />
      <div role="status" aria-live="polite" className={styles.toastHost}>
        {toastOpen && (
          <div className={styles.toast}>
            <span className={styles.toastText}>{t('image.deleted')}</span>
            <Button onClick={undo}>{t('image.undo')}</Button>
          </div>
        )}
      </div>
    </>
  )
}
