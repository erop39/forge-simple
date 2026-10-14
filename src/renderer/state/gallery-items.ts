import type { ImageRecord, Job, JobProgress } from '@shared/types'

export type GalleryItem =
  | { kind: 'job'; job: Job; progress: JobProgress | null; queuePosition: number | null }
  | { kind: 'image'; image: ImageRecord }

const byId = (a: Job, b: Job): number => a.id - b.id

/** Running job, queued jobs oldest first, failed and interrupted jobs, then images newest first. */
export function galleryItems(
  jobs: Record<number, Job>,
  progress: Record<number, JobProgress>,
  images: readonly ImageRecord[],
): GalleryItem[] {
  const all = Object.values(jobs).sort(byId)
  const queued = all.filter((j) => j.status === 'queued')
  const jobItem = (job: Job, queuePosition: number | null): GalleryItem => ({
    kind: 'job', job, progress: progress[job.id] ?? null, queuePosition,
  })
  return [
    ...all.filter((j) => j.status === 'running').map((j) => jobItem(j, null)),
    ...queued.map((j, i) => jobItem(j, i + 1)),
    ...all.filter((j) => j.status === 'failed' || j.status === 'interrupted').map((j) => jobItem(j, null)),
    ...[...images].sort((a, b) => b.id - a.id).map((image): GalleryItem => ({ kind: 'image', image })),
  ]
}

/** Stable key of an item across renders. */
export const itemKey = (item: GalleryItem): string =>
  item.kind === 'job' ? `job:${item.job.id}` : `image:${item.image.id}`

/** Width over height of the space an item reserves. */
export const aspectOfItem = (item: GalleryItem): number =>
  item.kind === 'job' ? item.job.params.width / item.job.params.height : item.image.width / item.image.height

/**
 * Splits items into columns in order: each goes to the currently shortest column, measured in reserved
 * height at unit width (1 / aspect). Ties go to the leftmost column. Pure, so equal input gives equal output.
 */
export function layoutColumns<T>(items: readonly T[], columnCount: number, aspectOf: (item: T) => number): T[][] {
  const count = Math.max(1, Math.floor(columnCount))
  const columns: T[][] = Array.from({ length: count }, () => [])
  const heights: number[] = new Array<number>(count).fill(0)
  for (const item of items) {
    const aspect = aspectOf(item)
    let target = 0
    for (let i = 1; i < count; i++) if (heights[i]! < heights[target]!) target = i
    columns[target]!.push(item)
    heights[target]! += aspect > 0 && Number.isFinite(aspect) ? 1 / aspect : 1
  }
  return columns
}
