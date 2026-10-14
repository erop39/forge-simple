import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n/t'
import { aspectOfItem, galleryItems, itemKey, layoutColumns, type GalleryItem } from '../state/gallery-items'
import { useAppStore } from '../state/StoreProvider'
import { useToday } from '../state/use-today'
import { GalleryEmpty } from './EmptyState'
import { ImageTile } from './ImageTile'
import { ImageViewer } from './ImageViewer'
import { JobTile } from './JobTile'
import { Button } from './ui/Button'
import { usePendingDelete } from './use-pending-delete'
import styles from './Gallery.module.css'
import type { ImageRecord } from '@shared/types'

/** Minimum tile width of 220 px plus the 6 px gap. */
const COLUMN_WIDTH = 226
const MIN_COLUMNS = 2

export const columnCountFor = (width: number): number => Math.max(MIN_COLUMNS, Math.floor(width / COLUMN_WIDTH))

function useColumnCount(): [(el: HTMLDivElement | null) => void, number] {
  const [count, setCount] = useState(MIN_COLUMNS)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width
      if (width !== undefined) setCount(columnCountFor(width))
    })
    ro.observe(el)
    observer.current = ro
  }, [])
  return [ref, count]
}

/** Calls `onNear` when the sentinel comes within a screen of the viewport; re-arms when `rearm` changes. */
function useNearEnd(active: boolean, rearm: unknown, onNear: () => void) {
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!active || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onNear()
      },
      { rootMargin: '0px 0px 600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [active, rearm, onNear])
  return sentinel
}

/** The canvas: job and image tiles in columns, new ones at the top-left, older images paged in at the end. */
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
  const [columnsRef, columnCount] = useColumnCount()
  const { hidden, toastOpen, request, undo } = usePendingDelete(deleteImage)
  const [viewerImage, setViewerImage] = useState<ImageRecord | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const [pendingNextId, setPendingNextId] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const openViewer = (image: ImageRecord, trigger: HTMLButtonElement): void => {
    opener.current = trigger
    setViewerImage(image)
  }

  const loadMore = useCallback(() => void loadMoreImages(), [loadMoreImages])
  const sentinel = useNearEnd(images.length > 0 && !exhausted, images.length, loadMore)

  // Without a loaded server list every queued job counts as the active server's.
  const activeServerId = servers.length === 0 ? undefined : (servers.find((s) => s.active)?.id ?? null)
  const items = useMemo(
    () => galleryItems(jobs, progress, images, activeServerId)
      .filter((i) => i.kind !== 'image' || !hidden.has(i.image.id)),
    [jobs, progress, images, activeServerId, hidden],
  )
  const visibleImages = useMemo(
    () => items.flatMap((item) => item.kind === 'image' ? [item.image] : []),
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
  const serverName = (id: number): string | null => servers.find((s) => s.id === id)?.name ?? null
  const columns = useMemo(() => layoutColumns(items, columnCount, aspectOfItem), [items, columnCount])

  const empty = items.length === 0 && hasParams && hidden.size === 0
  const renderItem = (item: GalleryItem) =>
    item.kind === 'job' ? (
      <JobTile
        key={itemKey(item)}
        job={item.job}
        progress={item.progress}
        queuePosition={item.queuePosition}
        waitingFor={item.waiting ? serverName(item.job.serverId) : null}
        now={today}
      />
    ) : (
      <ImageTile key={itemKey(item)} image={item.image} onOpen={openViewer} onDelete={request} now={today} />
    )

  return (
    <>
      <div ref={columnsRef} className={styles.gallery}>
        {empty ? (
          <GalleryEmpty />
        ) : (
          <div className={styles.grid}>
            {columns.map((column, i) => (
              <div key={i} className={styles.column}>
                {column.map(renderItem)}
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && !exhausted && <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />}
      </div>
      <ImageViewer
        image={viewerImage}
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
