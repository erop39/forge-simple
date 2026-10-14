import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImageRecord } from '@shared/types'
import { frameCaption } from '../format'
import { en } from '../locales/en'
import { ImageTile } from './ImageTile'

const image = (over: Partial<ImageRecord> = {}): ImageRecord => ({
  id: 412, jobId: 1, url: 'fnc-img://local/a.png', thumbUrl: 'fnc-img://local/thumbs/a.jpg', width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: 1, durationMs: 41400, hidden: false, sourceImageId: null, ...over,
})

test('renders the thumbnail with the aspect ratio reserved and loading="lazy"', () => {
  const { container } = render(<ImageTile image={image()} onDelete={() => {}} />)
  const img = container.querySelector('img')!
  expect(img.getAttribute('src')).toBe('fnc-img://local/thumbs/a.jpg')
  expect(img.getAttribute('loading')).toBe('lazy')
  expect(img.getAttribute('decoding')).toBe('async')
  expect(img.getAttribute('alt')).toBe('')
  expect((container.firstElementChild as HTMLElement).style.aspectRatio).toBe('832 / 1216')
})

test('frame caption formats id, seconds and size', () => {
  render(<ImageTile image={image()} onDelete={() => {}} />)
  expect(screen.getByText('№ 0412 · 41 s · 832×1216')).toBeDefined()
  expect(screen.getByRole('group', { name: '№ 0412 · 41 s · 832×1216' })).toBeDefined()
})

test('the caption pads the id and omits the seconds when the duration is unknown', () => {
  expect(frameCaption(image({ id: 7, durationMs: 1600 }))).toBe('№ 0007 · 2 s · 832×1216')
  expect(frameCaption(image({ id: 12345, durationMs: null }))).toBe('№ 12345 · 832×1216')
})

test('the tile and its Delete button are reachable by keyboard; Delete reports the id', async () => {
  const onDelete = vi.fn()
  render(<ImageTile image={image()} onDelete={onDelete} />)
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('group'))
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['image.delete'] }))
  await userEvent.keyboard('{Enter}')
  expect(onDelete).toHaveBeenCalledWith(412)
})
