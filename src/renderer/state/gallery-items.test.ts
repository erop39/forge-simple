import { defaultParams } from '@shared/profiles'
import type { ImageRecord, Job, JobProgress, JobStatus } from '@shared/types'
import { galleryItems, layoutColumns } from './gallery-items'

const params = defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })
const job = (id: number, status: JobStatus): Job => ({
  id, serverId: 1, type: 'txt2img', status, params, error: null,
  createdAt: id, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
})
const image = (id: number): ImageRecord => ({
  id, jobId: id, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/${id}.jpg`, width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: id, durationMs: 1000, hidden: false, sourceImageId: null,
})
const label = (items: ReturnType<typeof galleryItems>) =>
  items.map((i) => (i.kind === 'job' ? `job${i.job.id}` : `img${i.image.id}`))

test('order: running job, queued jobs oldest first, failed and interrupted, then images newest first', () => {
  const jobs = Object.fromEntries(
    [job(5, 'queued'), job(3, 'failed'), job(2, 'running'), job(4, 'queued'), job(1, 'interrupted')].map((j) => [j.id, j]),
  )
  const items = galleryItems(jobs, {}, [image(7), image(9), image(8)])
  expect(label(items)).toEqual(['job2', 'job4', 'job5', 'job1', 'job3', 'img9', 'img8', 'img7'])
})

test('queuePosition counts from 1 among queued jobs and is null otherwise', () => {
  const jobs = Object.fromEntries([job(1, 'running'), job(2, 'queued'), job(3, 'queued'), job(4, 'failed')].map((j) => [j.id, j]))
  const progress: Record<number, JobProgress> = {
    1: { jobId: 1, step: 2, totalSteps: 8, stage: 'sampling', stepsPerSec: null, elapsedMs: 0, preview: null },
  }
  const items = galleryItems(jobs, progress, [])
  const positions = items.map((i) => (i.kind === 'job' ? i.queuePosition : 'image'))
  expect(positions).toEqual([null, 1, 2, null])
  expect(items[0]).toMatchObject({ progress: progress[1] })
  expect(items[1]).toMatchObject({ progress: null })
})

test('layoutColumns keeps the order within each column and loses no item', () => {
  const items = Array.from({ length: 9 }, (_, i) => i)
  const columns = layoutColumns(items, 3, () => 1)
  expect(columns).toEqual([[0, 3, 6], [1, 4, 7], [2, 5, 8]])
})

test('layoutColumns puts each item in the currently shortest column', () => {
  // aspect 0.5 is twice as tall as aspect 1.
  const aspects = [0.5, 1, 1, 1]
  const columns = layoutColumns([0, 1, 2, 3], 2, (i) => aspects[i]!)
  // col0 = 2 high, col1 = 1; then item 2 -> col1 (2); item 3 ties -> col0.
  expect(columns).toEqual([[0, 3], [1, 2]])
})

test('layoutColumns gives the same result for the same input and clamps the count to one', () => {
  const items = ['a', 'b', 'c']
  const aspect = (s: string) => (s === 'a' ? 0.7 : 1.3)
  expect(layoutColumns(items, 2, aspect)).toEqual(layoutColumns(items, 2, aspect))
  expect(layoutColumns(items, 0, aspect)).toEqual([['a', 'b', 'c']])
})
