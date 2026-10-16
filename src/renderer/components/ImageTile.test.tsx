import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { en } from '../locales/en'
import { ImageTile } from './ImageTile'

const image = (over: Partial<ImageRecord> = {}): ImageRecord => ({
  id: 412, jobId: 1, url: 'fnc-img://local/a.png', thumbUrl: 'fnc-img://local/thumbs/a.jpg', width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: new Date().setHours(14, 3, 0, 0), durationMs: 41400, hidden: false, sourceImageId: null, tags: [], locked: false, ...over,
})

test('renders the thumbnail with the aspect ratio reserved and loading="lazy"', () => {
  const { container } = render(<ImageTile image={image()} onOpen={() => {}} onDelete={() => {}} onHires={() => {}} onToggleHidden={() => {}} onUnlock={() => {}} />)
  const img = container.querySelector('img')!
  expect(img.getAttribute('src')).toBe('fnc-img://local/thumbs/a.jpg')
  expect(img.getAttribute('loading')).toBe('lazy')
  expect(img.getAttribute('decoding')).toBe('async')
  expect(img.getAttribute('alt')).toBe('')
  expect((container.firstElementChild as HTMLElement).style.aspectRatio).toBe('832 / 1216')
})

test("frame caption formats id, seconds, size and today's generation time", () => {
  render(<ImageTile image={image()} onOpen={() => {}} onDelete={() => {}} onHires={() => {}} onToggleHidden={() => {}} onUnlock={() => {}} />)
  expect(screen.getByText('№ 0412 · 41 s · 832×1216 · 14:03')).toBeDefined()
  expect(screen.getByRole('group', { name: '№ 0412 · 41 s · 832×1216 · 14:03' })).toBeDefined()
})

test('the caption pads the id and omits the seconds when the duration is unknown', () => {
  expect(frameCaption(image({ id: 7, durationMs: 1600 }))).toBe('№ 0007 · 2 s · 832×1216 · 14:03')
  expect(frameCaption(image({ id: 12345, durationMs: null }))).toBe('№ 12345 · 832×1216 · 14:03')
})

test('the image opens by keyboard; Hide and Delete remain separate', async () => {
  const onOpen = vi.fn()
  const onDelete = vi.fn()
  render(<ImageTile image={image()} onOpen={onOpen} onDelete={onDelete} onHires={() => {}} onToggleHidden={() => {}} onUnlock={() => {}} />)
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open image 412' }))
  await userEvent.keyboard('{Enter}')
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 412 }), document.activeElement)
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['image.hires'] }))
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['image.hide'] }))
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['image.delete'] }))
  await userEvent.keyboard('{Enter}')
  expect(onDelete).toHaveBeenCalledWith(412)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

test('a locked tile keeps its size but shows no picture; its button asks to unlock', async () => {
  const onUnlock = vi.fn()
  const onOpen = vi.fn()
  const { container } = render(
    <ImageTile
      image={image({ hidden: true, locked: true, url: '', thumbUrl: '' })}
      onOpen={onOpen} onDelete={() => {}} onHires={() => {}} onToggleHidden={() => {}} onUnlock={onUnlock}
    />,
  )
  expect(container.querySelector('img')).toBeNull()
  expect((container.firstElementChild as HTMLElement).style.aspectRatio).toBe('832 / 1216')
  expect(screen.queryByRole('button', { name: en['image.delete'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['image.unhide'] })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Hidden image 412. Unlock to view' }))
  expect(onUnlock).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Hidden image 412. Unlock to view' }))
  expect(onOpen).not.toHaveBeenCalled()
})

test('a hidden image shown while unlocked carries the Hidden label and offers Unhide', async () => {
  const onToggleHidden = vi.fn()
  render(<ImageTile image={image({ hidden: true })} onOpen={() => {}} onDelete={() => {}} onHires={() => {}} onToggleHidden={onToggleHidden} onUnlock={() => {}} />)
  expect(screen.getByText(en['image.hiddenBadge'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['image.unhide'] }))
  expect(onToggleHidden).toHaveBeenCalledWith(expect.objectContaining({ id: 412, hidden: true }))
})

test('H on a focused tile hides it; with a modifier it does nothing', async () => {
  const onToggleHidden = vi.fn()
  render(<ImageTile image={image()} onOpen={() => {}} onDelete={() => {}} onHires={() => {}} onToggleHidden={onToggleHidden} onUnlock={() => {}} />)
  expect(screen.queryByText(en['image.hiddenBadge'])).toBeNull()
  await userEvent.tab()
  await userEvent.keyboard('{Control>}h{/Control}')
  expect(onToggleHidden).not.toHaveBeenCalled()
  await userEvent.keyboard('h')
  expect(onToggleHidden).toHaveBeenCalledWith(expect.objectContaining({ id: 412, hidden: false }))
  await userEvent.click(screen.getByRole('button', { name: en['image.hide'] }))
  expect(onToggleHidden).toHaveBeenCalledTimes(2)
})

test('an enhanced image shows the HD mark and the hires action reports the image', async () => {
  const onHires = vi.fn()
  render(<ImageTile image={image({ enhanced: true })} onOpen={() => {}} onDelete={() => {}} onHires={onHires} onToggleHidden={() => {}} onUnlock={() => {}} />)
  expect(screen.getByText(en['image.hd'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['image.hires'] }))
  expect(onHires).toHaveBeenCalledWith(412)
})

test('a plain image has no HD mark', () => {
  render(<ImageTile image={image()} onOpen={() => {}} onDelete={() => {}} onHires={() => {}} onToggleHidden={() => {}} onUnlock={() => {}} />)
  expect(screen.queryByText(en['image.hd'])).toBeNull()
})

test('Ctrl+click, Shift+click and Space pick the image instead of opening it; a plain click opens; a picked tile shows a check', async () => {
  const onOpen = vi.fn()
  const onSelect = vi.fn()
  const { rerender, container } = render(<ImageTile image={image()} onOpen={onOpen} onDelete={() => {}} onHires={() => {}} onSelect={onSelect} onToggleHidden={() => {}} onUnlock={() => {}} />)
  const open = screen.getByRole('button', { name: 'Open image 412' })
  fireEvent.click(open, { ctrlKey: true })
  fireEvent.click(open, { shiftKey: true })
  expect(onSelect.mock.calls.map((c) => c[1])).toEqual(['add', 'range'])
  expect(onOpen).not.toHaveBeenCalled()
  open.focus()
  await userEvent.keyboard(' ')
  expect(onSelect).toHaveBeenCalledTimes(3)
  expect(onOpen).not.toHaveBeenCalled()
  await userEvent.click(open)
  expect(onOpen).toHaveBeenCalledOnce()
  expect(container.querySelector('svg[weight="bold"]')).toBeNull()
  rerender(<ImageTile image={image()} onOpen={onOpen} onDelete={() => {}} onHires={() => {}} onSelect={onSelect} selected onToggleHidden={() => {}} onUnlock={() => {}} />)
  expect(screen.getByRole('button', { name: 'Open image 412' }).getAttribute('aria-pressed')).toBe('true')
})
