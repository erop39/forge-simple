import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultParams } from '@shared/profiles'
import type { ImageRecord, Job } from '@shared/types'
import { en } from '../locales/en'
import { Gallery, columnCountFor } from './Gallery'
import { renderWithStore } from './test-store'

const params = defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })
const job = (id: number, status: Job['status']): Job => ({
  id, serverId: 1, type: 'txt2img', status, params, error: null,
  createdAt: id, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
})
const image = (id: number): ImageRecord => ({
  id, jobId: id, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/t${id}.jpg`, width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: id, durationMs: 41000, hidden: false, sourceImageId: null,
})
const frame = (id: number) => `№ ${String(id).padStart(4, '0')} · 41 s · 832×1216`

/** The Delete button inside the tile with the given caption. */
function deleteButtonOf(caption: string): HTMLElement {
  return screen.getByRole('group', { name: caption }).querySelector('button') as HTMLElement
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('the column count follows the width, with at least two columns', () => {
  expect(columnCountFor(0)).toBe(2)
  expect(columnCountFor(451)).toBe(2)
  expect(columnCountFor(678)).toBe(3)
  expect(columnCountFor(1130)).toBe(5)
})

test('a resize changes the number of columns', () => {
  let notify: ResizeObserverCallback = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        notify = cb
      }
      observe(): void {}
      disconnect(): void {}
    },
  )
  const { container } = renderWithStore(<Gallery />, 'sdxl', { images: [image(3), image(2), image(1)] })
  const columns = () => container.querySelectorAll('[class*="column"]').length
  expect(columns()).toBe(2)
  act(() => notify([{ contentRect: { width: 1000 } } as ResizeObserverEntry], {} as ResizeObserver))
  expect(columns()).toBe(4)
})

test('with no jobs and no images the empty state shows', () => {
  renderWithStore(<Gallery />)
  expect(screen.getByText(en['empty.gallery.title'])).toBeDefined()
  expect(screen.getByText(en['empty.gallery.body'])).toBeDefined()
})

test('a queued job hides the empty state; with no parameters yet nothing shows', () => {
  const { unmount } = renderWithStore(<Gallery />, 'sdxl', { jobs: { 1: job(1, 'queued') } })
  expect(screen.queryByText(en['empty.gallery.title'])).toBeNull()
  expect(screen.getByText('queued · 1')).toBeDefined()
  unmount()
  renderWithStore(<Gallery />, 'sdxl', { params: null })
  expect(screen.queryByText(en['empty.gallery.title'])).toBeNull()
})

test('jobs and images are laid out in order, jobs first and the newest image after them', () => {
  const { container } = renderWithStore(<Gallery />, 'sdxl', {
    jobs: { 9: job(9, 'running') },
    images: [image(1), image(2)],
  })
  const columns = [...container.querySelectorAll('[class*="column"]')].map((c) =>
    [...c.children].map((el) => (el as HTMLElement).dataset['status'] ?? el.getAttribute('aria-label')),
  )
  // The running job is first (column 0); the newest image (2) goes to column 1, image 1 back to the shorter column.
  expect(columns[0]![0]).toBe('running')
  expect(columns[1]![0]).toBe(frame(2))
})

test('Delete hides the tile at once, shows the toast, and commits after 5 s', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const deleteImage = vi.fn(async () => {})
  renderWithStore(<Gallery />, 'sdxl', { images: [image(2), image(1)], deleteImage })
  await userEvent.click(deleteButtonOf(frame(2)))
  expect(screen.queryByRole('group', { name: frame(2) })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain(en['image.deleted'])
  expect(deleteImage).not.toHaveBeenCalled()
  act(() => void vi.advanceTimersByTime(4900))
  expect(deleteImage).not.toHaveBeenCalled()
  await act(async () => void vi.advanceTimersByTime(200))
  expect(deleteImage).toHaveBeenCalledWith(2)
  expect(screen.getByRole('status').textContent).toBe('')
})

test('Undo cancels the deletion and shows the tile again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const deleteImage = vi.fn(async () => {})
  renderWithStore(<Gallery />, 'sdxl', { images: [image(2), image(1)], deleteImage })
  await userEvent.click(deleteButtonOf(frame(2)))
  await userEvent.click(screen.getByRole('button', { name: en['image.undo'] }))
  expect(screen.getByRole('group', { name: frame(2) })).toBeDefined()
  await act(async () => void vi.advanceTimersByTime(6000))
  expect(deleteImage).not.toHaveBeenCalled()
})

test('deleting a second image commits the first one immediately', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const deleteImage = vi.fn(async () => {})
  renderWithStore(<Gallery />, 'sdxl', { images: [image(2), image(1)], deleteImage })
  await userEvent.click(deleteButtonOf(frame(2)))
  await userEvent.click(deleteButtonOf(frame(1)))
  expect(deleteImage).toHaveBeenCalledTimes(1)
  expect(deleteImage).toHaveBeenCalledWith(2)
  await act(async () => void vi.advanceTimersByTime(5100))
  expect(deleteImage).toHaveBeenLastCalledWith(1)
})

test('a pending deletion is committed when the gallery unmounts', async () => {
  const deleteImage = vi.fn(async () => {})
  const { unmount } = renderWithStore(<Gallery />, 'sdxl', { images: [image(2)], deleteImage })
  await userEvent.click(deleteButtonOf(frame(2)))
  unmount()
  expect(deleteImage).toHaveBeenCalledWith(2)
})

test('the end sentinel pages in older images and goes away when they run out', () => {
  let seen: IntersectionObserverCallback = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IntersectionObserverCallback) {
        seen = cb
      }
      observe(): void {}
      disconnect(): void {}
    },
  )
  const loadMoreImages = vi.fn(async () => {})
  const { store } = renderWithStore(<Gallery />, 'sdxl', { images: [image(2), image(1)], loadMoreImages })
  act(() => seen([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(loadMoreImages).not.toHaveBeenCalled()
  act(() => seen([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(loadMoreImages).toHaveBeenCalledTimes(1)
  act(() => store.setState({ imagesExhausted: true }))
  expect(document.querySelector('[class*="sentinel"]')).toBeNull()
})
