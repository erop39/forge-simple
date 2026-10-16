import type { ImageRecord, Job, JobProgress } from '@shared/types'

export type GalleryItem =
  /** waiting: a queued job of a server that is not active; it has no place in the queue. */
  | { kind: 'job'; job: Job; progress: JobProgress | null; queuePosition: number | null; waiting: boolean }
  | { kind: 'image'; image: ImageRecord }

const byId = (a: Job, b: Job): number => a.id - b.id

/**
 * Running job, the active server's queued jobs oldest first, other servers' queued jobs, failed and
 * interrupted jobs, then images newest first. `activeServerId` null means no server is active (every
 * queued job waits); left out, every queued job counts as the active server's.
 */
export function galleryItems(
  jobs: Record<number, Job>,
  progress: Record<number, JobProgress>,
  images: readonly ImageRecord[],
  activeServerId?: number | null,
): GalleryItem[] {
  const all = Object.values(jobs).sort(byId)
  const queued = all.filter((j) => j.status === 'queued')
  const waits = (j: Job): boolean => activeServerId !== undefined && j.serverId !== activeServerId
  const jobItem = (job: Job, queuePosition: number | null, waiting = false): GalleryItem => ({
    kind: 'job', job, progress: progress[job.id] ?? null, queuePosition, waiting,
  })
  return [
    ...all.filter((j) => j.status === 'running').map((j) => jobItem(j, null)),
    ...queued.filter((j) => !waits(j)).map((j, i) => jobItem(j, i + 1)),
    ...queued.filter(waits).map((j) => jobItem(j, null, true)),
    ...all.filter((j) => j.status === 'failed' || j.status === 'interrupted').map((j) => jobItem(j, null)),
    ...[...images].sort((a, b) => b.id - a.id).map((image): GalleryItem => ({ kind: 'image', image })),
  ]
}

/**
 * The focused view: only what belongs to the jobs of the latest generation request (their tiles while they wait or run,
 * and the images they made). A locked image has no job id and never belongs to it.
 */
export function focusItems(items: readonly GalleryItem[], batchJobIds: readonly number[]): GalleryItem[] {
  const batch = new Set(batchJobIds)
  return items.filter((item) => batch.has(item.kind === 'job' ? item.job.id : item.image.jobId))
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
