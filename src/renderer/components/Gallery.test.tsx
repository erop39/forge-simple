import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultParams } from '@shared/profiles'
import type { ImageRecord, Job } from '@shared/types'
import { en } from '../locales/en'
import { frameCaption, fullTime } from '../format'
import { lockedCopy } from '../state/store'
import { Gallery, columnCountFor } from './Gallery'
import { catalog, renderWithStore } from './test-store'

// Records the image each render of the viewer gets (the viewer itself still renders).
const viewerRenders = vi.hoisted(() => [] as (number | null)[])
vi.mock('./ImageViewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ImageViewer')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    ImageViewer: (props: Parameters<typeof actual.ImageViewer>[0]) => {
      viewerRenders.push(props.image?.id ?? null)
      return createElement(actual.ImageViewer, props)
    },
  }
})

const params = defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })
const job = (id: number, status: Job['status']): Job => ({
  id, serverId: 1, type: 'txt2img', status, params, error: null,
  createdAt: id, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
})
const image = (id: number): ImageRecord => ({
  id, jobId: id, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/t${id}.jpg`, width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: id, durationMs: 41000, hidden: false, sourceImageId: null, tags: [], locked: false,
})
const frame = (id: number) => frameCaption(image(id))

/** The Delete button inside the tile with the given caption. */
function deleteButtonOf(caption: string): HTMLElement {
  return screen.getByRole('group', { name: caption }).querySelector('button[aria-label="Delete"]') as HTMLElement
}

/** Makes the gallery measure `width` × `height`; the returned function resizes it. */
function sizeGallery(width: number, height: number): (width: number, height: number) => void {
  const callbacks: ResizeObserverCallback[] = []
  const size = { width, height }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: ResizeObserverCallback) {
        callbacks.push(cb)
      }
      observe(): void {
        this.cb([{ contentRect: { ...size } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect(): void {}
    },
  )
  return (w, h) => {
    size.width = w
    size.height = h
    for (const cb of callbacks) cb([{ contentRect: { ...size } } as ResizeObserverEntry], {} as ResizeObserver)
  }
}

const scroller = () => document.querySelector('[class*="gallery"]') as HTMLElement
const cellCount = () => document.querySelectorAll('[data-key]').length
const columnsInUse = () =>
  new Set([...document.querySelectorAll('[data-column]')].map((c) => c.getAttribute('data-column'))).size

/** Scrolls the gallery to `top` (jsdom does not scroll by itself). */
function scrollTo(top: number): void {
  const el = scroller()
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top })
  fireEvent.scroll(el)
}

/** `count` images, newest first. */
const many = (count: number) => Array.from({ length: count }, (_, i) => image(count - i))

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
  const notify = sizeGallery(400, 700)
  renderWithStore(<Gallery />, 'sdxl', { images: [image(4), image(3), image(2), image(1)] })
  expect(columnsInUse()).toBe(2)
  act(() => notify(1000, 700))
  expect(columnsInUse()).toBe(4)
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
  sizeGallery(452, 700)
  renderWithStore(<Gallery />, 'sdxl', {
    jobs: { 9: job(9, 'running') },
    images: [image(1), image(2)],
  })
  const columns = [0, 1].map((c) =>
    [...document.querySelectorAll(`[data-column="${c}"]`)].map((cell) => {
      const tile = cell.firstElementChild as HTMLElement
      return tile.dataset['status'] ?? tile.getAttribute('aria-label')
    }),
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

test('a queued job of a server that is not active shows "Waiting for <name>"', () => {
  const servers = [
    { id: 1, name: 'Home', url: 'http://home.test', active: true },
    { id: 2, name: 'Studio', url: 'http://studio.test', active: false },
  ]
  const jobs = { 1: job(1, 'queued'), 2: { ...job(2, 'queued'), serverId: 2 } }
  renderWithStore(<Gallery />, 'sdxl', { servers, jobs })
  expect(screen.getByText('queued · 1')).toBeDefined()
  expect(screen.getByText('Waiting for Studio')).toBeDefined()
})

test('clicking an image opens the full file, saved settings and Copy prompt; Escape returns focus', async () => {
  const copy = vi.fn(async () => {})
  const details = vi.fn(async () => ({ image: image(7), params: { ...params, prompt: 'evening light', scheduler: 'Karras' }, jobType: 'txt2img' }))
  vi.stubGlobal('api', { images: { details }, clipboard: { writeText: copy } })
  renderWithStore(<Gallery />, 'sdxl', { images: [image(7)] })
  const trigger = screen.getByRole('button', { name: 'Open image 7' })
  await userEvent.click(trigger)
  expect(details).toHaveBeenCalledWith(7)
  expect(screen.getByRole('img', { name: 'Generated image 7' }).getAttribute('src')).toBe(image(7).url)
  await waitFor(() => expect(screen.getByText('evening light')).toBeDefined())
  expect(screen.getByText('Karras')).toBeDefined()
  expect(screen.getByText(en['viewer.created']).nextElementSibling?.textContent).toBe(fullTime(image(7).createdAt))
  await userEvent.click(screen.getByRole('button', { name: en['viewer.copyPrompt'] }))
  expect(copy).toHaveBeenCalledWith('evening light')
  expect(screen.getByRole('button', { name: en['viewer.copied'] })).toBeDefined()
  expect(screen.getByRole('button', { name: en['viewer.close'] }).querySelector('svg')).not.toBeNull()
  await userEvent.click(screen.getByRole('button', { name: en['viewer.close'] }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await userEvent.click(trigger)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('Send to img2img from the viewer attaches the image and closes with keyboard activation', async () => {
  vi.stubGlobal('api', { images: { details: vi.fn(async () => ({ image: image(7), params, jobType: 'txt2img' })) } })
  const { store } = renderWithStore(<Gallery />, 'sdxl', { images: [image(7)] })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  const send = await screen.findByRole('button', { name: en['img2img.send'] })
  send.focus()
  await userEvent.keyboard('{Enter}')
  expect(store.getState().params?.img2img?.sourceImageId).toBe(7)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a saved image can be dragged to the prompt bar by its ID', () => {
  renderWithStore(<Gallery />, 'sdxl', { images: [image(7)] })
  const transfer = { setData: vi.fn() }
  fireEvent.dragStart(screen.getByRole('button', { name: 'Open image 7' }), { dataTransfer: transfer })
  expect(transfer.setData).toHaveBeenCalledWith('application/x-forge-neo-image-id', '7')
})

test('viewer queues an upscale with a keyboard-activated action', async () => {
  vi.stubGlobal('api', { images: { details: vi.fn(async () => ({ image: image(7), params, jobType: 'txt2img' })) } })
  const queue = vi.fn(async () => true)
  const saveDefault = vi.fn(async () => true)
  renderWithStore(<Gallery />, 'sdxl', { images: [image(7)], upscaleImage: queue, setDefaultUpscaler: saveDefault,
    catalog: { ...catalog, upscalers: ['Latent', 'R-ESRGAN 4x+'] },
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', upscalers: { hires: null, finished: 'R-ESRGAN 4x+' } },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  const action = await screen.findByRole('button', { name: en['viewer.upscale'] })
  action.focus()
  await userEvent.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: en['viewer.upscaleQueue'] })).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['viewer.saveUpscalerDefault'] }))
  expect(saveDefault).toHaveBeenCalledWith('finished', 'R-ESRGAN 4x+')
  await userEvent.click(screen.getByRole('button', { name: en['viewer.upscaleQueue'] }))
  expect(queue).toHaveBeenCalledWith(7, params, 'R-ESRGAN 4x+', 2)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('before/after comparison hides a hidden source as soon as the lock closes', async () => {
  const result = { ...image(7), sourceImageId: 6 }
  const source = { ...image(6), hidden: true }
  vi.stubGlobal('api', { images: { details: vi.fn(async (id: number) => ({ image: id === 7 ? result : source, params,
    jobType: id === 7 ? 'upscale' : 'txt2img' })) } })
  const { store } = renderWithStore(<Gallery />, 'sdxl', { images: [result, source],
    lock: { hasPassword: true, open: true }, imagesExhausted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  const slider = await screen.findByRole('slider', { name: en['viewer.compare'] })
  expect(slider).toBeDefined()
  const beforeImage = screen.getByRole('img', { name: en['viewer.before'] }) as HTMLImageElement
  fireEvent.change(slider, { target: { value: '25' } })
  expect(beforeImage.style.clipPath).toBe('inset(0 75% 0 0)')
  slider.focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(screen.getByRole('slider', { name: en['viewer.compare'] })).toBe(slider)
  act(() => store.setState({ lock: { hasPassword: true, open: false } }))
  expect(screen.queryByRole('img', { name: en['viewer.before'] })).toBeNull()
  expect(screen.queryByRole('slider', { name: en['viewer.compare'] })).toBeNull()
})

test('viewer shows the saved hires settings for a finished image', async () => {
  vi.stubGlobal('api', {
    images: { details: vi.fn(async () => ({
      image: image(7),
      params: { ...params, hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } },
      jobType: 'txt2img',
    })) },
  })
  renderWithStore(<Gallery />, 'sdxl', { images: [image(7)] })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  await waitFor(() => expect(screen.getByText(en['params.hires']).nextElementSibling?.textContent).toBe(en['params.hires2']))
  expect(screen.getByText(en['params.hiresUpscaler']).nextElementSibling?.textContent).toBe('Latent')
  expect(screen.getByText(en['params.hiresSteps']).nextElementSibling?.textContent).toBe('12')
})

test('a copy that settles after moving to another image does not mark that image as copied', async () => {
  let finish!: () => void
  const copy = vi.fn(() => new Promise<void>((r) => { finish = r }))
  vi.stubGlobal('api', {
    images: { details: vi.fn(async (id: number) => ({ image: image(id), params: { ...params, prompt: `prompt ${id}` }, jobType: 'txt2img' })) },
    clipboard: { writeText: copy },
  })
  renderWithStore(<Gallery />, 'sdxl', { images: [image(9), image(7)], imagesExhausted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 9' }))
  await waitFor(() => expect(screen.getByText('prompt 9')).toBeDefined())
  await userEvent.click(screen.getByRole('button', { name: en['viewer.copyPrompt'] }))
  await userEvent.keyboard('{ArrowRight}')
  await waitFor(() => expect(screen.getByText('prompt 7')).toBeDefined())
  await act(async () => { finish() })
  expect(screen.queryByRole('button', { name: en['viewer.copied'] })).toBeNull()
  expect(screen.getByRole('button', { name: en['viewer.copyPrompt'] })).toBeDefined()
})

test('viewer arrows and keyboard follow the gallery order and stop at the ends', async () => {
  vi.stubGlobal('api', {
    images: { details: vi.fn(async (id: number) => ({ image: image(id), params: { ...params, prompt: `prompt ${id}` }, jobType: 'txt2img' })) },
    clipboard: { writeText: vi.fn(async () => {}) },
  })
  renderWithStore(<Gallery />, 'sdxl', { images: [image(9), image(7), image(3)], imagesExhausted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  await waitFor(() => expect(screen.getByText('prompt 7')).toBeDefined())
  expect(screen.getByText('2 / 3')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['viewer.previous'] }))
  await waitFor(() => expect(screen.getByRole('img', { name: 'Generated image 9' })).toBeDefined())
  expect((screen.getByRole('button', { name: en['viewer.previous'] }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByRole('img', { name: 'Generated image 7' })).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['viewer.next'] }))
  expect(screen.getByRole('img', { name: 'Generated image 3' })).toBeDefined()
  expect((screen.getByRole('button', { name: en['viewer.next'] }) as HTMLButtonElement).disabled).toBe(true)
})

test('Next loads the next gallery page when the oldest loaded image is open', async () => {
  vi.stubGlobal('api', {
    images: { details: vi.fn(async (id: number) => ({ image: image(id), params: { ...params, prompt: `prompt ${id}` }, jobType: 'txt2img' })) },
    clipboard: { writeText: vi.fn(async () => {}) },
  })
  let appendOlder = () => {}
  const loadMoreImages = vi.fn(async () => appendOlder())
  const { store } = renderWithStore(<Gallery />, 'sdxl', {
    images: [image(4), image(3)], imagesExhausted: false, loadMoreImages,
  })
  appendOlder = () => store.setState({ images: [image(4), image(3), image(2)], imagesExhausted: true })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 3' }))
  // Two short images are near the end, so the gallery already asked once (and got nothing) on mount.
  const before = loadMoreImages.mock.calls.length
  await userEvent.click(screen.getByRole('button', { name: en['viewer.next'] }))
  expect(loadMoreImages).toHaveBeenCalledTimes(before + 1)
  await waitFor(() => expect(screen.getByRole('img', { name: 'Generated image 2' })).toBeDefined())
  expect((screen.getByRole('button', { name: en['viewer.next'] }) as HTMLButtonElement).disabled).toBe(true)
})

test('a view request from elsewhere (the activity log) opens that image and is cleared', async () => {
  const details = vi.fn(async () => ({ image: image(7), params, jobType: 'txt2img' }))
  vi.stubGlobal('api', { images: { details }, clipboard: { writeText: vi.fn() } })
  const { store } = renderWithStore(<Gallery />, 'sdxl', { images: [image(8), image(7)], viewRequest: 7 })
  expect(await screen.findByRole('img', { name: 'Generated image 7' })).toBeDefined()
  expect(store.getState().viewRequest).toBeNull()
})

test('the viewer of a hidden image disappears in the same render when the lock closes', async () => {
  const shown = { ...image(7), hidden: true }
  vi.stubGlobal('api', {
    images: { details: vi.fn(async () => ({ image: shown, params: { ...params, prompt: 'secret prompt' }, jobType: 'txt2img' })) },
    clipboard: { writeText: vi.fn() },
  })
  const { store } = renderWithStore(<Gallery />, 'sdxl', { images: [shown] })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  await waitFor(() => expect(screen.getByText('secret prompt')).toBeDefined())
  viewerRenders.length = 0
  act(() => store.setState({ images: [lockedCopy(shown)] }))
  // No render after the update hands the viewer the hidden image, not even one before the state catches up.
  expect(viewerRenders).not.toContain(7)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('secret prompt')).toBeNull()
  expect(document.querySelector(`img[src="${shown.url}"]`)).toBeNull()
  expect(screen.getByRole('button', { name: 'Hidden image 7. Unlock to view' })).toBeDefined()
})

describe('virtualization', () => {
  // 900 px: 3 columns of 296 px; an 832×1216 tile is 432.6 px tall plus a 6 px gap.
  const ROW = (296 * 1216) / 832 + 6

  test('only the tiles within a screen above and below the view are in the DOM', () => {
    sizeGallery(900, 600)
    renderWithStore(<Gallery />, 'sdxl', { images: many(300), imagesExhausted: true })
    const fitsInThreeScreens = (Math.ceil((3 * 600) / ROW) + 1) * 3
    expect(cellCount()).toBeGreaterThan(0)
    expect(cellCount()).toBeLessThanOrEqual(fitsInThreeScreens)
    expect(screen.getByRole('group', { name: frame(300) })).toBeDefined()
    scrollTo(20 * ROW)
    // One more: the tile holding the gallery's tab stop stays rendered wherever it is.
    expect(cellCount()).toBeLessThanOrEqual(fitsInThreeScreens + 1)
    expect(screen.getByRole('group', { name: frame(300 - 60) })).toBeDefined()
    expect(screen.queryByRole('group', { name: frame(299) })).toBeNull()
    // The canvas keeps the full height, so the scroll bar covers every loaded image.
    const canvas = scroller().firstElementChild as HTMLElement
    expect(parseFloat(canvas.style.height)).toBeCloseTo(100 * ROW - 6, 0)
  })

  test('the next page loads when the rendered band nears the end; a failed page retries on the next scroll', async () => {
    sizeGallery(900, 600)
    const loadMoreImages = vi.fn(async () => {}) // brings nothing, like a page that failed
    renderWithStore(<Gallery />, 'sdxl', { images: many(30), imagesExhausted: false, loadMoreImages })
    // 10 rows: the band ends at 1200 px, far from the end.
    expect(loadMoreImages).not.toHaveBeenCalled()
    scrollTo(10 * ROW - 2400)
    expect(loadMoreImages).not.toHaveBeenCalled()
    // The band now ends less than a screen (600 px) before the end.
    scrollTo(10 * ROW - 1700)
    expect(loadMoreImages).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(loadMoreImages).toHaveBeenCalledTimes(1)
    scrollTo(10 * ROW - 1690)
    expect(loadMoreImages).toHaveBeenCalledTimes(2)
  })

  test('nothing more is asked for once the images ran out', () => {
    sizeGallery(900, 600)
    const loadMoreImages = vi.fn(async () => {})
    renderWithStore(<Gallery />, 'sdxl', { images: many(6), imagesExhausted: true, loadMoreImages })
    scrollTo(100)
    expect(loadMoreImages).not.toHaveBeenCalled()
  })
})

describe('keyboard', () => {
  const tabStops = () =>
    [...document.querySelectorAll<HTMLElement>('[data-key] [data-primary]')].filter((el) => el.tabIndex === 0)
  const openButton = (id: number) => screen.getByRole('button', { name: `Open image ${id}` })

  test("the gallery is one tab stop; the focused tile's buttons follow it, then the focus leaves", async () => {
    sizeGallery(900, 600)
    renderWithStore(
      <>
        <button type="button">before</button>
        <Gallery />
        <button type="button">after</button>
      </>,
      'sdxl',
      { images: many(9), imagesExhausted: true },
    )
    expect(tabStops()).toHaveLength(1)
    screen.getByRole('button', { name: 'before' }).focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(openButton(9))
    await userEvent.tab()
    const tile = screen.getByRole('group', { name: frame(9) })
    expect(document.activeElement).toBe(tile.querySelector(`[aria-label="${en['image.hide']}"]`))
    await userEvent.tab()
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  test('arrows move the focus to the nearest tile in that direction; Home and End go to the ends', async () => {
    sizeGallery(900, 600)
    // 3 equal columns: 9 8 7 / 6 5 4 / 3 2 1.
    renderWithStore(<Gallery />, 'sdxl', { images: many(9), imagesExhausted: true })
    openButton(9).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(openButton(8))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(openButton(5))
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(openButton(6))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(openButton(9))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(openButton(9))
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(openButton(1))
    expect(tabStops()).toEqual([openButton(1)])
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(openButton(9))
  })

  test('focus moved by keyboard scrolls the tile into view, even one outside the rendered band', async () => {
    sizeGallery(900, 600)
    const scrolled: string[] = []
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset['key'] ?? '')
    })
    renderWithStore(<Gallery />, 'sdxl', { images: many(300), imagesExhausted: true })
    openButton(300).focus()
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(openButton(1))
    expect(scrolled).toContain('image:1')
    spy.mockRestore()
  })

  test('Delete on a focused tile deletes it with Undo and moves the focus to the next tile', async () => {
    sizeGallery(900, 600)
    const deleteImage = vi.fn(async () => {})
    renderWithStore(<Gallery />, 'sdxl', { images: many(3), imagesExhausted: true, deleteImage })
    openButton(3).focus()
    await userEvent.keyboard('{Delete}')
    expect(screen.queryByRole('group', { name: frame(3) })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(en['image.deleted'])
    expect(document.activeElement).toBe(openButton(2))
    await userEvent.click(screen.getByRole('button', { name: en['image.undo'] }))
    expect(screen.getByRole('group', { name: frame(3) })).toBeDefined()
    expect(deleteImage).not.toHaveBeenCalled()
  })
})

describe('reveal', () => {
  const PREVIEW = 'data:image/png;base64,cHJldmlldw=='
  const running = {
    jobs: { 5: job(5, 'running') },
    progress: { 5: { jobId: 5, step: 7, totalSteps: 8, stage: 'sampling' as const, stepsPerSec: 2, elapsedMs: 3000, preview: PREVIEW } },
    images: [image(1)],
    imagesExhausted: true,
  }
  /** The runner sends the image first, then the job's end. */
  const arrive = (store: ReturnType<typeof renderWithStore>['store']) => {
    act(() => store.setState({ images: [{ ...image(6), jobId: 5 }, image(1)] }))
    act(() => store.setState({ jobs: {}, progress: {} }))
  }

  test('the finished image fades in over the last preview, which goes when the fade is over', () => {
    vi.useFakeTimers()
    sizeGallery(900, 600)
    const { store } = renderWithStore(<Gallery />, 'sdxl', running)
    arrive(store)
    const tile = screen.getByRole('group', { name: frame(6) })
    const thumb = tile.querySelector(`img[src="${image(6).thumbUrl}"]`) as HTMLImageElement
    expect(tile.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull()
    expect(thumb.className).toMatch(/reveal/)
    fireEvent.load(thumb)
    act(() => void vi.advanceTimersByTime(250))
    expect(tile.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull()
    act(() => void vi.advanceTimersByTime(20))
    expect(tile.querySelector(`img[src="${PREVIEW}"]`)).toBeNull()
    expect(thumb.className).not.toMatch(/reveal/)
    // An image of an earlier session (no preview seen) shows without a fade.
    expect(screen.getByRole('group', { name: frame(1) }).querySelector('img')!.className).not.toMatch(/reveal/)
  })

  test('with reduced motion the image replaces the preview at once', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
    sizeGallery(900, 600)
    const { store } = renderWithStore(<Gallery />, 'sdxl', running)
    arrive(store)
    const tile = screen.getByRole('group', { name: frame(6) })
    expect(tile.querySelector(`img[src="${PREVIEW}"]`)).toBeNull()
    expect(tile.querySelector('img')!.className).not.toMatch(/reveal/)
  })
})

test('viewer explains why Upscale is unavailable for an image already at the size limit', async () => {
  vi.stubGlobal('api', { images: { details: vi.fn(async () => ({ image: { ...image(7), width: 3000, height: 3000 }, params, jobType: 'txt2img' })) } })
  renderWithStore(<Gallery />, 'sdxl', { images: [{ ...image(7), width: 3000, height: 3000 }],
    catalog: { ...catalog, upscalers: ['Latent'] } })
  await userEvent.click(screen.getByRole('button', { name: 'Open image 7' }))
  const action = await screen.findByRole('button', { name: en['viewer.upscale'] })
  expect((action as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(en['viewer.upscaleLimit'])).toBeDefined()
})
