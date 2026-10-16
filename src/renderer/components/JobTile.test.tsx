import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultParams } from '@shared/profiles'
import type { Job, JobProgress } from '@shared/types'
import { en } from '../locales/en'
import { JobTile } from './JobTile'
import { renderWithStore } from './test-store'

const params = { ...defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] }), width: 896, height: 1152 }
const job = (status: Job['status'], over: Partial<Job> = {}): Job => ({
  id: 3, serverId: 1, type: 'txt2img', status, params, error: null,
  createdAt: 1, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null, ...over,
})
const progress = (over: Partial<JobProgress> = {}): JobProgress => ({
  jobId: 3, step: 5, totalSteps: 8, stage: 'sampling', stepsPerSec: 2.34, elapsedMs: 12900, preview: null, ...over,
})
const tile = (container: HTMLElement) => container.firstElementChild as HTMLElement

test('queued tile shows "queued · 2" and a Cancel button', async () => {
  const cancelJob = vi.fn(async () => {})
  renderWithStore(<JobTile job={job('queued')} progress={null} queuePosition={2} />, 'sdxl', { cancelJob })
  expect(screen.getByText('queued · 2')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['job.cancel'] }))
  expect(cancelJob).toHaveBeenCalledWith(3)
})

test('a queued tile of another server says which server it waits for instead of its place', async () => {
  const cancelJob = vi.fn(async () => {})
  renderWithStore(<JobTile job={job('queued')} progress={null} queuePosition={null} waitingFor="Studio" />, 'sdxl', { cancelJob })
  expect(screen.getByText('Waiting for Studio')).toBeDefined()
  expect(screen.queryByText(/queued ·/)).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: en['job.cancel'] }))
  expect(cancelJob).toHaveBeenCalledWith(3)
})

test('running tile shows stage, "step 5/8", speed and elapsed seconds', () => {
  renderWithStore(<JobTile job={job('running')} progress={progress()} queuePosition={null} />)
  expect(screen.getByText('Sampling · step 5/8 · 2.3 it/s · 12 s')).toBeDefined()
})

test('running tile hides the speed while it is unknown and shows the step line before any progress', () => {
  const { unmount } = renderWithStore(
    <JobTile job={job('running')} progress={progress({ stepsPerSec: null })} queuePosition={null} />,
  )
  expect(screen.getByText('Sampling · step 5/8 · 12 s')).toBeDefined()
  unmount()
  renderWithStore(<JobTile job={job('running')} progress={null} queuePosition={null} />)
  expect(screen.getByText(`Sampling · step 0/${params.steps}`)).toBeDefined()
})

test('running tile keeps the aspect ratio of params.width / params.height', () => {
  const { container } = renderWithStore(<JobTile job={job('running')} progress={null} queuePosition={null} />)
  expect(tile(container).style.aspectRatio).toBe('896 / 1152')
})

test('the live preview is shown as a decorative image', () => {
  const { container } = renderWithStore(
    <JobTile job={job('running')} progress={progress({ preview: 'data:image/png;base64,AAAA' })} queuePosition={null} />,
  )
  const img = container.querySelector('img')!
  expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  expect(img.getAttribute('alt')).toBe('')
})

test('progress bar width follows step / totalSteps', () => {
  renderWithStore(<JobTile job={job('running')} progress={progress()} queuePosition={null} />)
  const bar = screen.getByRole('progressbar')
  expect(bar.getAttribute('aria-valuenow')).toBe('5')
  expect(bar.getAttribute('aria-valuemax')).toBe('8')
  expect((bar.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.625)')
})

test('failed tile shows the error text, Retry and Dismiss', async () => {
  const retryJob = vi.fn(async () => {})
  const dismissJob = vi.fn()
  const failed = job('failed', { error: { code: 'forgeHttp', status: 500, detail: 'CUDA out of memory' } })
  renderWithStore(<JobTile job={failed} progress={null} queuePosition={null} />, 'sdxl', { retryJob, dismissJob })
  expect(screen.getByText(en['job.failed'])).toBeDefined()
  expect(screen.getByText('Forge returned an error (500).')).toBeDefined()
  expect(screen.getByText('CUDA out of memory')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['job.retry'] }))
  expect(retryJob).toHaveBeenCalledWith(3)
  await userEvent.click(screen.getByRole('button', { name: en['job.dismiss'] }))
  expect(dismissJob).toHaveBeenCalledWith(3)
})

test('an interrupted tile uses its own heading and offers the same actions', () => {
  const interrupted = job('interrupted', { error: { code: 'stopped' } })
  const { container } = renderWithStore(<JobTile job={interrupted} progress={null} queuePosition={null} />)
  expect(screen.getByText(en['job.interrupted'])).toBeDefined()
  expect(screen.getByText(en['job.error.stopped'])).toBeDefined()
  expect(screen.getByRole('button', { name: en['job.retry'] })).toBeDefined()
  expect(screen.getByRole('button', { name: en['job.dismiss'] })).toBeDefined()
  expect(tile(container).dataset['status']).toBe('interrupted')
})

test('a failed or interrupted tile shows when it ended, as local time', () => {
  const finishedAt = new Date().setHours(14, 3, 0, 0)
  const { unmount } = renderWithStore(<JobTile job={job('failed', { error: { code: 'noImages' }, finishedAt })} progress={null} queuePosition={null} />)
  expect(screen.getByRole('heading', { name: new RegExp(`^${en['job.failed']}\\s*14:03$`) })).toBeDefined()
  expect(screen.getByText('14:03').classList.contains('mono')).toBe(true)
  unmount()
  renderWithStore(<JobTile job={job('interrupted', { error: { code: 'stopped' }, finishedAt: null })} progress={null} queuePosition={null} />)
  expect(screen.getByRole('heading', { name: en['job.interrupted'] })).toBeDefined()
})

describe('Restart Forge on a failed tile', () => {
  const failed500 = job('failed', { error: { code: 'forgeHttp', status: 500, detail: 'TypeError: boom' } })

  test('a Forge 500 offers a compact Restart Forge icon when Forge allows restarts; it opens the confirmation', async () => {
    const { store } = renderWithStore(<JobTile job={failed500} progress={null} queuePosition={null} />, 'sdxl', {
      capabilities: { canRestart: true },
    })
    const restart = screen.getByRole('button', { name: en['job.restartForge'] })
    expect(restart.textContent).toBe('')
    expect(restart.querySelector('svg')).not.toBeNull()
    await userEvent.click(restart)
    expect(store.getState().restartAsked).toBe(true)
  })

  test('no Restart Forge without the flag, nor for other errors', () => {
    const { unmount } = renderWithStore(<JobTile job={failed500} progress={null} queuePosition={null} />)
    expect(screen.queryByRole('button', { name: en['job.restartForge'] })).toBeNull()
    unmount()
    const failed422 = job('failed', { error: { code: 'forgeHttp', status: 422 } })
    renderWithStore(<JobTile job={failed422} progress={null} queuePosition={null} />, 'sdxl', { capabilities: { canRestart: true } })
    expect(screen.queryByRole('button', { name: en['job.restartForge'] })).toBeNull()
  })
})

test('a running tile warns when nothing has moved for a while', () => {
  renderWithStore(<JobTile job={job('running')} progress={progress({ stalledMs: 64_000 })} queuePosition={null} />)
  expect(screen.getByText(/no progress for 64 s/)).toBeDefined()
})
