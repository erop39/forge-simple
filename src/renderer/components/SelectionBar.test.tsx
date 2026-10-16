import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImageRecord } from '@shared/types'
import { en } from '../locales/en'
import { ArchiveDialog } from './ArchiveDialog'
import { SelectionBar } from './SelectionBar'
import { renderWithStore } from './test-store'

const image = (id: number, over: Partial<ImageRecord> = {}): ImageRecord => ({
  id, jobId: id, url: `fnc-img://local/image/${id}`, thumbUrl: `fnc-img://local/thumb/${id}`, width: 64, height: 64,
  seed: id, infotext: '', createdAt: id, durationMs: 1, hidden: false, sourceImageId: null, tags: [], locked: false, ...over,
})

test('Archive names the folder, says hidden images are skipped, and reports what was archived', async () => {
  const archiveState = vi.fn(async () => ({ dir: 'D:/fnc-archives', archives: [] }))
  const createArchive = vi.fn(async () => ({ name: '2026-10-16-autumn', archived: 2, skippedHidden: 1, unreadable: 0, notRemoved: 0 }))
  renderWithStore(<><SelectionBar ids={[1, 2, 3]} onDelete={() => undefined} /><ArchiveDialog /></>, 'sdxl', {
    images: [image(1), image(2), image(3, { hidden: true })], archiveState, createArchive,
  })
  await userEvent.click(screen.getByRole('button', { name: en['selection.archive'] }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Archive 2 images')).toBeDefined()
  expect(within(dialog).getByText('1 hidden images are never archived and stay in the gallery.')).toBeDefined()
  expect(await within(dialog).findByText('D:/fnc-archives')).toBeDefined()
  await userEvent.type(within(dialog).getByRole('textbox'), 'Autumn')
  await userEvent.click(within(dialog).getByRole('button', { name: en['archive.confirm'] }))
  expect(createArchive).toHaveBeenCalledWith([1, 2, 3], 'Autumn')
  expect(await within(dialog).findByText('Archived 2 images to 2026-10-16-autumn.')).toBeDefined()
})

test('a refused archive shows the reason and keeps the dialog open', async () => {
  const createArchive = vi.fn(async () => { throw new Error('error.archiveNoSpace') })
  renderWithStore(<><SelectionBar ids={[1]} onDelete={() => undefined} /><ArchiveDialog /></>, 'sdxl', {
    images: [image(1)], archiveState: vi.fn(async () => ({ dir: 'D:/a', archives: [] })), createArchive,
  })
  await userEvent.click(screen.getByRole('button', { name: en['selection.archive'] }))
  await userEvent.click(await screen.findByRole('button', { name: en['archive.confirm'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.archiveNoSpace'])
})
